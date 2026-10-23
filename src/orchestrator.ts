// orchestrator.ts – Central state machine controller

import * as vscode from 'vscode';
import { LlmClient, LlmMessage } from './llm';
import { parseTags, findTag, findAllTags, findChildTags, ParsedTag } from './parser';
import { validatePlan, validateAsk, validateBuildChat, validateAllowedTags, truncateSay } from './validators';
import { executeActions } from './executor';
import { StateManager, ModuleState } from './state';
import { ThreadManager, LFComment } from './threads';
import { readConfig, LogicForgeConfig } from './config';
import { computeBudget, BudgetConfig } from './budget';
import { normalizeConcept, isConceptKnown, evaluateQuiz, parseQuizAnswer } from './quiz';
import { assembleContext, getAnchorContext, ContextParts } from './context';
import { getSystemPrompt, getPlanPrompt, getAskPrompt, getLearningCheckPrompt, getBuildPrompt, getChatPrompt } from './prompts';
import { normalizeSeparators } from './sandbox';
import { StatusBar } from './status';
import { LogicForgeTreeProvider } from './tree';

export class Orchestrator {
  private llmClient: LlmClient;
  private stateManager: StateManager;
  private threadManager: ThreadManager;
  private statusBar: StatusBar;
  private treeProvider: LogicForgeTreeProvider;
  private workspaceContext: vscode.ExtensionContext;
  private wsRoot: vscode.Uri;
  private busy = false;
  private abortController: AbortController | null = null;
  private firstMessage = true;

  constructor(
    llmClient: LlmClient,
    stateManager: StateManager,
    threadManager: ThreadManager,
    statusBar: StatusBar,
    treeProvider: LogicForgeTreeProvider,
    workspaceContext: vscode.ExtensionContext,
    wsRoot: vscode.Uri
  ) {
    this.llmClient = llmClient;
    this.stateManager = stateManager;
    this.threadManager = threadManager;
    this.statusBar = statusBar;
    this.treeProvider = treeProvider;
    this.workspaceContext = workspaceContext;
    this.wsRoot = wsRoot;
  }

  setLlmClient(client: LlmClient): void {
    this.llmClient = client;
  }

  getLlmClient(): LlmClient {
    return this.llmClient;
  }

