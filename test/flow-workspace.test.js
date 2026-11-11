import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, flowWorkspace, normalizeFlowWorkspaceUrl } from '../src/lib/config.js';

test('defaults to the current Flow origin', () => {
  assert.equal(DEFAULTS.flowWorkspaceUrl, 'https://flow.google.com');
  assert.equal(normalizeFlowWorkspaceUrl(''), 'https://flow.google.com');
  assert.equal(normalizeFlowWorkspaceUrl('not a url'), 'https://flow.google.com');
});

test('keeps only the https origin so a pasted project URL still works', () => {
  assert.equal(normalizeFlowWorkspaceUrl('https://flow.google.com/project/abc?x=1'), 'https://flow.google.com');
  assert.equal(normalizeFlowWorkspaceUrl('  https://example.com:8443/app  '), 'https://example.com:8443');
  assert.equal(normalizeFlowWorkspaceUrl('http://flow.google.com'), 'https://flow.google.com');
});

test('derives the tab URL, match pattern, and project URL from the setting', () => {
  const workspace = flowWorkspace({ flowWorkspaceUrl: 'https://flow.example.com/' });
  assert.deepEqual(
    [workspace.origin, workspace.url, workspace.match, workspace.project('abc')],
    ['https://flow.example.com', 'https://flow.example.com/', 'https://flow.example.com/*', 'https://flow.example.com/project/abc']
  );
  assert.equal(flowWorkspace({}).origin, DEFAULTS.flowWorkspaceUrl);
});
