import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, getSettings, saveSettings } from '../src/lib/config.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function settingsFixture(run, stored = {}) {
  const previous = globalThis.chrome;
  const state = { videoSettings: structuredClone(stored) };
  globalThis.chrome = { storage: { sync: {
    async get(key) { return { [key]: structuredClone(state[key]) }; },
    async set(values) { Object.assign(state, structuredClone(values)); },
  } } };
  try { await run(state); } finally { globalThis.chrome = previous; }
}

test('new settings use 5–15 seconds; profile identity starts unknown', async () => {
  await settingsFixture(async () => {
    const settings = await getSettings();
    assert.equal(settings.humanDelayMinSec, 5);
    assert.equal(settings.humanDelayMaxSec, 15);
    assert.equal(settings.providerAccountProfileId, '');
    assert.equal(DEFAULTS.humanDelayMaxSec, 15);
  });
});

for (const [minimum, maximum] of [[0, 0], [5, 60], [23, 91]]) {
  test(`existing custom pause ${minimum}–${maximum} survives unrelated save/reload`, async () => {
    await settingsFixture(async () => {
      await saveSettings({ theme: 'dark' });
      const settings = await getSettings();
      assert.equal(settings.humanDelayMinSec, minimum);
      assert.equal(settings.humanDelayMaxSec, maximum);
    }, { humanDelayMinSec: minimum, humanDelayMaxSec: maximum });
  });
}

test('root settings load and save the same pacing and account fields', async () => {
  await settingsFixture(async () => {
    const nodes = new Map();
    const checkboxes = new Set(['fleetEnabled', 'fleetTelemetryConsent', 'fleetQueueControlConsent']);
    const document = { addEventListener() {}, getElementById(id) {
      if (!nodes.has(id)) {
        let value = '';
        nodes.set(id, { get value() { return value; }, set value(next) { value = String(next); },
          type: checkboxes.has(id) ? 'checkbox' : 'text', checked: false, tagName: 'INPUT', style: {}, addEventListener() {} });
      }
      return nodes.get(id);
    } };
    const source = (await readFile(new URL('../src/options/options.js', import.meta.url), 'utf8'))
      .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '');
    const sandbox = { document, DEFAULTS, getSettings, saveSettings, initTheme: async () => {},
      getCredentials: async () => ({}), getFleetCredentials: async () => ({}),
      saveCredentials: async () => {}, saveFleetCredentials: async () => {},
      setTimeout: () => 0, clearTimeout() {}, URL,
      chrome: { permissions: { contains: async () => false }, storage: { local: { get: async () => ({}) } },
        runtime: { sendMessage: async () => ({}) } },
    };
    await vm.runInNewContext(source + '\nload()', sandbox);
    assert.equal(document.getElementById('humanDelayMinSec').value, '5');
    assert.equal(document.getElementById('humanDelayMaxSec').value, '15');
    document.getElementById('humanDelayMinSec').value = '0';
    document.getElementById('humanDelayMaxSec').value = '0';
    document.getElementById('providerAccountProfileId').value = 'shared-profile';
    await vm.runInNewContext('save()', sandbox);
    assert.match(document.getElementById('status').textContent, /Saved/);
    const saved = await getSettings();
    assert.equal(saved.humanDelayMinSec, 0);
    assert.equal(saved.humanDelayMaxSec, 0);
    assert.equal(saved.providerAccountProfileId, 'shared-profile');
  });
});

test('root input values normalize, persist and retain configured profile identity', async () => {
  await settingsFixture(async () => {
    await saveSettings({ humanDelayMinSec: '12', humanDelayMaxSec: '7', providerAccountProfileId: '  shared-profile-1  ' });
    let settings = await getSettings();
    assert.equal(settings.humanDelayMinSec, 7);
    assert.equal(settings.humanDelayMaxSec, 12);
    assert.equal(settings.providerAccountProfileId, 'shared-profile-1');
    await saveSettings({ humanDelayMinSec: '-2', humanDelayMaxSec: '9000', providerAccountProfileId: 'x'.repeat(180) });
    settings = await getSettings();
    assert.equal(settings.humanDelayMinSec, 0);
    assert.equal(settings.humanDelayMaxSec, 3600);
    assert.equal(settings.providerAccountProfileId.length, 160);
  });
});
