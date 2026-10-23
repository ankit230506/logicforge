import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTags } from '../src/parser';
import { validateAsk, validateBuildChat, validatePlan } from '../src/validators';
import { validateRelativePath, resolveAndContain } from '../src/sandbox';
import { normalizeConcept, evaluateQuiz } from '../src/quiz';
import { computeBudget } from '../src/budget';
import { findAnchorLine } from '../src/anchors';
import { getCommentStyle, formatWhyComment } from '../src/commentSyntax';
import { renderHistory, countExistingSections } from '../src/history';
import { truncateContext } from '../src/context';
import { getDemoM1FileContent, getDemoM3FindText, ScriptedLlm } from '../src/demo';

test('tag parser handles tags, fences, raw code, and rejects malformed responses', () => {
  const tags = parseTags('```xml\n<say>Raw < and { stay text</say>\n<plan name="n" summary="s"><module id="1" title="t" goal="g"/><module id="2" title="u" goal="g"/><module id="3" title="v" goal="g"/></plan>\n```');
  assert.equal(tags[0].body, 'Raw < and { stay text');
  assert.equal(validatePlan(tags).valid, true);
  assert.throws(() => parseTags('<unknown/>'), /Unknown tag/);
  assert.throws(() => parseTags('<say>unfinished'), /Unclosed tag/);
});
test('ASK validator requires exactly three options and correctness explanation', () => {
  const ask = parseTags('<ask><q>Pick</q><opt id="A">One</opt><opt id="B">Two</opt><opt id="C">Three</opt><correct>B</correct><why>Because</why></ask>');
  assert.equal(validateAsk(ask).valid, true);
  assert.equal(validateAsk(parseTags('<ask><q>Pick</q><opt id="A">One</opt><correct>A</correct><why>x</why></ask>')).valid, false);
});
test('build validation and sandbox reject unsafe paths', () => {
  assert.equal(validateBuildChat(parseTags('<file path="src/a.py">pass</file>')).valid, true);
  for (const p of ['../x', '..\\x', 'C:\\x', '\\\\host\\share', '.git/config', '.logicforge/x', 'node_modules/x']) assert.equal(validateRelativePath(p).valid, false, p);
  assert.equal(resolveAndContain(process.cwd(), 'src/a.py').valid, true);
});
test('quiz, mode, and anchor helpers handle normalization and moved anchors', () => {
  assert.equal(normalizeConcept(' Hash-Maps '), 'hash map');
  assert.equal(evaluateQuiz('B', 'B', [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }, { id: 'C', text: 'z' }], 'why').isCorrect, true);
  assert.equal(computeBudget('sprint', 0).explanationLength, 'short');
  assert.equal(findAnchorLine(['a', 'changed', 'target', 'd'], 1, 'target'), 2);
});
test('comment syntax, history numbering, and context truncation', () => {
  assert.ok(getCommentStyle('.py'));
  assert.match(formatWhyComment('value is set', '.py', '    ', '\r\n'), /\r\n$/);
  assert.equal(countExistingSections('### 1. A\n### 2. B'), 2);
  assert.match(renderHistory({ project: 'P', sections: [{ title: 'A', items: [{ text: 'why' }] }] }, '', 'now'), /### 1\. A/);
  assert.ok(truncateContext('x'.repeat(100), 40).length <= 40);
});
test('demo age-validation edit matches exactly one location and scripted responses parse', async () => {
  const file = getDemoM1FileContent();
  const needle = getDemoM3FindText();
  assert.equal(file.split(needle).length - 1, 1);
  const llm = new ScriptedLlm();
  const outputs = [
    await llm.complete([{ role: 'user', content: 'Break it into 3-6 small modules' }]),
    await llm.complete([{ role: 'user', content: 'Write ONE question with exactly 3 plausible options' }]),
    await llm.complete([{ role: 'user', content: 'Write the code for THIS module only Student storage' }]),
  ];
  assert.equal(validatePlan(parseTags(outputs[0].text)).valid, true);
  assert.equal(validateAsk(parseTags(outputs[1].text)).valid, true);
  assert.equal(validateBuildChat(parseTags(outputs[2].text)).valid, true);
});
