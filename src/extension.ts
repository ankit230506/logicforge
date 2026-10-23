// extension.ts – Main extension entry point

import * as vscode from 'vscode';
import { readConfig, updateConfig } from './config';
import { GeminiLlmClient, getApiKey, promptApiKey, LlmClient } from './llm';
import { ScriptedLlm } from './demo';
import { StateManager } from './state';
import { ThreadManager, LFComment } from './threads';
import { Orchestrator } from './orchestrator';
import { StatusBar } from './status';
import { LogicForgeTreeProvider } from './tree';
import { runCheckpoint } from './checkpoint';
import { normalizeSeparators } from './sandbox';
import { ChatViewProvider } from './chatView';

interface TestApi {
  createThread(uri: vscode.Uri, line: number): vscode.CommentThread;
  reply(thread: vscode.CommentThread, text: string): Promise<void>;
  getThreads(): Map<string, vscode.CommentThread>;
  getState(): unknown;
}

const isTestMode = () => process.env.LOGICFORGE_TEST === '1';

/**
 * Safe wrapper for registrations: logs and shows one warning on failure.
 */
function safe<T extends vscode.Disposable>(
  name: string,
  fn: () => T,
  context: vscode.ExtensionContext
): T | undefined {
  try {
    const disposable = fn();
    context.subscriptions.push(disposable);
    return disposable;
  } catch (e) {
    console.error(`LogicForge: Failed to register ${name}:`, e);
    vscode.window.showWarningMessage(`LogicForge: "${name}" failed to initialize. The rest of the extension should still work.`);
    return undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  try {
    return await doActivate(context);
  } catch (e) {
    console.error('LogicForge: Activation failed:', e);
    vscode.window.showWarningMessage('LogicForge failed to activate. Check the output panel for details.');
    return undefined;
  }
}

async function doActivate(context: vscode.ExtensionContext): Promise<TestApi | undefined> {
  // Check workspace
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    vscode.window.showWarningMessage('Please open a workspace folder first.');
    // Register a minimal ping command
    safe('Ping', () => vscode.commands.registerCommand('logicforge.ping', () => {
        vscode.window.showInformationMessage('LogicForge: Please open a workspace folder first.');
      }), context);
    return undefined;
  }

  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 1) {
    vscode.window.showInformationMessage('LogicForge: Multiple workspace folders detected. Using the first one.');
  }

  const wsRoot = wsFolder.uri;
  const config = readConfig();

  // Initialize state manager
  const stateManager = new StateManager(wsRoot);
  await stateManager.init();

  // Initialize status bar
  const statusBar = safe('Status Bar', () => new StatusBar(), context) ??
    ({ update: () => undefined, dispose: () => undefined } as unknown as StatusBar);
  statusBar.update(config.mode, config.timeBudgetHours, config.demoMode, false);

  // Initialize tree provider
  const treeProvider = new LogicForgeTreeProvider(stateManager);

  // Initialize LLM client
  let llmClient: LlmClient;
  if (config.demoMode || isTestMode()) {
    llmClient = new ScriptedLlm();
  } else {
    // Will be set up on first request if needed
    llmClient = new ScriptedLlm();
  }

  // Initialize thread manager
  const threadManager = new ThreadManager(config.agentName, stateManager);
  context.subscriptions.push({ dispose: () => threadManager.dispose() });

  // Initialize orchestrator
  const orchestrator = new Orchestrator(
    llmClient,
    stateManager,
    threadManager,
    statusBar,
    treeProvider,
    context,
    wsRoot
  );

  /**
   * Ensure we have a working LLM client (prompt for key if needed).
   */
  async function ensureLlmClient(): Promise<boolean> {
    const cfg = readConfig();
    if (cfg.demoMode || isTestMode()) {
      orchestrator.setLlmClient(new ScriptedLlm());
      return true;
    }

    let key = await getApiKey(context.secrets);
    if (!key) {
      key = await promptApiKey(context.secrets);
      if (!key) return false;
    }

    const updatedCfg = readConfig();
    orchestrator.setLlmClient(
      new GeminiLlmClient(updatedCfg.model, key, updatedCfg.maxTokens)
    );
    return true;
  }

  let chatThread: vscode.CommentThread | undefined;
  let chatThreadUri = '';
  const chatViewProvider = new ChatViewProvider(async (text) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('Open a file in your workspace before chatting with LogicForge.');
    if (!await ensureLlmClient()) throw new Error('Set an API key before sending a message.');

    const uri = editor.document.uri.toString();
    if (!chatThread || chatThreadUri !== uri) {
      chatThread = threadManager.createThread(editor.document.uri, editor.selection.active.line);
      chatThreadUri = uri;
    }
    const thread = chatThread;
    const previousCount = thread.comments.length;
    await orchestrator.handleReply({ text, thread });
    const newAgentMessages = (thread.comments as LFComment[])
      .slice(previousCount)
      .filter(comment => comment.role === 'agent' && comment.getText() !== 'Thinking...')
      .map(comment => comment.getText());
    return newAgentMessages.join('\n\n');
  }, () => orchestrator.cancel());
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'logicforge.chatView',
    chatViewProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  ));
  safe('Continue in LogicForge Chat', () =>
    vscode.commands.registerCommand('logicforge.openChatForThread', async (arg: vscode.CommentThread | vscode.CommentReply) => {
      const thread = 'thread' in arg ? arg.thread : arg;
      chatThread = thread;
      chatThreadUri = thread.uri.toString();
      await vscode.commands.executeCommand('workbench.view.extension.logicforge-sidebar');
      chatViewProvider.focusInput();
    }), context);

  // Register tree view
  safe('Tree View', () => {
    const treeView = vscode.window.createTreeView('logicforge.sideView', {
      treeDataProvider: treeProvider,
    });
    return treeView;
  }, context);

  // Register commands
  safe('Ask Here', () =>
    vscode.commands.registerCommand('logicforge.askHere', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Open a file first.');
          return;
        }
        const line = editor.selection.active.line;
        threadManager.createThread(editor.document.uri, line);
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Reply', () =>
    vscode.commands.registerCommand('logicforge.reply', async (reply: vscode.CommentReply) => {
      try {
        if (!await ensureLlmClient()) return;
        await orchestrator.handleReply({ text: reply.text, thread: reply.thread });
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Answer A', () =>
    vscode.commands.registerCommand('logicforge.answerA', async (comment: LFComment) => {
      try {
        if (!await ensureLlmClient()) return;
        await orchestrator.handleQuizButton(comment, 'A');
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Answer B', () =>
    vscode.commands.registerCommand('logicforge.answerB', async (comment: LFComment) => {
      try {
        if (!await ensureLlmClient()) return;
        await orchestrator.handleQuizButton(comment, 'B');
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Answer C', () =>
    vscode.commands.registerCommand('logicforge.answerC', async (comment: LFComment) => {
      try {
        if (!await ensureLlmClient()) return;
        await orchestrator.handleQuizButton(comment, 'C');
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('I Know This', () =>
    vscode.commands.registerCommand('logicforge.iKnowThis', async (comment: LFComment) => {
      try {
        if (!await ensureLlmClient()) return;
        await orchestrator.handleQuizButton(comment, 'iknow');
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Next Module', () =>
    vscode.commands.registerCommand('logicforge.nextModule', async () => {
      try {
        if (!await ensureLlmClient()) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Open a file first.');
          return;
        }
        const line = editor.selection.active.line;
        const thread = threadManager.createThread(editor.document.uri, line);
        await orchestrator.runNext(thread);
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Checkpoint', () =>
    vscode.commands.registerCommand('logicforge.checkpoint', async () => {
      try {
        if (!await ensureLlmClient()) return;
        await runCheckpoint(orchestrator.getLlmClient(), stateManager, threadManager, context);
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Open History', () =>
    vscode.commands.registerCommand('logicforge.openHistory', async () => {
      try {
        const historyUri = vscode.Uri.joinPath(wsRoot, '.logicforge', 'history.md');
        try {
          await vscode.workspace.fs.stat(historyUri);
          const doc = await vscode.workspace.openTextDocument(historyUri);
          await vscode.window.showTextDocument(doc);
        } catch {
          vscode.window.showInformationMessage('No history file yet. Run Checkpoint first.');
        }
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Set API Key', () =>
    vscode.commands.registerCommand('logicforge.setApiKey', async () => {
      try {
        await promptApiKey(context.secrets);
        vscode.window.showInformationMessage('API key saved.');
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Set Mode', () =>
    vscode.commands.registerCommand('logicforge.setMode', async () => {
      try {
        const picked = await vscode.window.showQuickPick(
          [
            { label: 'Sprint', description: 'No quizzes, short explanations', value: 'sprint' },
            { label: 'Balanced', description: 'Quizzes at key decisions', value: 'balanced' },
            { label: 'Learn', description: 'More quizzes, fuller explanations', value: 'learn' },
          ],
          { placeHolder: 'Select a mode' }
        );
        if (picked) {
          await updateConfig('mode', picked.value);
          const cfg = readConfig();
          statusBar.update(cfg.mode, cfg.timeBudgetHours, cfg.demoMode, false);
          treeProvider.refresh();
        }
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Set Time Budget', () =>
    vscode.commands.registerCommand('logicforge.setTimeBudget', async () => {
      try {
        const input = await vscode.window.showInputBox({
          prompt: 'Time budget in hours (0 = no limit)',
          value: String(config.timeBudgetHours),
        });
        if (input !== undefined) {
          const hours = parseFloat(input) || 0;
          await updateConfig('timeBudgetHours', hours);
          const cfg = readConfig();
          statusBar.update(cfg.mode, cfg.timeBudgetHours, cfg.demoMode, false);
        }
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('New Project', () =>
    vscode.commands.registerCommand('logicforge.newProject', async () => {
      try {
        // Reset session (keeps memory files, history, workspace files)
        await stateManager.resetSession();
        threadManager.disposeAllThreads();
        // Clear workspaceState quiz entries
        for (const key of context.workspaceState.keys()) {
          if (key.startsWith('quiz:')) {
            await context.workspaceState.update(key, undefined);
          }
        }

        // Prompt for brief
        const brief = await vscode.window.showInputBox({
          prompt: 'Describe your new project in one sentence',
          placeHolder: 'A student management CLI in Python',
          ignoreFocusOut: true,
        });
        if (!brief) return;

        if (!await ensureLlmClient()) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Open a file first.');
          return;
        }
        const line = editor.selection.active.line;
        const thread = threadManager.createThread(editor.document.uri, line);

        // Add user comment
        const userComment = new LFComment(`/plan ${brief}`, 'user', readConfig().agentName);
        threadManager.addComment(thread, userComment);

        await orchestrator.runPlan(thread, brief);
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Reset Session', () =>
    vscode.commands.registerCommand('logicforge.resetSession', async () => {
      try {
        const confirm = isTestMode() ? 'Reset' : await vscode.window.showWarningMessage(
          'Reset LogicForge session? This will clear the plan and threads but keep files, history and memory.',
          { modal: true },
          'Reset', 'Cancel'
        );
        if (confirm !== 'Reset') return;

        await stateManager.resetSession();
        threadManager.disposeAllThreads();
        for (const key of context.workspaceState.keys()) {
          if (key.startsWith('quiz:')) {
            await context.workspaceState.update(key, undefined);
          }
        }
        treeProvider.refresh();
        vscode.window.showInformationMessage('LogicForge session reset.');
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Cancel', () =>
    vscode.commands.registerCommand('logicforge.cancel', () => {
      try {
        orchestrator.cancel();
        vscode.window.showInformationMessage('LogicForge: Request cancelled.');
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Ping', () =>
    vscode.commands.registerCommand('logicforge.ping', () => {
      try {
        const cfg = readConfig();
        const demoStr = cfg.demoMode ? ' (Demo mode)' : '';
        vscode.window.showInformationMessage(`LogicForge is active!${demoStr} Mode: ${cfg.mode}`);
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  safe('Toggle Demo Mode', () =>
    vscode.commands.registerCommand('logicforge.toggleDemoMode', async () => {
      try {
        const cfg = readConfig();
        const newVal = !cfg.demoMode;
        await updateConfig('demoMode', newVal);
        const updatedCfg = readConfig();
        statusBar.update(updatedCfg.mode, updatedCfg.timeBudgetHours, updatedCfg.demoMode, false);
        if (newVal) {
          orchestrator.setLlmClient(new ScriptedLlm());
        }
        vscode.window.showInformationMessage(`LogicForge demo mode: ${newVal ? 'ON' : 'OFF'}`);
      } catch (e) {
        vscode.window.showErrorMessage(`LogicForge: ${e instanceof Error ? e.message : String(e)}`);
      }
    }), context);

  // Register listeners
  safe('Document Open Listener', () =>
    vscode.workspace.onDidOpenTextDocument(async (doc) => {
      try {
        if (doc.uri.scheme === 'file') {
          await threadManager.restoreThreadsForDocument(doc);
        }
      } catch (e) {
        console.error('LogicForge: Error restoring threads:', e);
      }
    }), context);

  safe('Document Save Listener', () =>
    vscode.workspace.onDidSaveTextDocument((doc) => {
      try {
        threadManager.updateThreadAnchors(doc);
      } catch (e) {
        console.error('LogicForge: Error updating anchors:', e);
      }
    }), context);

  safe('Active Editor Change Listener', () =>
    vscode.window.onDidChangeActiveTextEditor((_editor) => {
      try {
        treeProvider.refresh();
      } catch { /* */ }
    }), context);

  safe('Config Change Listener', () =>
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('logicforge')) {
        try {
          const cfg = readConfig();
          statusBar.update(cfg.mode, cfg.timeBudgetHours, cfg.demoMode, orchestrator.isBusy());
          if (cfg.demoMode) {
            orchestrator.setLlmClient(new ScriptedLlm());
          }
          treeProvider.refresh();
        } catch { /* */ }
      }
    }), context);

  // Restore threads for already-open editors
  for (const editor of vscode.window.visibleTextEditors) {
    try {
      if (editor.document.uri.scheme === 'file') {
        await threadManager.restoreThreadsForDocument(editor.document);
      }
    } catch (e) {
      console.error('LogicForge: Error restoring threads for open editor:', e);
    }
  }

  console.log('LogicForge activated.');

  // Test API
  if (isTestMode()) {
    return {
      createThread(uri: vscode.Uri, line: number) {
        return threadManager.createThread(uri, line);
      },
      async reply(thread: vscode.CommentThread, text: string) {
        if (!await ensureLlmClient()) return;
        await orchestrator.handleReply({ text, thread });
      },
      getThreads() {
        return threadManager.getAllThreads();
      },
      getState() {
        return stateManager.getState();
      },
    };
  }

  return undefined;
}

export function deactivate(): void {
  // Cleanup is handled by disposables
}
