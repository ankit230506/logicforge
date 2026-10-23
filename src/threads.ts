// threads.ts – VS Code Comments API adapter

import * as vscode from 'vscode';
import { StateManager, ThreadRecord } from './state';
import { findAnchorLine } from './anchors';

/**
 * Our comment class used in threads.
 */
export class LFComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  label?: string;
  contextValue?: string;
  role: 'user' | 'agent';
  quizId?: string;

  constructor(
    body: string,
    role: 'user' | 'agent',
    agentName: string,
    quizId?: string,
    contextValue?: string
  ) {
    this.role = role;
    this.quizId = quizId;
    this.contextValue = contextValue;

    if (role === 'agent') {
      const md = new vscode.MarkdownString(body);
      md.isTrusted = false;
      md.supportHtml = false;
      this.body = md;
      this.author = { name: agentName };
    } else {
      this.body = body;
      this.author = { name: 'You' };
    }

    // Time label
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours % 12 || 12;
    this.label = `${h12}:${minutes} ${ampm}`;
  }

  getText(): string {
    if (typeof this.body === 'string') return this.body;
    return this.body.value;
  }
}

export class ThreadManager {
  private controller: vscode.CommentController;
  private threads: Map<string, vscode.CommentThread> = new Map();
  private threadCounter = 0;
  private agentName: string;
  private stateManager: StateManager;
  private disposables: vscode.Disposable[] = [];

