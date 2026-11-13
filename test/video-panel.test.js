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

async function callPanelFunction(name, sandbox) {
  const source = await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  const fn = source.match(new RegExp(`async function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(fn, `Actual panel function ${name} is missing.`);
  return runInNewContext(`${fn}\n${name}()`, sandbox);
}

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
  await callPanelFunction('changeWorkingMode', {
    settings: {}, $: () => ({ value: 'gateway' }), saveSettings: async (value) => value,
    async saveGatewaySettings() { events.push('saved'); },
    chrome: { runtime: { async sendMessage(message) { events.push(message.type); return { ok: true }; } } },
    renderWorkingMode() {}, renderVideoMode() {}, setStatus() {},
  });
  assert.deepEqual(events, ['saved', 'gatewayModeChanged']);
});
