import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULTS, flowWorkspace, normalizeFlowWorkspaceUrl } from '../src/lib/config.js';

test('Flow lives at the fixed address whatever is stored', () => {
  assert.equal(DEFAULTS.flowWorkspaceUrl, 'https://flow.google.com');
  for (const value of ['', 'not a url', 'http://flow.google.com', 'https://flow.google.com/project/abc?x=1', 'https://example.com:8443/app']) {
    assert.equal(normalizeFlowWorkspaceUrl(value), 'https://flow.google.com');
  }
  const workspace = flowWorkspace({ flowWorkspaceUrl: 'https://example.com/' });
  assert.deepEqual(
    [workspace.origin, workspace.url, workspace.match, workspace.project('abc')],
    ['https://flow.google.com', 'https://flow.google.com/', 'https://flow.google.com/*', 'https://flow.google.com/project/abc']
  );
});

test('options page has no Flow address field and the code uses the fixed address', async () => {
  const html = await readFile(new URL('../src/options/options.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /flowWorkspaceUrl|flowGrant|Google Flow/i);
  assert.equal(normalizeFlowWorkspaceUrl('https://flow.example.com'), 'https://flow.google.com');
});