  constructor(agentName: string, stateManager: StateManager) {
    this.agentName = agentName;
    this.stateManager = stateManager;

    this.controller = vscode.comments.createCommentController('logicforge', 'LogicForge');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] {
        if (document.uri.scheme !== 'file') return [];
        const lastLine = Math.max(0, document.lineCount - 1);
        return [new vscode.Range(0, 0, lastLine, 0)];
      }
    };
    this.controller.options = {
      placeHolder: 'Ask @LogicForge...',
      prompt: 'Ask a question or reply',
    };
  }

  getController(): vscode.CommentController {
    return this.controller;
  }

  getAllThreads(): Map<string, vscode.CommentThread> {
    return this.threads;
  }

  /**
   * Create a new thread at a specific line in a document.
   */
  createThread(uri: vscode.Uri, line: number): vscode.CommentThread {
    const id = `lf-${++this.threadCounter}-${Date.now()}`;
    const range = new vscode.Range(line, 0, line, 0);
    const thread = this.controller.createCommentThread(uri, range, []);
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.label = 'LogicForge';
    (thread as unknown as { id: string }).id = id;
    this.threads.set(id, thread);
    return thread;
  }

  /**
   * Get the ID of a thread.
   */
  getThreadId(thread: vscode.CommentThread): string {
    // Try the stored id
    const storedId = (thread as unknown as { id: string }).id;
    if (storedId && this.threads.has(storedId)) return storedId;
    // Search for it
    for (const [id, t] of this.threads) {
      if (t === thread) return id;
    }
    // Create an id for it
    const id = `lf-${++this.threadCounter}-${Date.now()}`;
    (thread as unknown as { id: string }).id = id;
    this.threads.set(id, thread);
    return id;
  }

  /**
   * Add a comment to a thread (safely).
   */
  addComment(thread: vscode.CommentThread, comment: LFComment): boolean {
    try {
      thread.comments = [...thread.comments, comment];
      this.persistThread(thread);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replace the last comment (e.g., remove "thinking..." and add real response).
   */
  replaceLastComment(thread: vscode.CommentThread, comment: LFComment): boolean {
    try {
      const comments = [...thread.comments];
      if (comments.length > 0) {
        comments[comments.length - 1] = comment;
      } else {
        comments.push(comment);
      }
      thread.comments = comments;
      this.persistThread(thread);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove the last comment from a thread (e.g., remove "thinking...").
   */
  removeLastComment(thread: vscode.CommentThread): boolean {
    try {
      const comments = [...thread.comments];
      if (comments.length > 0) {
        comments.pop();
        thread.comments = comments;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Persist a thread to the state manager.
   */
  persistThread(thread: vscode.CommentThread): void {
    const id = this.getThreadId(thread);
    const uri = thread.uri;
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) return;

    const relPath = vscode.workspace.asRelativePath(uri, false);
    const line = thread.range.start.line;

    // Get anchor text
    let anchorText = '';
    try {
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
      if (editor && line < editor.document.lineCount) {
        anchorText = editor.document.lineAt(line).text;
      }
    } catch { /* */ }

    const comments = (thread.comments as LFComment[]).map(c => ({
      role: c.role,
      text: c.getText(),
      time: c.label || '',
      quizId: c.quizId,
    }));

    this.stateManager.addThreadRecord({
      id,
      relPath,
      line,
      anchorText,
      comments,
    });
  }

  /**
   * Restore threads for a given document from saved records.
   */
  async restoreThreadsForDocument(document: vscode.TextDocument): Promise<void> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) return;

    const relPath = vscode.workspace.asRelativePath(document.uri, false);
    const records = this.stateManager.getThreadRecords().filter(r => r.relPath === relPath);

    for (const rec of records) {
      // Skip if already restored
      if (this.threads.has(rec.id)) continue;

      // Find the anchor line
      const lines = document.getText().replace(/\r\n/g, '\n').split('\n');
      const line = findAnchorLine(lines, rec.line, rec.anchorText);

      const thread = this.controller.createCommentThread(
        document.uri,
        new vscode.Range(line, 0, line, 0),
        []
      );
      thread.canReply = true;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      thread.label = 'LogicForge';
      (thread as unknown as { id: string }).id = rec.id;

      const comments: LFComment[] = [];
      for (const c of rec.comments) {
        const comment = new LFComment(c.text, c.role, this.agentName, c.quizId);
        comment.label = c.time;
        // Check for quiz-pending that has no record
        if (c.quizId && c.role === 'agent') {
          // Check if this quiz still has a pending record in workspaceState
          comment.contextValue = 'quiz-expired';
          // We'll check the workspace state externally
        }
        comments.push(comment);
      }
      thread.comments = comments;
      this.threads.set(rec.id, thread);
    }
  }

  /**
   * Update thread records on document save: capture live line and anchor text.
   */
  updateThreadAnchors(document: vscode.TextDocument): void {
    const relPath = vscode.workspace.asRelativePath(document.uri, false);
    for (const [id, thread] of this.threads) {
      if (thread.uri.toString() === document.uri.toString()) {
        const line = thread.range.start.line;
        let anchorText = '';
        if (line < document.lineCount) {
          anchorText = document.lineAt(line).text;
        }
        this.stateManager.updateThreadRecord(id, rec => {
          rec.line = line;
          rec.anchorText = anchorText;
        });
      }
    }
  }

  /**
   * Dispose a specific thread.
   */
  disposeThread(id: string): void {
    const thread = this.threads.get(id);
    if (thread) {
      try { thread.dispose(); } catch { /* */ }
      this.threads.delete(id);
      this.stateManager.removeThreadRecord(id);
    }
  }

  /**
   * Dispose all threads.
   */
  disposeAllThreads(): void {
    for (const [id, thread] of this.threads) {
      try { thread.dispose(); } catch { /* */ }
    }
    this.threads.clear();
  }

  /**
   * Dispose the controller and all threads.
   */
  dispose(): void {
    this.disposeAllThreads();
    this.controller.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  /**
   * Find a thread that contains a comment with the given quizId.
   */
  findThreadByQuizId(quizId: string): { thread: vscode.CommentThread; comment: LFComment; id: string } | undefined {
    for (const [id, thread] of this.threads) {
      const comments = thread.comments as LFComment[];
      const comment = comments.find(c => c.quizId === quizId);
      if (comment) return { thread, comment, id };
    }
    return undefined;
  }

  /**
   * Find a pending quiz comment in a thread.
   */
  findPendingQuiz(thread: vscode.CommentThread): LFComment | undefined {
    return (thread.comments as LFComment[]).find(
      c => c.contextValue === 'quiz-pending'
    );
  }
}
