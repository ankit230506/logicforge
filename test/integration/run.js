const path = require('path');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.join(__dirname, 'suite.js');
  const workspacePath = path.join(__dirname, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  // @vscode/test-electron uses shell=true on Windows; quote each path flag so
  // directories containing spaces survive command-line parsing.
  await runTests({ extensionDevelopmentPath: `"${extensionDevelopmentPath}"`, extensionTestsPath: `"${extensionTestsPath}"`, launchArgs: [`"${workspacePath}"`, '--disable-workspace-trust'], extensionTestsEnv: { LOGICFORGE_TEST: '1' } });
})().catch(error => { console.error(error); process.exit(1); });
