import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyExchange, resolveRpcIds } from '../src/lib/rpc-ids.js';

const randomId = () => 'id' + Math.random().toString(36).slice(2, 8);

test('ids are discovered from observed exchanges, never assumed', () => {
  const generateId = randomId();
  const uploadId = randomId();
  const { ids, sources, problems } = resolveRpcIds({
    observations: [
      { rpcid: randomId(), request: '[["me"],[[["person.photo"]],null,[1]]]', response: '[]' },
      { rpcid: generateId, request: '[["prompt",1]]', response: '[[["https://flow-content.google/x"]]]' },
      { rpcid: uploadId, request: 'a'.repeat(500), response: '[]' },
    ],
    fallback: {},
  });
  assert.equal(ids.generateImage, generateId);
  assert.equal(ids.uploadImage, uploadId);
  assert.equal(sources.generateImage, 'discovered');
  assert.deepEqual(problems.filter((p) => p.startsWith('generateImage') || p.startsWith('uploadImage')), []);
});

test('a changed id is discovered from the new page, not from the old constant', () => {
  const changed = randomId();
  const { ids, sources } = resolveRpcIds({
    observations: [{ rpcid: changed, request: '[["prompt",1]]', response: '[[["https://flow-content.google/x"]]]' }],
    fallback: { generateImage: 'oldGenerateId' },
  });
  assert.equal(ids.generateImage, changed);
  assert.equal(sources.generateImage, 'discovered');
});

test('when discovery fails the configured fallback is used and named', () => {
  const fallback = { generateImage: randomId(), uploadImage: randomId(), textToVideo: randomId(), imageToVideo: randomId(), checkVideo: randomId(), getMedia: randomId(), credits: randomId() };
  const { ids, sources, problems } = resolveRpcIds({ observations: [], fallback });
  assert.deepEqual(ids, fallback);
  assert.ok(Object.values(sources).every((source) => source === 'fallback'));
  assert.deepEqual(problems, []);
});

test('when both fail every missing id is named', () => {
  const { problems } = resolveRpcIds({ observations: [], fallback: { generateImage: randomId() } });
  assert.ok(problems.some((p) => p.startsWith('uploadImage:')));
  assert.ok(problems.some((p) => p.startsWith('textToVideo:')));
  assert.ok(!problems.some((p) => p.startsWith('generateImage:')));
});

test('classification does not depend on any fixed id', () => {
  assert.equal(classifyExchange({ rpcid: randomId(), request: 'x', response: 'flow-content.google' }), 'generateImage');
  assert.equal(classifyExchange({ rpcid: randomId(), request: 'a'.repeat(500) }), 'uploadImage');
  assert.equal(classifyExchange({ rpcid: randomId(), request: '', response: '[[123]]' }), 'credits');
  assert.equal(classifyExchange({ rpcid: randomId(), request: 'unremarkable' }), null);
});

const backgroundSource = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
const flowExecSource = readFileSync(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');

test('the page receives the configured fallback and the start probe names a failure', () => {
  assert.match(backgroundSource, /rpcFallback: flowSettings\.rpcIds/, 'configured ids travel to the page');
  assert.match(backgroundSource, /Account probe failed:/, 'a failed probe names itself at start');
  assert.match(flowExecSource, /no id was observed on the page and no fallback is configured/, 'an unresolved id reports what was tried');
  assert.doesNotMatch(flowExecSource, /const RPC = \{\s*\n\s*generateImage: '/, 'no RPC map is hard-coded in the page command');
});