  isBusy(): boolean {
    return this.busy;
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private getConfig(): LogicForgeConfig {
    return readConfig();
  }

  private getBudget(): BudgetConfig {
    const config = this.getConfig();
    return computeBudget(config.mode, config.timeBudgetHours);
  }

  private updateStatusBar(busy: boolean = false): void {
    const config = this.getConfig();
    this.statusBar.update(config.mode, config.timeBudgetHours, config.demoMode, busy);
  }

  /**
   * Handle a reply from the user in a thread.
   */
  async handleReply(reply: { text: string; thread: vscode.CommentThread }): Promise<void> {
    if (this.busy) {
      vscode.window.showWarningMessage('LogicForge is busy. Please wait for the current request to finish.');
      return;
    }

    const config = this.getConfig();
    const text = this.stripMention(reply.text, config.agentName);

    // Add user comment
    const userComment = new LFComment(text, 'user', config.agentName);
    this.threadManager.addComment(reply.thread, userComment);

    // Check for quiz answer first
    const pendingQuiz = this.threadManager.findPendingQuiz(reply.thread);
    if (pendingQuiz && pendingQuiz.quizId) {
      const quizAnswer = parseQuizAnswer(text);
      if (quizAnswer) {
        await this.handleQuizAnswer(reply.thread, pendingQuiz, quizAnswer);
        return;
      }
    }

    // Route the message
    const hasPlan = Boolean(this.stateManager.getState().plan);
    const naturalBuildRequest = /^(?:please\s+)?(?:(?:(?:help|assist)\s+me\s+to|(?:can|could|would)\s+you|i(?:'d| would| want) to)\s+)?(?:build|create|make|develop|implement|design|start)\b/i.test(text.trim());
    if (text.startsWith('/plan ')) {
      const brief = text.substring(6).trim();
      await this.runPlan(reply.thread, brief);
    } else if (!hasPlan && naturalBuildRequest) {
      await this.runPlan(reply.thread, text.trim());
    } else if (text.trim() === '/next') {
      await this.runNext(reply.thread);
    } else {
      await this.runChat(reply.thread, text);
    }
  }

  /**
   * Run the PLAN state.
   */
  async runPlan(thread: vscode.CommentThread, brief: string): Promise<void> {
    const config = this.getConfig();
    const budget = this.getBudget();
    let openingDecisionModule: ModuleState | undefined;

    await this.withBusy(thread, async (signal) => {
      const context = await this.buildContext(thread);
      const messages: LlmMessage[] = [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: context + '\n\n' + getPlanPrompt(brief, budget.maxQuizzes) },
      ];

      const result = await this.llmCall(messages, signal, 'PLAN');
      if (!result) return;

      const { tags } = result;
      const planTag = findTag(tags, 'plan');
      if (!planTag) return;

      const modules: ModuleState[] = findChildTags(planTag, 'module').map(m => ({
        id: m.attrs.id,
        title: m.attrs.title,
        goal: m.attrs.goal,
        decision: m.attrs.decision || 'false',
        concept: m.attrs.concept || '',
        status: 'todo' as const,
      }));

      // Guarantee one useful learner checkpoint before the first module is built.
      if (budget.maxQuizzes > 0 && modules.length > 0) {
        const firstModule = modules[0];
        firstModule.decision = 'true';
        firstModule.concept = firstModule.concept.trim() || 'core project design';
        if (!firstModule.goal.toLowerCase().includes('decision checkpoint')) {
          firstModule.goal += ' First clarify the main project-specific design decision before implementation.';
        }
        openingDecisionModule = firstModule;
      }

      // Update state
      this.stateManager.updateState({
        project: { name: planTag.attrs.name, brief },
        plan: {
          name: planTag.attrs.name,
          summary: planTag.attrs.summary,
          modules,
        },
        currentModuleIndex: 0,
        quizzesAsked: 0,
      });

      // Post plan as a numbered list
      const sayTag = findTag(tags, 'say');
      const sayText = sayTag ? truncateSay(sayTag.body.trim(), budget.explanationLength) : '';

      let planText = sayText ? sayText + '\n\n' : '';
      planText += `**${planTag.attrs.name}**\n${planTag.attrs.summary}\n\n`;
      modules.forEach((m, i) => {
        const decision = m.decision === 'true' ? ' 🔑' : '';
        planText += `${i + 1}. **${m.title}**${decision} - ${m.goal}\n`;
      });

      const agentComment = new LFComment(planText, 'agent', config.agentName);
      this.threadManager.addComment(thread, agentComment);

      // Demo mode first message indicator
      if (config.demoMode && this.firstMessage) {
        this.firstMessage = false;
        const demoNote = new LFComment('(Demo mode: scripted responses)', 'agent', config.agentName);
        this.threadManager.addComment(thread, demoNote);
      }

      this.treeProvider.refresh();
    });

    // Ask proactively as soon as the plan is visible, before any code is built.
    if (openingDecisionModule) {
      await this.runAsk(thread, openingDecisionModule);
    }
  }

  /**
   * Run NEXT state: advance to next module.
   */
  async runNext(thread: vscode.CommentThread): Promise<void> {
    const state = this.stateManager.getState();
    const config = this.getConfig();
    const budget = this.getBudget();

    if (!state.plan) {
      const msg = new LFComment('No plan yet. Use `/plan <brief>` to create one.', 'agent', config.agentName);
      this.threadManager.addComment(thread, msg);
      return;
    }

    const modules = state.plan.modules;
    const nextIdx = modules.findIndex(m => m.status === 'todo');
    if (nextIdx === -1) {
      const msg = new LFComment('All modules done. Run Checkpoint to condense conversations.', 'agent', config.agentName);
      this.threadManager.addComment(thread, msg);
      return;
    }

    const module = modules[nextIdx];
    this.stateManager.updateState({ currentModuleIndex: nextIdx });

    // Decide: ASK or BUILD
    const shouldAsk = config.mode !== 'sprint' &&
      module.decision === 'true' &&
      module.concept &&
      !isConceptKnown(module.concept, state.knownConcepts) &&
      state.quizzesAsked < budget.maxQuizzes;

    if (shouldAsk) {
      await this.runAsk(thread, module);
    } else {
      await this.runBuild(thread, module, '');
    }
  }

  /**
   * Run ASK state.
   */
  private async runAsk(thread: vscode.CommentThread, module: ModuleState, kind: 'decision' | 'learning-check' = 'decision'): Promise<void> {
    const config = this.getConfig();
    const budget = this.getBudget();
    const state = this.stateManager.getState();

    await this.withBusy(thread, async (signal) => {
      const context = await this.buildContext(thread);
      const messages: LlmMessage[] = [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: context + '\n\n' + (kind === 'learning-check'
          ? getLearningCheckPrompt(module.title, module.goal)
          : getAskPrompt(module.title, module.goal)) },
      ];

      const result = await this.llmCall(messages, signal, 'ASK');
      if (!result) return;

      const { tags } = result;
      const sayTag = findTag(tags, 'say');
      const askTag = findTag(tags, 'ask');
      if (!askTag) return;

      const q = findTag(askTag.children, 'q');
      const opts = findChildTags(askTag, 'opt');
      const correct = findTag(askTag.children, 'correct');
      const why = findTag(askTag.children, 'why');
      if (!q || opts.length !== 3 || !correct || !why) return;

      const quizId = `quiz-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

      // Post say text
      if (sayTag) {
        const sayText = truncateSay(sayTag.body.trim(), budget.explanationLength);
        const sayComment = new LFComment(sayText, 'agent', config.agentName);
        this.threadManager.addComment(thread, sayComment);
      }

      // Post quiz
      let quizText = `**${q.body.trim()}**\n\n`;
      for (const opt of opts) {
        quizText += `**${opt.attrs.id})** ${opt.body.trim()}\n`;
      }

      const quizComment = new LFComment(quizText, 'agent', config.agentName, quizId, 'quiz-pending');
      this.threadManager.addComment(thread, quizComment);

      // Store pending quiz in workspaceState
      const pendingRecord = {
        quizId,
        moduleId: module.id,
        concept: module.concept || module.title,
        kind,
        question: q.body.trim(),
        options: opts.map(o => ({ id: o.attrs.id.toUpperCase(), text: o.body.trim() })),
        correctId: correct.body.trim().toUpperCase(),
        why: why.body.trim(),
      };
      await this.workspaceContext.workspaceState.update(`quiz:${quizId}`, pendingRecord);

      // Increment quizzes asked
      if (kind === 'decision') {
        this.stateManager.updateState({ quizzesAsked: state.quizzesAsked + 1 });
      }

      // Demo mode indicator
      if (config.demoMode && this.firstMessage) {
        this.firstMessage = false;
        const demoNote = new LFComment('(Demo mode: scripted responses)', 'agent', config.agentName);
        this.threadManager.addComment(thread, demoNote);
      }

      this.treeProvider.refresh();
    });
  }

  /**
   * Handle a quiz answer (button click or text reply).
   */
  async handleQuizAnswer(
    thread: vscode.CommentThread,
    quizComment: LFComment,
    answer: { type: 'answer'; choice: string } | { type: 'iknow' }
  ): Promise<void> {
    const config = this.getConfig();
    const quizId = quizComment.quizId;
    if (!quizId) return;

    const pendingRecord = this.workspaceContext.workspaceState.get<{
      quizId: string;
      moduleId: string;
      concept: string;
      kind?: 'decision' | 'learning-check';
      question: string;
      options: { id: string; text: string }[];
      correctId: string;
      why: string;
    }>(`quiz:${quizId}`);

    if (!pendingRecord) {
      const expired = new LFComment('This question expired.', 'agent', config.agentName);
      this.threadManager.addComment(thread, expired);
      return;
    }

    // Mark quiz as answered
    quizComment.contextValue = 'quiz-answered';
    try { thread.comments = [...thread.comments]; } catch { /* */ }

    const state = this.stateManager.getState();
    const module = state.plan?.modules.find(m => m.id === pendingRecord.moduleId);

    if (pendingRecord.kind === 'learning-check') {
      if (answer.type === 'iknow') {
        this.threadManager.addComment(thread, new LFComment(
          `Good. The key idea is: ${pendingRecord.why}`,
          'agent',
          config.agentName
        ));
      } else {
        const { feedback } = evaluateQuiz(
          answer.choice,
          pendingRecord.correctId,
          pendingRecord.options,
          pendingRecord.why
        );
        this.threadManager.addComment(thread, new LFComment(feedback, 'agent', config.agentName));
      }
      await this.workspaceContext.workspaceState.update(`quiz:${quizId}`, undefined);
      this.treeProvider.refresh();
      return;
    }

    if (answer.type === 'iknow') {
      // Add concept to known
      const knownConcepts = [...state.knownConcepts, normalizeConcept(pendingRecord.concept)];
      this.stateManager.updateState({ knownConcepts });

      // Post "I know this" as user and proceed to BUILD
      const iknowComment = new LFComment('I know this', 'user', config.agentName);
      this.threadManager.addComment(thread, iknowComment);

      if (module) {
        const decision = `${pendingRecord.concept}: ${pendingRecord.options.find(o => o.id === pendingRecord.correctId)?.text || pendingRecord.correctId}`;
        await this.runBuild(thread, module, decision);
      }
    } else {
      // Evaluate the answer
      const chosenOpt = pendingRecord.options.find(o => o.id === answer.choice.toUpperCase());
      const recommendedOpt = pendingRecord.options.find(o => o.id === pendingRecord.correctId);
      const feedback = chosenOpt
        ? `You chose **${chosenOpt.text}**. ${pendingRecord.why} We’ll use your choice for this module.`
        : `The recommended option was **${recommendedOpt?.text || pendingRecord.correctId}**. ${pendingRecord.why}`;

      // Design choices belong to the user; explain the recommendation without
      // turning a preference into a right-or-wrong quiz answer.
      const feedbackComment = new LFComment(feedback, 'agent', config.agentName);
      this.threadManager.addComment(thread, feedbackComment);

      // Log the decision
      const logEntry = {
        module: pendingRecord.moduleId,
        concept: pendingRecord.concept,
        question: pendingRecord.question,
        options: pendingRecord.options,
        userChoice: answer.choice,
        correctId: pendingRecord.correctId,
        reason: pendingRecord.why,
        timestamp: new Date().toISOString(),
        exported: false,
      };
      state.decisionLog.push(logEntry);
      this.stateManager.updateState({ decisionLog: state.decisionLog });

      // Proceed to BUILD
      if (module) {
        const decision = `${pendingRecord.concept}: ${chosenOpt?.text || recommendedOpt?.text || pendingRecord.correctId}`;
        await this.runBuild(thread, module, decision);
      }
    }

    // Clean up workspace state
    await this.workspaceContext.workspaceState.update(`quiz:${quizId}`, undefined);
    this.treeProvider.refresh();
  }

  /**
   * Handle quiz answer from button click.
   */
  async handleQuizButton(comment: LFComment, choice: string): Promise<void> {
    // Find the thread containing this comment
    const found = this.threadManager.findThreadByQuizId(comment.quizId || '');
    if (!found) {
      // Fallback: search by body text
      for (const [id, thread] of this.threadManager.getAllThreads()) {
        const comments = thread.comments as LFComment[];
        if (comments.includes(comment)) {
          await this.handleQuizAnswer(thread, comment, { type: 'answer', choice });
          return;
        }
      }
      return;
    }

    if (choice === 'iknow') {
      await this.handleQuizAnswer(found.thread, comment, { type: 'iknow' });
    } else {
      await this.handleQuizAnswer(found.thread, comment, { type: 'answer', choice });
    }
  }

  /**
   * Run BUILD state.
   */
  async runBuild(thread: vscode.CommentThread, module: ModuleState, decision: string): Promise<void> {
    const config = this.getConfig();
    const budget = this.getBudget();
    let builtSuccessfully = false;

    await this.withBusy(thread, async (signal) => {
      const context = await this.buildContext(thread);
      const messages: LlmMessage[] = [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: context + '\n\n' + getBuildPrompt(module.title, module.goal, decision) },
      ];

      const result = await this.llmCall(messages, signal, 'BUILD');
      if (!result) return;

      const { tags } = result;

      // Execute actions
      const execResult = await executeActions(tags, this.wsRoot, this.stateManager, thread);
      builtSuccessfully = execResult.success;

      // Post say text
      const sayTag = findTag(tags, 'say');
      if (sayTag) {
        let sayText = truncateSay(sayTag.body.trim(), budget.explanationLength);
        if (!execResult.success) {
          sayText += '\n\n⚠️ Some actions failed:\n' + execResult.errors.join('\n');
        }
        const agentComment = new LFComment(sayText, 'agent', config.agentName);
        this.threadManager.addComment(thread, agentComment);
      }

      // Mark module as done
      const state = this.stateManager.getState();
      if (state.plan) {
        const mod = state.plan.modules.find(m => m.id === module.id);
        if (mod) mod.status = 'done';
        this.stateManager.updateState({ plan: state.plan });
      }

      // INTRO THREADS: for each created file (max 2), start an intro thread at line 1
      const fileTags = findAllTags(tags, 'file');
      let introCount = 0;
      for (const ft of fileTags) {
        if (introCount >= 2) break;
        if (!ft.attrs.intro) continue;
        const relPath = ft.attrs.path;
        if (!relPath) continue;

        try {
          const fileUri = vscode.Uri.joinPath(this.wsRoot, ...normalizeSeparators(relPath).split('/'));
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc, { preserveFocus: true });

          const introThread = this.threadManager.createThread(fileUri, 0);
          const introComment = new LFComment(ft.attrs.intro, 'agent', config.agentName);
          this.threadManager.addComment(introThread, introComment);
          introCount++;
        } catch { /* file might not exist yet */ }
      }

      // Demo mode indicator
      if (config.demoMode && this.firstMessage) {
        this.firstMessage = false;
        const demoNote = new LFComment('(Demo mode: scripted responses)', 'agent', config.agentName);
        this.threadManager.addComment(thread, demoNote);
      }

      this.treeProvider.refresh();
    });

    // Learn mode closes each successfully built module with one code-grounded
    // comprehension check. It does not consume the design-decision question budget.
    if (builtSuccessfully && config.mode === 'learn') {
      await this.runAsk(thread, module, 'learning-check');
    }
  }

  /**
   * Run CHAT state.
   */
  async runChat(thread: vscode.CommentThread, message: string): Promise<void> {
    const config = this.getConfig();
    const budget = this.getBudget();

    await this.withBusy(thread, async (signal) => {
      const context = await this.buildContext(thread);
      const messages: LlmMessage[] = [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: context + '\n\n' + getChatPrompt(message) },
      ];

      const result = await this.llmCall(messages, signal, 'CHAT');
      if (!result) return;

      const { tags } = result;

      // Execute any file operations
      const actionTags = tags.filter(t => ['folder', 'file', 'edit', 'insert', 'memory'].includes(t.tag));
      if (actionTags.length > 0) {
        await executeActions(tags, this.wsRoot, this.stateManager, thread);
      }

      // Post say text
      const sayTag = findTag(tags, 'say');
      if (sayTag) {
        const sayText = truncateSay(sayTag.body.trim(), budget.explanationLength);
        const agentComment = new LFComment(sayText, 'agent', config.agentName);
        this.threadManager.addComment(thread, agentComment);
      }

      // Demo mode indicator
      if (config.demoMode && this.firstMessage) {
        this.firstMessage = false;
        const demoNote = new LFComment('(Demo mode: scripted responses)', 'agent', config.agentName);
        this.threadManager.addComment(thread, demoNote);
      }

      this.treeProvider.refresh();
    });
  }

  /**
   * Build context for LLM calls.
   */
  private async buildContext(thread: vscode.CommentThread): Promise<string> {
    const config = this.getConfig();
    const state = this.stateManager.getState();
    const budget = this.getBudget();

    const parts: ContextParts = {
      mode: config.mode,
      explanationLength: budget.explanationLength,
    };

    // Project info
    if (state.project.name) {
      parts.projectName = state.project.name;
      parts.projectBrief = state.project.brief;
    }

    // Plan info
    if (state.plan) {
      parts.planSummary = state.plan.summary;
      parts.moduleStatuses = state.plan.modules.map(m =>
        `${m.id}: ${m.title} [${m.status}]`
      ).join('\n');

      const currentIdx = state.currentModuleIndex;
      if (currentIdx < state.plan.modules.length) {
        const current = state.plan.modules[currentIdx];
        parts.currentModule = `${current.title} - ${current.goal}`;
      }
    }

    if (state.knownConcepts.length > 0) {
      parts.knownConcepts = state.knownConcepts;
    }

    // Folder memory
    const relPath = vscode.workspace.asRelativePath(thread.uri, false);
    const folderParts = normalizeSeparators(relPath).split('/');
    folderParts.pop();
    const folderPath = folderParts.join('/');
    const folderKey = StateManager.folderKey(folderPath);
    const memory = await this.stateManager.readMemory(folderKey);
    if (memory) {
      parts.folderMemory = memory;
    }

    // Folder files
    try {
      const folderUri = folderParts.length > 0
        ? vscode.Uri.joinPath(this.wsRoot, ...folderParts)
        : this.wsRoot;
      const entries = await vscode.workspace.fs.readDirectory(folderUri);
      parts.folderFiles = entries
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => name)
        .slice(0, 20);
    } catch { /* */ }

    // Anchor context
    try {
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const anchorLine = thread.range.start.line;
      parts.anchorContext = getAnchorContext(doc.getText(), anchorLine);
    } catch { /* */ }

    // Recent messages from this thread (last 6)
    const threadComments = thread.comments as LFComment[];
    const recentMessages = threadComments.slice(-6).map(c =>
      `${c.role === 'user' ? 'User' : 'Agent'}: ${c.getText().substring(0, 300)}`
    );
    if (recentMessages.length > 0) {
      parts.recentMessages = recentMessages;
    }

    return assembleContext(parts, config.contextMaxChars);
  }

  /**
   * Make an LLM call with retries and validation.
   */
  private async llmCall(
    messages: LlmMessage[],
    signal: AbortSignal,
    state: string
  ): Promise<{ tags: ParsedTag[] } | null> {
    const config = this.getConfig();

    let retryCount = 0;
    const maxRetries = 2;
    let lastIssue = `Gemini returned a response that LogicForge could not use for ${state}.`;

    while (retryCount <= maxRetries) {
      try {
        const result = await this.llmClient.complete(messages, {
          temperature: 0.3,
          maxTokens: config.maxTokens,
          signal,
        });

        // Check for finish_reason == "length" or unclosed tag
        if (result.finishReason === 'length') {
          lastIssue = 'The Gemini response reached its output limit. Increase logicforge.maxTokens or ask for a smaller plan.';
          if (retryCount < 1) {
            retryCount++;
            messages.push({ role: 'assistant', content: result.text });
            messages.push({ role: 'user', content: 'Your response was cut off. Please retry with a smaller scope.' });
            continue;
          }
          throw new Error(lastIssue);
        }

        // Parse
        let tags: ParsedTag[];
        try {
          tags = parseTags(result.text);
        } catch (parseError) {
          lastIssue = `Gemini response was not in LogicForge's tagged format: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
          // Retry once with the parser error and the state-specific allowed tag list.
          if (retryCount < 1) {
            retryCount++;
            const allowedTags: Record<string, string> = {
              PLAN: 'say, plan, module',
              ASK: 'say, ask, q, opt, correct, why',
              BUILD: 'say, folder, file, edit, insert, memory',
              CHAT: 'say, folder, file, edit, insert, memory',
            };
            messages.push({
              role: 'user',
              content: `Format error: ${lastIssue}. Retry using only these tags: ${allowedTags[state] || 'say'}. Do not add any other tags or Markdown fences. Return the complete response.`,
            });
            continue;
          }
          throw new Error(lastIssue);
        }

        // Validate allowed tags
        const allowedResult = validateAllowedTags(tags, state);
        if (!allowedResult.valid) {
          lastIssue = `Gemini response format issue: ${allowedResult.errors.map(error => error.message).join('; ')}`;
          if (retryCount < 1) {
            retryCount++;
            messages.push({ role: 'user', content: 'Return ONLY the tagged format.' });
            continue;
          }
          throw new Error(lastIssue);
        }

        // State-specific validation
        let validationOk = true;
        let validationMessage = '';
        if (state === 'PLAN') {
          const v = validatePlan(tags);
          if (!v.valid) { validationOk = false; validationMessage = v.errors.map(error => error.message).join('; '); }
        } else if (state === 'ASK') {
          const v = validateAsk(tags);
          if (!v.valid) { validationOk = false; validationMessage = v.errors.map(error => error.message).join('; '); }
        } else if (state === 'BUILD' || state === 'CHAT') {
          const v = validateBuildChat(tags);
          if (!v.valid) { validationOk = false; validationMessage = v.errors.map(error => error.message).join('; '); }
        }

        if (!validationOk) {
          lastIssue = `Gemini response did not meet ${state} requirements: ${validationMessage}`;
          if (retryCount < 1) {
            retryCount++;
            messages.push({ role: 'user', content: 'Return ONLY the tagged format.' });
            continue;
          }
          throw new Error(lastIssue);
        }

        return { tags };
      } catch (e) {
        if (signal.aborted) return null;
        throw e;
      }
    }
    throw new Error(lastIssue);
  }

