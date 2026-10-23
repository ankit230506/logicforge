// executor.ts – Action executor for folder, file, edit, insert operations

import * as vscode from 'vscode';
import { ParsedTag, findTag } from './parser';
import { validateRelativePath, resolveAndContain, normalizeSeparators } from './sandbox';
import { StateManager } from './state';

export interface ExecutionResult {
  success: boolean;
  filesCreated: string[];
  foldersCreated: string[];
  errors: string[];
}

const isTestMode = () => process.env.LOGICFORGE_TEST === '1';

export async function executeActions(
  tags: ParsedTag[],
  workspaceRoot: vscode.Uri,
  stateManager: StateManager,
  currentThread?: vscode.CommentThread
): Promise<ExecutionResult> {
  const result: ExecutionResult = {
    success: true,
    filesCreated: [],
    foldersCreated: [],
    errors: [],
  };

  // Sort: folder -> file -> edit -> insert
  const folders = tags.filter(t => t.tag === 'folder');
  const files = tags.filter(t => t.tag === 'file');
  const edits = tags.filter(t => t.tag === 'edit');
  const inserts = tags.filter(t => t.tag === 'insert');
  const memories = tags.filter(t => t.tag === 'memory');
  const ordered = [...folders, ...files, ...edits, ...inserts];

  const state = stateManager.getState();

  for (const tag of ordered) {
    if (!result.success) break;

    try {
      if (tag.tag === 'folder') {
        const folderResult = await executeFolder(tag, workspaceRoot, stateManager);
        if (!folderResult.success) {
          result.success = false;
          result.errors.push(...folderResult.errors);
          break;
        }
        result.foldersCreated.push(...folderResult.foldersCreated);
      } else if (tag.tag === 'file') {
        const fileResult = await executeFile(tag, workspaceRoot, state.filesCreatedThisSession, stateManager);
        if (!fileResult.success) {
          result.success = false;
          result.errors.push(...fileResult.errors);
          break;
        }
        result.filesCreated.push(...fileResult.filesCreated);
        // Track files created this session
        for (const f of fileResult.filesCreated) {
          if (!state.filesCreatedThisSession.includes(f)) {
            state.filesCreatedThisSession.push(f);
          }
        }
      } else if (tag.tag === 'edit') {
        const editResult = await executeEdit(tag, workspaceRoot);
        if (!editResult.success) {
          result.success = false;
          result.errors.push(...editResult.errors);
          break;
        }
      } else if (tag.tag === 'insert') {
        if (currentThread) {
          const insertResult = await executeInsert(tag, currentThread);
          if (!insertResult.success) {
            result.success = false;
            result.errors.push(...insertResult.errors);
            break;
          }
        }
      }
    } catch (e) {
      result.success = false;
      result.errors.push(`Error executing <${tag.tag}>: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
  }

  // Process memory tags
  for (const mem of memories) {
    if (mem.body.trim()) {
      // Determine folder from thread or first created folder
      let folderKey = '_root';
      if (currentThread) {
        const relPath = vscode.workspace.asRelativePath(currentThread.uri, false);
        const parts = normalizeSeparators(relPath).split('/');
        parts.pop(); // remove filename
        const folderPath = parts.join('/');
        folderKey = StateManager.folderKey(folderPath);
      } else if (result.foldersCreated.length > 0) {
        folderKey = StateManager.folderKey(result.foldersCreated[0]);
      }
      await stateManager.appendMemory(folderKey, mem.body.trim());
    }
  }

  stateManager.updateState({ filesCreatedThisSession: state.filesCreatedThisSession });
  return result;
}

async function executeFolder(
  tag: ParsedTag,
  workspaceRoot: vscode.Uri,
  stateManager: StateManager
): Promise<ExecutionResult> {
  const result: ExecutionResult = { success: true, filesCreated: [], foldersCreated: [], errors: [] };
  const relPath = tag.attrs.path;
  const check = resolveAndContain(workspaceRoot.fsPath, relPath);
  if (!check.valid) {
    result.success = false;
    result.errors.push(`Invalid folder path "${relPath}": ${check.reason}`);
    return result;
  }

  const uri = vscode.Uri.joinPath(workspaceRoot, ...normalizeSeparators(relPath).split('/'));
  await vscode.workspace.fs.createDirectory(uri);
  result.foldersCreated.push(relPath);

  // Seed memory file if purpose is provided
  if (tag.attrs.purpose) {
    const folderKey = StateManager.folderKey(relPath);
    const existing = await stateManager.readMemory(folderKey);
    if (!existing) {
      await stateManager.writeMemory(folderKey, `Purpose: ${tag.attrs.purpose}`);
    }
  }

  return result;
}

async function executeFile(
  tag: ParsedTag,
  workspaceRoot: vscode.Uri,
  filesCreatedThisSession: string[],
  stateManager: StateManager
): Promise<ExecutionResult> {
  const result: ExecutionResult = { success: true, filesCreated: [], foldersCreated: [], errors: [] };
  const relPath = tag.attrs.path;
  const check = resolveAndContain(workspaceRoot.fsPath, relPath);
  if (!check.valid) {
    result.success = false;
    result.errors.push(`Invalid file path "${relPath}": ${check.reason}`);
    return result;
  }

  const pathParts = normalizeSeparators(relPath).split('/');
  const uri = vscode.Uri.joinPath(workspaceRoot, ...pathParts);

  // Check if file exists
  let exists = false;
  try {
    await vscode.workspace.fs.stat(uri);
    exists = true;
  } catch { /* doesn't exist */ }

  if (exists) {
    const normalizedRel = normalizeSeparators(relPath);
    const createdThisSession = filesCreatedThisSession.some(
      f => normalizeSeparators(f) === normalizedRel
    );
    if (!createdThisSession && !isTestMode()) {
      const choice = await vscode.window.showWarningMessage(
        `Overwrite ${relPath}?`,
        { modal: true },
        'Overwrite'
      );
      if (choice !== 'Overwrite') {
        result.success = false;
        result.errors.push(`Overwrite of ${relPath} declined`);
        return result;
      }
    }
  }

  // Create parent directory
  if (pathParts.length > 1) {
    const dirParts = pathParts.slice(0, -1);
    const dirUri = vscode.Uri.joinPath(workspaceRoot, ...dirParts);
    await vscode.workspace.fs.createDirectory(dirUri);
  }

  // Detect EOL from workspace
  const content = tag.body;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
  result.filesCreated.push(relPath);

  return result;
}

async function executeEdit(
  tag: ParsedTag,
  workspaceRoot: vscode.Uri
): Promise<ExecutionResult> {
  const result: ExecutionResult = { success: true, filesCreated: [], foldersCreated: [], errors: [] };
  const relPath = tag.attrs.path;
  const check = resolveAndContain(workspaceRoot.fsPath, relPath);
  if (!check.valid) {
    result.success = false;
    result.errors.push(`Invalid edit path "${relPath}": ${check.reason}`);
    return result;
  }

  const uri = vscode.Uri.joinPath(workspaceRoot, ...normalizeSeparators(relPath).split('/'));

  // File must exist
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    result.success = false;
    result.errors.push(`File "${relPath}" does not exist for edit`);
    return result;
  }

  const findChild = findTag(tag.children, 'find');
  const replaceChild = findTag(tag.children, 'replace');
  if (!findChild || !replaceChild) {
    result.success = false;
    result.errors.push(`Edit on "${relPath}" missing <find> or <replace>`);
    return result;
  }

  const data = await vscode.workspace.fs.readFile(uri);
  let fileContent = Buffer.from(data).toString('utf-8');

  // Normalize for matching: CRLF -> LF
  const normalizedContent = fileContent.replace(/\r\n/g, '\n');
  const normalizedFind = findChild.body.replace(/\r\n/g, '\n');

  // Check find text occurs exactly once
  const firstIdx = normalizedContent.indexOf(normalizedFind);
  if (firstIdx === -1) {
    result.success = false;
    result.errors.push(`Edit on "${relPath}": find text not found in file`);
    return result;
  }
  const secondIdx = normalizedContent.indexOf(normalizedFind, firstIdx + 1);
  if (secondIdx !== -1) {
    result.success = false;
    result.errors.push(`Edit on "${relPath}": find text occurs more than once`);
    return result;
  }

  // Preserve original EOL style
  const useCRLF = fileContent.includes('\r\n');
  let replaceText = replaceChild.body;
  if (useCRLF) {
    replaceText = replaceText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  }

  // Do the replacement on the original content preserving EOL
  if (useCRLF) {
    const crlfFind = normalizedFind.replace(/\n/g, '\r\n');
    fileContent = fileContent.replace(crlfFind, replaceText);
  } else {
    fileContent = fileContent.replace(normalizedFind, replaceText);
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(fileContent, 'utf-8'));
  return result;
}

async function executeInsert(
  tag: ParsedTag,
  thread: vscode.CommentThread
): Promise<ExecutionResult> {
  const result: ExecutionResult = { success: true, filesCreated: [], foldersCreated: [], errors: [] };

  const uri = thread.uri;
  const doc = await vscode.workspace.openTextDocument(uri);
  const anchorLine = thread.range.start.line;
  const insertLine = Math.min(anchorLine + 1, doc.lineCount);

  const edit = new vscode.WorkspaceEdit();
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const text = tag.body.replace(/\r\n/g, '\n').replace(/\n/g, eol);
  const pos = new vscode.Position(insertLine, 0);
  edit.insert(uri, pos, text + eol);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    result.success = false;
    result.errors.push('Failed to insert text');
  }
  return result;
}
