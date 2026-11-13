import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const flowExec = readFileSync(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');
const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

test('a visibly signed-in Flow page claims when the account probe fails', () => {
  assert.match(flowExec, /visibleSignedIn/, 'the probe checks the visible signed-in page');
  assert.match(flowExec, /flow\.visible-signed-in/, 'the fallback account is labelled as a visible sign-in');
  assert.match(flowExec, /fallback \? 'flow\.visible-signed-in' : 'extension\.video'/, 'the source says which probe produced it');
});

test('the panel names a failed account read instead of looking signed out', () => {
  assert.match(background, /could not read the account .*Retrying on the next check/, 'the failure names itself and retries');
});
