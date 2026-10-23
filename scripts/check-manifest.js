const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const ids = manifest.contributes.commands.map(command => command.command);
for (const id of ids) if (!source.includes(`'${id}'`)) throw new Error(`Command is not registered: ${id}`);
const registered = [...source.matchAll(/registerCommand\('([^']+)'/g)].map(match => match[1]);
for (const id of registered) if (!ids.includes(id)) throw new Error(`Registered command is not declared: ${id}`);
for (const menu of Object.values(manifest.contributes.menus || {})) for (const item of menu) if (!ids.includes(item.command)) throw new Error(`Menu command is not declared: ${item.command}`);
const config = fs.readFileSync(path.join(root, 'src', 'config.ts'), 'utf8');
const manifestKeys = Object.keys(manifest.contributes.configuration.properties);
const code = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
for (const key of manifestKeys) {
  const relative = key.replace(/^logicforge\./, '');
  const codeKey = relative === 'checkpoint.keepWhyComments' ? 'checkpoint.keepWhyComments' : relative;
  if (!config.includes(`'${codeKey}'`) && !code.includes(`'${codeKey}'`)) throw new Error(`Manifest config key missing in code: ${key}`);
}
const codeSettingNames = [...config.matchAll(/(?:\.get<[^>]+>\(|updateConfig\()'([^']+)'/g)].map(match => match[1]);
for (const name of new Set(codeSettingNames)) {
  const key = `logicforge.${name}`;
  if (!manifestKeys.includes(key)) throw new Error(`Config key read in code is not declared: ${key}`);
}
if (!fs.existsSync(path.join(root, manifest.main))) throw new Error(`Main bundle does not exist: ${manifest.main}`);
console.log(`Manifest OK: ${ids.length} commands, ${manifestKeys.length} settings.`);
