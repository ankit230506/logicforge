// state.ts – Persistent state management via workspace.fs

import * as vscode from 'vscode';

export interface ModuleState {
  id: string;
  title: string;
  goal: string;
  decision: string;  // "true" or "false"
  concept: string;
  status: 'todo' | 'done';
}

export interface DecisionLogEntry {
  module: string;
  concept: string;
  question: string;
  options: { id: string; text: string }[];
  userChoice: string;
  correctId: string;
  reason: string;
  timestamp: string;
  exported: boolean;
}

export interface ProjectState {
  project: {
    name: string;
    brief: string;
  };
  plan: {
    name: string;
    summary: string;
    modules: ModuleState[];
  } | null;
  currentModuleIndex: number;
  quizzesAsked: number;
  knownConcepts: string[];
  decisionLog: DecisionLogEntry[];
  checkpoints: number;
  filesCreatedThisSession: string[];
}

export interface ThreadRecord {
  id: string;
  relPath: string;
  line: number;
  anchorText: string;
  comments: {
    role: 'user' | 'agent';
    text: string;
    time: string;
    quizId?: string;
  }[];
}

const DEFAULT_STATE: ProjectState = {
  project: { name: '', brief: '' },
  plan: null,
  currentModuleIndex: 0,
  quizzesAsked: 0,
  knownConcepts: [],
  decisionLog: [],
  checkpoints: 0,
  filesCreatedThisSession: [],
};

export class StateManager {
  private state: ProjectState = { ...DEFAULT_STATE };
  private threads: ThreadRecord[] = [];
  private workspaceRoot: vscode.Uri;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceRoot: vscode.Uri) {
    this.workspaceRoot = workspaceRoot;
  }

  private get logicforgeDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceRoot, '.logicforge');
  }

  private get stateFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.logicforgeDir, 'state.json');
  }

  private get threadsFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.logicforgeDir, 'threads.json');
  }

  async init(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.logicforgeDir);
    } catch { /* already exists */ }

    // Create .gitignore for logicforge dir
    const gitignore = vscode.Uri.joinPath(this.logicforgeDir, '.gitignore');
    try {
      await vscode.workspace.fs.stat(gitignore);
    } catch {
      const content = 'state.json\nthreads.json\n';
      await vscode.workspace.fs.writeFile(gitignore, Buffer.from(content, 'utf-8'));
    }

    await this.loadState();
    await this.loadThreads();
  }

  private async loadState(): Promise<void> {
    try {
      const data = await vscode.workspace.fs.readFile(this.stateFile);
      const parsed = JSON.parse(Buffer.from(data).toString('utf-8'));
      this.state = { ...DEFAULT_STATE, ...parsed };
    } catch {
      this.state = { ...DEFAULT_STATE, filesCreatedThisSession: [] };
    }
  }

  private async loadThreads(): Promise<void> {
    try {
      const data = await vscode.workspace.fs.readFile(this.threadsFile);
      this.threads = JSON.parse(Buffer.from(data).toString('utf-8'));
    } catch {
      this.threads = [];
    }
  }

  getState(): ProjectState {
    return this.state;
  }

  getThreadRecords(): ThreadRecord[] {
    return this.threads;
  }

  updateState(updates: Partial<ProjectState>): void {
    Object.assign(this.state, updates);
    this.scheduleSave();
  }

  setThreadRecords(records: ThreadRecord[]): void {
    this.threads = records;
    this.scheduleSave();
  }

  updateThreadRecord(id: string, updater: (rec: ThreadRecord) => void): void {
    const rec = this.threads.find(t => t.id === id);
    if (rec) {
      updater(rec);
      this.scheduleSave();
    }
  }

  addThreadRecord(record: ThreadRecord): void {
    // Remove existing record with same id
    this.threads = this.threads.filter(t => t.id !== record.id);
    this.threads.push(record);
    this.scheduleSave();
  }

  removeThreadRecord(id: string): void {
    this.threads = this.threads.filter(t => t.id !== id);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.saveAll(), 300);
  }

  async saveAll(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await vscode.workspace.fs.createDirectory(this.logicforgeDir);
      await vscode.workspace.fs.writeFile(
        this.stateFile,
        Buffer.from(JSON.stringify(this.state, null, 2), 'utf-8')
      );
      await vscode.workspace.fs.writeFile(
        this.threadsFile,
        Buffer.from(JSON.stringify(this.threads, null, 2), 'utf-8')
      );
    } catch (e) {
      console.error('LogicForge: Failed to save state:', e);
    }
  }

  // Memory file management
  async readMemory(folderKey: string): Promise<string> {
    const memDir = vscode.Uri.joinPath(this.logicforgeDir, 'memory');
    const file = vscode.Uri.joinPath(memDir, `${folderKey}.md`);
    try {
      const data = await vscode.workspace.fs.readFile(file);
      return Buffer.from(data).toString('utf-8');
    } catch {
      return '';
    }
  }

  async writeMemory(folderKey: string, content: string): Promise<void> {
    const memDir = vscode.Uri.joinPath(this.logicforgeDir, 'memory');
    try {
      await vscode.workspace.fs.createDirectory(memDir);
    } catch { /* */ }
    const file = vscode.Uri.joinPath(memDir, `${folderKey}.md`);
    // Cap at 25 lines
    const lines = content.split('\n');
    const capped = lines.length > 25 ? lines.slice(lines.length - 25) : lines;
    await vscode.workspace.fs.writeFile(file, Buffer.from(capped.join('\n'), 'utf-8'));
  }

  async appendMemory(folderKey: string, text: string): Promise<void> {
    const existing = await this.readMemory(folderKey);
    const newContent = existing ? existing.trimEnd() + '\n' + text : text;
    await this.writeMemory(folderKey, newContent);
  }

  /**
   * Get folder key from a relative folder path.
   * Root = "_root", otherwise replace "/" with "__".
   */
  static folderKey(relFolderPath: string): string {
    const normalized = relFolderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized || normalized === '.') return '_root';
    return normalized.replace(/\//g, '__');
  }

  async resetSession(): Promise<void> {
    this.state = { ...DEFAULT_STATE, filesCreatedThisSession: [] };
    this.threads = [];
    await this.saveAll();
  }

  async readHistory(): Promise<string> {
    const file = vscode.Uri.joinPath(this.logicforgeDir, 'history.md');
    try {
      const data = await vscode.workspace.fs.readFile(file);
      return Buffer.from(data).toString('utf-8');
    } catch {
      return '';
    }
  }

  async writeHistory(content: string): Promise<void> {
    const file = vscode.Uri.joinPath(this.logicforgeDir, 'history.md');
    await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf-8'));
  }

  async writeCheckpoint(filename: string, content: string): Promise<void> {
    const dir = vscode.Uri.joinPath(this.logicforgeDir, 'checkpoints');
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch { /* */ }
    const file = vscode.Uri.joinPath(dir, filename);
    await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf-8'));
  }
}
