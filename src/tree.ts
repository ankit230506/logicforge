// tree.ts – Side view tree data provider

import * as vscode from 'vscode';
import { StateManager } from './state';
import { readConfig } from './config';

class TreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public children: TreeItem[] = [],
    public fileUri?: vscode.Uri,
    public fileLine?: number
  ) {
    super(label, collapsibleState);
    if (fileUri) {
      this.command = {
        title: 'Open File',
        command: 'vscode.open',
        arguments: [fileUri, { selection: new vscode.Range(fileLine || 0, 0, fileLine || 0, 0) }],
      };
    }
  }
}

export class LogicForgeTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private stateManager: StateManager;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.getRootNodes();
    }
    return element.children;
  }

  private getRootNodes(): TreeItem[] {
    const config = readConfig();
    const state = this.stateManager.getState();
    const roots: TreeItem[] = [];

    // Current Context
    const contextChildren: TreeItem[] = [];
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
      contextChildren.push(new TreeItem(`File: ${relPath}`, vscode.TreeItemCollapsibleState.None));
      contextChildren.push(new TreeItem(`Language: ${editor.document.languageId}`, vscode.TreeItemCollapsibleState.None));
      const parts = relPath.replace(/\\/g, '/').split('/');
      parts.pop();
      contextChildren.push(new TreeItem(`Folder: ${parts.join('/') || '(root)'}`, vscode.TreeItemCollapsibleState.None));
    }
    contextChildren.push(new TreeItem(`Mode: ${config.mode}`, vscode.TreeItemCollapsibleState.None));
    roots.push(new TreeItem('Current Context', vscode.TreeItemCollapsibleState.Expanded, contextChildren));

    // Project Summary
    const projectChildren: TreeItem[] = [];
    if (state.plan) {
      projectChildren.push(new TreeItem(`Plan: ${state.plan.name}`, vscode.TreeItemCollapsibleState.None));
      projectChildren.push(new TreeItem(`Summary: ${state.plan.summary}`, vscode.TreeItemCollapsibleState.None));
      for (const mod of state.plan.modules) {
        const statusIcon = mod.status === 'done' ? '✓' : '○';
        projectChildren.push(new TreeItem(`${statusIcon} ${mod.title}`, vscode.TreeItemCollapsibleState.None));
      }
      // Key decisions
      const decisions = state.decisionLog.slice(-3);
      for (const d of decisions) {
        projectChildren.push(new TreeItem(`Decision: ${d.concept} → ${d.userChoice}`, vscode.TreeItemCollapsibleState.None));
      }
    } else {
      projectChildren.push(new TreeItem('No plan yet. Use /plan to start.', vscode.TreeItemCollapsibleState.None));
    }
    roots.push(new TreeItem('Project Summary', vscode.TreeItemCollapsibleState.Expanded, projectChildren));

    // Recent Conversation
    const recentChildren: TreeItem[] = [];
    const records = this.stateManager.getThreadRecords();
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const recentUserMessages = records
      .flatMap(r => r.comments
        .filter(c => c.role === 'user')
        .map(c => ({ text: c.text, time: c.time, relPath: r.relPath, line: r.line }))
      )
      .slice(-8);

    for (const msg of recentUserMessages) {
      const label = `${msg.time} ${msg.text.substring(0, 50)}`;
      const uri = wsRoot ? vscode.Uri.joinPath(wsRoot, msg.relPath) : undefined;
      recentChildren.push(new TreeItem(label, vscode.TreeItemCollapsibleState.None, [], uri, msg.line));
    }
    if (recentChildren.length === 0) {
      recentChildren.push(new TreeItem('No conversations yet.', vscode.TreeItemCollapsibleState.None));
    }
    roots.push(new TreeItem('Recent Conversation', vscode.TreeItemCollapsibleState.Collapsed, recentChildren));

    return roots;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
