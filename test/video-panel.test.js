import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ambiguityRetryCopy } from '../src/lib/video-panel.js';

test('describes the billed retry action for image and video ambiguity', () => {
  assert.match(ambiguityRetryCopy({ ambiguityKind: 'image' }).confirmLabel, /Regenerate image/);
  assert.match(ambiguityRetryCopy({ ambiguityKind: 'image' }).body, /fresh start image/);
  assert.match(ambiguityRetryCopy({ ambiguityKind: 'video' }).confirmLabel, /Resubmit video/);
  assert.match(ambiguityRetryCopy({ ambiguityKind: 'video' }).body, /paid video/);
});

// Runs real functions out of popup.js. Pass every function the one under test calls: the module
// hoists them together, so extracting only one leaves its siblings undefined. A hand-kept list lags
// the tree — that skew once shipped a previous artifact whose own suite was red (row 20261122-272) —
// so the list is checked: any popup function the extracted code calls must be listed or provided.
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'with', 'for']);

function extractPanelFunction(source, name) {
  return source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
}

function panelCallsMissing(source, names, sandbox) {
  const listed = new Set([names].flat());
  const provided = new Set(Object.keys(sandbox));
  const missing = new Set();
  for (const name of listed) {
    const fn = extractPanelFunction(source, name);
    if (!fn) continue;
    for (const [, called] of fn.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (KEYWORDS.has(called) || listed.has(called) || provided.has(called)) continue;
      if (extractPanelFunction(source, called)) missing.add(called);
    }
  }
  return [...missing];
}

async function callPanelFunction(name, sandbox) {
  const names = [name].flat();
  const source = await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  const missing = panelCallsMissing(source, names, sandbox);
  assert.deepEqual(missing, [], `list these popup functions the test calls, or provide them: ${missing.join(', ')}`);
  const fns = names.map((n) => {
    const fn = extractPanelFunction(source, n);
    assert.ok(fn, `Actual panel function ${n} is missing.`);
    return fn;
  });
  return runInNewContext(`${fns.join('\n')}\n${names.at(-1)}()`, sandbox);
}

test('the relay render is safe before settings load (fresh profile)', async () => {
  const panel = await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  const fn = extractPanelFunction(panel, 'renderGatewayRelayState');
  assert.ok(fn);
  assert.doesNotThrow(() => runInNewContext(`${fn}\nrenderGatewayRelayState()`, {
    settings: undefined, gatewayToken: '', gatewayRelay: { machineId: '', readiness: null },
    $: () => ({ className: '', textContent: '' }),
  }));
});

test('the panel harness names every popup function a test forgot to list', async () => {
  const panel = await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  const missing = panelCallsMissing(panel, 'changeWorkingMode', {});
  assert.ok(missing.includes('loadGatewayRelayState'), 'the 1.3.29 skew must be caught');
  assert.ok(missing.includes('saveGatewaySettings'));
  const everyPopupFunction = Object.fromEntries(
    [...panel.matchAll(/(?:async )?function ([A-Za-z_$][\w$]*)\(/g)].map(([, n]) => [n, 1]));
  assert.deepEqual(panelCallsMissing(panel, 'changeWorkingMode', everyPopupFunction), []);
});

test('Gateway panel preserves authenticated worker id and saving does not claim work', async () => {
  let patch;
  let sent = 0;
  await callPanelFunction('saveGatewaySettings', {
    settings: { gatewayWorkerId: 'stale-id' }, gatewayToken: '',
    $: (id) => ({ value: id === 'gatewayUrl' ? 'http://127.0.0.1:8787' : 'fixture-token' }),
    async saveSettings(value) { patch = value; return { gatewayWorkerId: 'authenticated-worker', ...value }; },
    saveGatewayToken: async () => {}, getGatewayToken: async () => 'fixture-token',
    chrome: { runtime: { async sendMessage() { sent++; } } }, renderGatewaySettings() {},
  });
  assert.equal(Object.hasOwn(patch, 'gatewayWorkerId'), false);
  assert.equal(sent, 0);
});

test('Gateway panel displays claim failure instead of announcing success', async () => {
  let success = false;
  await assert.rejects(() => callPanelFunction('claimGatewayNow', {
    saveGatewaySettings: async () => {},
    chrome: { runtime: { sendMessage: async () => ({ ok: false, error: 'Claim outcome is held.' }) } },
    async pollQueue() { success = true; }, setStatus() { success = true; },
  }), /Claim outcome is held/);
  assert.equal(success, false);
});

test('Gateway panel refreshes the worker identity after a successful connection check', async () => {
  let refreshed = false;
  const sandbox = {
    settings: { gatewayWorkerId: 'stale-id' }, saveGatewaySettings: async () => {}, setStatus() {},
    chrome: { runtime: { sendMessage: async () => ({ ok: true }) } },
    getSettings: async () => ({ gatewayWorkerId: 'authenticated-worker' }),
    renderGatewaySettings() { refreshed = true; },
  };
  await callPanelFunction('testGatewayConnection', sandbox);
  assert.equal(sandbox.settings.gatewayWorkerId, 'authenticated-worker'); assert.equal(refreshed, true);
});

test('Gateway panel starts polling when the user explicitly selects Gateway mode', async () => {
  const events = [];
  await callPanelFunction(['loadGatewayRelayState', 'changeWorkingMode'], {
    settings: {}, $: () => ({ value: 'gateway' }), saveSettings: async (value) => value,
    async saveGatewaySettings() { events.push('saved'); },
    chrome: {
      runtime: { async sendMessage(message) { events.push(message.type); return { ok: true }; } },
      storage: { local: { async get() { events.push('relayState'); return {}; } } },
    },
    renderWorkingMode() {}, renderVideoMode() {}, renderGatewayRelayState() {}, setStatus() {},
  });
  assert.deepEqual(events, ['saved', 'gatewayModeChanged', 'relayState']);
});
