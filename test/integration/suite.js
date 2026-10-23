const vscode = require('vscode');
const assert = require('assert');

async function activateExtension() {
  const ext = vscode.extensions.getExtension('local.logicforge');
  assert.ok(ext, 'LogicForge extension is present');
  const api = await ext.activate();
  assert.ok(api, 'test API is returned');
  return api;
}

async function run() {
  const api = await activateExtension();
  const root = vscode.workspace.workspaceFolders[0].uri;
  await vscode.workspace.getConfiguration('logicforge').update('demoMode', true, vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('logicforge').update('mode', 'balanced', vscode.ConfigurationTarget.Workspace);
  const uri = vscode.Uri.joinPath(root, 'main.py');
  await vscode.workspace.fs.writeFile(uri, new Uint8Array());
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const thread = api.createThread(uri, 0);
  await api.reply(thread, '/plan student management CLI in Python');
  assert.equal(api.getState().plan.name, 'Student CLI Management');
  await vscode.commands.executeCommand('logicforge.nextModule');
  const threads = [...api.getThreads().values()];
  const quizThread = threads.find(candidate => candidate.comments.some(comment => comment.contextValue === 'quiz-pending'));
  assert.ok(quizThread, 'a decision point produces a pending quiz');
  const quiz = quizThread.comments.find(comment => comment.contextValue === 'quiz-pending');
  assert.match(quiz.body.value || quiz.body, /\*\*A\)\*\* List/);
  await api.reply(quizThread, 'A');
  assert.ok(quizThread.comments.some(comment => /Better choice: Dictionary/.test(comment.body.value || comment.body)), 'wrong answer explains the correct option');
  const rootThread = quizThread;
  const exists = async relative => vscode.workspace.fs.stat(vscode.Uri.joinPath(root, relative)).then(() => true, () => false);
  assert.equal(await exists('src/models.py'), true);
  assert.equal(await exists('src/student_manager.py'), true);
  assert.equal(await exists('.logicforge/memory/src.md'), true);
  const managerUri = vscode.Uri.joinPath(root, 'src/student_manager.py');
  const manager = await vscode.workspace.openTextDocument(managerUri);
  await vscode.window.showTextDocument(manager);
  const chat = api.createThread(managerUri, 0);
  await api.reply(chat, 'why a dict here?');
  assert.ok(chat.comments.some(comment => /O\(1\).*lookup/i.test(comment.body.value || comment.body)));
  await vscode.commands.executeCommand('logicforge.checkpoint');
  assert.equal(await exists('.logicforge/history.md'), true);
  assert.equal(await exists('.logicforge/checkpoints'), true);
  assert.ok(api.getThreads().size === 0, 'checkpoint removes included threads');
  const updated = await vscode.workspace.openTextDocument(managerUri);
  assert.match(updated.getText(), /# why:/);
  void rootThread;
  return true;
}

module.exports = { run };
