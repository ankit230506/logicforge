const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test');
const outDir = path.join(root, 'out', 'test');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const files = fs.readdirSync(testDir).filter(name => name.endsWith('.test.ts')).sort();
if (!files.length) throw new Error('No unit test files found in test/');
for (const file of files) {
  esbuild.buildSync({ entryPoints: [path.join(testDir, file)], outfile: path.join(outDir, file.replace(/\.ts$/, '.js')), bundle: true, platform: 'node', format: 'cjs', target: 'node18' });
}
const paths = files.map(file => path.join(outDir, file.replace(/\.ts$/, '.js')));
const result = spawnSync(process.execPath, ['--test', ...paths], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