  /**
   * Wrap an async operation with busy state and thinking indicator.
   */
  private async withBusy(
    thread: vscode.CommentThread,
    fn: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    if (this.busy) {
      vscode.window.showWarningMessage('LogicForge is busy.');
      return;
    }

    this.busy = true;
    this.abortController = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      this.abortController?.abort();
    }, 60000);
    this.updateStatusBar(true);

    // Add thinking comment
    const config = this.getConfig();
    const thinkingComment = new LFComment('Thinking...', 'agent', config.agentName);
    const addedThinking = this.threadManager.addComment(thread, thinkingComment);

    try {
      await fn(this.abortController.signal);
      if (timedOut) {
        const timeoutComment = new LFComment('Request timed out after 60 seconds. Check your internet connection and Gemini API key, then try again.', 'agent', config.agentName);
        this.threadManager.addComment(thread, timeoutComment);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg !== 'Request cancelled') {
        try {
          const errorComment = new LFComment(`Error: ${errMsg}`, 'agent', config.agentName);
          this.threadManager.addComment(thread, errorComment);
        } catch { /* thread may be disposed */ }
      }
    } finally {
      clearTimeout(timeoutId);
      this.busy = false;
      this.abortController = null;
      this.updateStatusBar(false);

      // Remove thinking comment if it's still there
      if (addedThinking) {
        try {
          const comments = [...thread.comments] as LFComment[];
          const thinkingIdx = comments.findIndex(c => c.getText() === 'Thinking...');
          if (thinkingIdx >= 0) {
            comments.splice(thinkingIdx, 1);
            thread.comments = comments;
          }
        } catch { /* thread may be disposed */ }
      }
    }
  }

  /**
   * Strip optional mention at the start of a message.
   */
  private stripMention(text: string, agentName: string): string {
    const re = new RegExp(`^\\s*@${agentName}\\s*[,:]*\\s*`, 'i');
    return text.replace(re, '').trim();
  }
}
