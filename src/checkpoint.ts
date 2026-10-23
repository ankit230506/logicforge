// checkpoint.ts – Checkpoint command implementation

import * as vscode from 'vscode';
import { LlmClient, LlmMessage } from './llm';
import { parseTags, findTag, findAllTags, findChildTags } from './parser';
import { validateNotes, validateHistory } from './validators';
import { StateManager } from './state';
import { ThreadManager, LFComment } from './threads';
import { readConfig } from './config';
import { formatWhyComment, getIndentation, supportsWhyComment, getCommentStyle } from './commentSyntax';
import { renderHistory, HistoryData, HistorySection } from './history';
import { getNotesPrompt, getHistoryPrompt, getSystemPrompt } from './prompts';
import * as path from 'path';

interface ThreadInfo {
  id: string;
  thread: vscode.CommentThread;
  relPath: string;
  line: number;
  comments: LFComment[];
  anchorText: string;
  codeContext: string;
}

export async function runCheckpoint(
  llmClient: LlmClient,
  stateManager: StateManager,
  threadManager: ThreadManager,
  workspaceContext: vscode.ExtensionContext
): Promise<void> {
  const config = readConfig();
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!wsRoot) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  // 1. Collect threads (skip pending quiz and unfinished requests)
  const allThreads = threadManager.getAllThreads();
  const eligibleThreads: ThreadInfo[] = [];
  let skippedCount = 0;

  for (const [id, thread] of allThreads) {
    const comments = thread.comments as LFComment[];

    // Skip threads with pending quiz
    if (comments.some(c => c.contextValue === 'quiz-pending')) {
      skippedCount++;
      continue;
    }

    // Skip threads with thinking... comment
    if (comments.some(c => c.getText() === 'Thinking...')) {
      skippedCount++;
      continue;
    }

    if (comments.length === 0) continue;

    const relPath = vscode.workspace.asRelativePath(thread.uri, false);
    const line = thread.range.start.line;

    let anchorText = '';
    let codeContext = '';
    try {
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      if (line < doc.lineCount) {
        anchorText = doc.lineAt(line).text;
        // Get next 3 code lines
        const endLine = Math.min(line + 3, doc.lineCount - 1);
        const contextLines: string[] = [];
        for (let i = line; i <= endLine; i++) {
          contextLines.push(doc.lineAt(i).text);
        }
        codeContext = contextLines.join('\n');
      }
    } catch { /* file may not exist */ }

    eligibleThreads.push({ id, thread, relPath, line, comments, anchorText, codeContext });
  }

  if (eligibleThreads.length === 0) {
    vscode.window.showInformationMessage(
      `No eligible threads for checkpoint.${skippedCount > 0 ? ` (${skippedCount} skipped: pending quiz or busy)` : ''}`
    );
    return;
  }

  // 2. Generate WHY NOTES per file, batches of <= 12
  const threadsByFile = new Map<string, ThreadInfo[]>();
  for (const t of eligibleThreads) {
    const arr = threadsByFile.get(t.relPath) || [];
    arr.push(t);
    threadsByFile.set(t.relPath, arr);
  }

  const noteMap = new Map<string, string>(); // threadId -> note text

  for (const [relPath, fileThreads] of threadsByFile) {
    for (let i = 0; i < fileThreads.length; i += 12) {
      const batch = fileThreads.slice(i, i + 12);
      const threadData = batch.map(t => ({
        id: t.id,
        messages: t.comments
          .slice(-8)
          .map(c => `${c.role}: ${c.getText().substring(0, 600)}`)
          .join('\n'),
        anchor: t.anchorText,
        codeContext: t.codeContext,
      }));

      try {
        const prompt = getNotesPrompt(threadData);
        const result = await llmClient.complete([
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: prompt },
        ]);

        const tags = parseTags(result.text);
        const validation = validateNotes(tags);
        if (validation.valid) {
          const notes = findAllTags(tags, 'note');
          for (const note of notes) {
            const noteId = note.attrs.id;
            const matchingThread = batch.find(t => t.id === noteId || t.id.endsWith(noteId));
            if (matchingThread) {
              if (note.attrs.drop === 'true') {
                // drop this thread's note
              } else {
                noteMap.set(matchingThread.id, note.body.trim());
              }
            }
          }
        } else {
          throw new Error('Invalid notes response');
        }
      } catch {
        // Fallback: first sentence of last agent message, question sentences removed
        for (const t of batch) {
          const lastAgent = [...t.comments].reverse().find(c => c.role === 'agent');
          if (lastAgent) {
            const text = lastAgent.getText();
            const sentences = text.split(/[.!?]+/).filter(s => s.trim());
            const nonQuestion = sentences.filter(s => !s.trim().endsWith('?') && !s.includes('?'));
            if (nonQuestion.length > 0) {
              const note = nonQuestion[0].trim().substring(0, 110);
              if (note) noteMap.set(t.id, note);
            }
          }
        }
      }
    }
  }

  // 3. Generate HISTORY
  const state = stateManager.getState();
  const existingHistory = await stateManager.readHistory();

  // Build material for history
  const materialParts: string[] = [];
  for (const t of eligibleThreads) {
    const topic = t.comments[0]?.getText()?.substring(0, 50) || 'Thread';
    const lastAgent = [...t.comments].reverse().find(c => c.role === 'agent');
    const explanation = lastAgent?.getText()?.substring(0, 200) || '';
    materialParts.push(`Topic: ${topic}\nExplanation: ${explanation}`);
  }
  // Un-exported decisions
  const unexportedDecisions = state.decisionLog.filter(d => !d.exported);
  for (const d of unexportedDecisions) {
    materialParts.push(`Decision: ${d.concept}\nQuestion: ${d.question}\nOptions: ${d.options.map(o => `${o.id}) ${o.text}`).join(', ')}\nChoice: ${d.userChoice}\nCorrect: ${d.correctId}\nReason: ${d.reason}`);
  }

  const existingHeadings = existingHistory
    .split('\n')
    .filter(l => l.startsWith('### '))
    .join(', ');

  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const archiveFilename = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.md`;

  let historyData: HistoryData;
  try {
    const histPrompt = getHistoryPrompt(materialParts.join('\n\n'), existingHeadings);
    const histResult = await llmClient.complete([
      { role: 'system', content: getSystemPrompt() },
      { role: 'user', content: histPrompt },
    ]);
    const histTags = parseTags(histResult.text);
    const histValidation = validateHistory(histTags);
    if (histValidation.valid) {
      const hist = findTag(histTags, 'history');
      const sections = findChildTags(hist!, 'section');
      historyData = {
        project: hist!.attrs.project || state.project.name || 'Project',
        sections: sections.map(s => ({
          title: s.attrs.title,
          items: findChildTags(s, 'item').map(item => ({
            label: item.attrs.label,
            text: item.body.trim(),
          })),
        })),
      };
    } else {
      throw new Error('Invalid history response');
    }
  } catch {
    // Fallback: generate from decisions and threads
    const fallbackSections: HistorySection[] = [];
    for (const d of unexportedDecisions) {
      const correctOpt = d.options.find(o => o.id === d.correctId);
      fallbackSections.push({
        title: `${d.concept} Decision`,
        items: [
          { label: 'Question', text: d.question.substring(0, 60) },
          { label: 'Alternatives', text: d.options.map(o => o.text).join(', ') },
          { label: 'Final Decision', text: correctOpt?.text || d.correctId },
          { label: 'Key Insight', text: d.reason.substring(0, 110) },
        ],
      });
    }
    // Add non-decision threads
    for (const t of eligibleThreads) {
      const firstUser = t.comments.find(c => c.role === 'user');
      const lastAgent = [...t.comments].reverse().find(c => c.role === 'agent');
      if (firstUser && lastAgent) {
        const userText = firstUser.getText().substring(0, 60);
        const agentSentences = lastAgent.getText().split(/[.!?]+/).filter(s => s.trim());
        const insight = agentSentences[0]?.trim()?.substring(0, 110) || '';
        if (insight && !fallbackSections.some(s => s.title.includes(userText.substring(0, 20)))) {
          fallbackSections.push({
            title: userText.substring(0, 40),
            items: [
              { label: 'Question', text: userText.split(/\s+/).slice(0, 12).join(' ') },
              { label: 'Key Insight', text: insight },
            ],
          });
        }
      }
    }
    historyData = {
      project: state.project.name || 'Project',
      sections: fallbackSections.length > 0 ? fallbackSections : [
        { title: 'Checkpoint', items: [{ label: 'Note', text: 'Conversations archived' }] }
      ],
    };
  }

  const historyContent = renderHistory(historyData, existingHistory, timestamp);

  // 4. Build archive
  const archiveLines: string[] = [`# LogicForge Checkpoint Archive - ${timestamp}`, ''];
  for (const [relPath, fileThreads] of threadsByFile) {
    archiveLines.push(`## ${relPath}`, '');
    for (const t of fileThreads) {
      archiveLines.push(`### Line ${t.line + 1}`, '');
      for (const c of t.comments) {
        archiveLines.push(`**${c.role === 'user' ? 'You' : 'LogicForge'}** (${c.label || ''}):`);
        archiveLines.push(c.getText(), '');
      }
    }
  }
  const archiveContent = archiveLines.join('\n');

  // 5. Build preview
  const previewLines: string[] = [];
  previewLines.push(`# Checkpoint Preview`, '');
  previewLines.push(`**Threads to process:** ${eligibleThreads.length}`);
  if (skippedCount > 0) previewLines.push(`**Skipped:** ${skippedCount} (pending quiz or busy)`);
  previewLines.push(`**Notes generated:** ${noteMap.size}`);
  previewLines.push('');
  for (const [relPath, fileThreads] of threadsByFile) {
    previewLines.push(`## ${relPath}`);
    const shownThreads = fileThreads.slice(0, 3);
    for (const t of shownThreads) {
      const note = noteMap.get(t.id);
      previewLines.push(`- Line ${t.line + 1}: ${note || '(no note)'}`);
    }
    if (fileThreads.length > 3) {
      previewLines.push(`  ...and ${fileThreads.length - 3} more`);
    }
    previewLines.push('');
  }
  previewLines.push('**Files to create/update:**');
  previewLines.push(`- .logicforge/history.md`);
  previewLines.push(`- .logicforge/checkpoints/${archiveFilename}`);
  if (config.keepWhyComments) previewLines.push('- Why-comments above thread anchors');

  // Show preview
  const previewDoc = await vscode.workspace.openTextDocument({
    content: previewLines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(previewDoc, { preview: true });

  // Confirmation
  const isTest = process.env.LOGICFORGE_TEST === '1';
  let proceed = isTest;
  if (!isTest) {
    const choice = await vscode.window.showWarningMessage(
      'Apply checkpoint? This will condense conversations and add why-comments.',
      { modal: true },
      'Apply', 'Cancel'
    );
    proceed = choice === 'Apply';
  }

  if (!proceed) {
    vscode.window.showInformationMessage('Checkpoint cancelled.');
    return;
  }

  // 6. Apply
  const wsEdit = new vscode.WorkspaceEdit();

  // (a) Why-comments (bottom to top per file)
  if (config.keepWhyComments) {
    for (const [relPath, fileThreads] of threadsByFile) {
      const ext = path.extname(relPath);
      if (!supportsWhyComment(ext)) continue;

      try {
        const fileUri = vscode.Uri.joinPath(wsRoot, relPath);
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

        // Sort threads bottom to top so insertions don't shift line numbers
        const sortedThreads = [...fileThreads].sort((a, b) => b.line - a.line);
        for (const t of sortedThreads) {
          const note = noteMap.get(t.id);
          if (!note) continue;
          if (t.line >= doc.lineCount) continue;

          const anchorLine = doc.lineAt(t.line);
          const indentation = getIndentation(anchorLine.text);
          const commentText = formatWhyComment(note, ext, indentation, eol);
          if (commentText) {
            const pos = new vscode.Position(t.line, 0);
            wsEdit.insert(fileUri, pos, commentText);
          }
        }
      } catch { /* skip file */ }
    }
  }

  // (b) History
  const historyUri = vscode.Uri.joinPath(wsRoot, '.logicforge', 'history.md');
  wsEdit.createFile(historyUri, { overwrite: true, ignoreIfExists: false });
  wsEdit.insert(historyUri, new vscode.Position(0, 0), historyContent);

  // (c) Archive
  const archiveUri = vscode.Uri.joinPath(wsRoot, '.logicforge', 'checkpoints', archiveFilename);
  wsEdit.createFile(archiveUri, { overwrite: true, ignoreIfExists: false });
  wsEdit.insert(archiveUri, new vscode.Position(0, 0), archiveContent);

  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) {
    vscode.window.showErrorMessage('Failed to apply checkpoint edits.');
    return;
  }

  // Save touched documents
  for (const [relPath] of threadsByFile) {
    try {
      const fileUri = vscode.Uri.joinPath(wsRoot, relPath);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === fileUri.toString());
      if (doc?.isDirty) await doc.save();
    } catch { /* */ }
  }
  // Save history and archive
  try {
    const histDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === historyUri.toString());
    if (histDoc?.isDirty) await histDoc.save();
    const archDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === archiveUri.toString());
    if (archDoc?.isDirty) await archDoc.save();
  } catch { /* */ }

  // Dispose included threads and remove from threads.json
  for (const t of eligibleThreads) {
    threadManager.disposeThread(t.id);
  }

  // Mark decisions exported
  for (const d of unexportedDecisions) {
    d.exported = true;
  }
  stateManager.updateState({
    decisionLog: state.decisionLog,
    checkpoints: state.checkpoints + 1,
  });
  await stateManager.saveAll();

  vscode.window.showInformationMessage('Done: chat condensed. History in .logicforge/history.md');
}
