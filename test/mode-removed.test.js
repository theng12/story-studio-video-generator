import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULTS, getSettings } from '../src/lib/config.js';

async function storedSettings(stored) {
  const previous = globalThis.chrome;
  const state = { videoSettings: structuredClone(stored) };
  globalThis.chrome = { storage: { sync: {
    async get(key) { return { [key]: structuredClone(state[key]) }; },
    async set(values) { Object.assign(state, structuredClone(values)); },
  } } };
  try {
    return { settings: await getSettings(), state };
  } finally {
    globalThis.chrome = previous;
  }
}

test('Standalone is the default mode', () => {
  assert.equal(DEFAULTS.mode, 'standalone');
});

for (const stored of ['studio', 'legacy', null, 42]) {
  test(`stored mode ${JSON.stringify(stored)} silently migrates to standalone`, async () => {
    const { settings, state } = await storedSettings({ mode: stored, studioBaseUrl: 'http://localhost:8766' });
    assert.equal(settings.mode, 'standalone');
    assert.equal(settings.studioBaseUrl, undefined);
    assert.equal(state.videoSettings.mode, 'standalone');
    assert.equal(Object.hasOwn(state.videoSettings, 'studioBaseUrl'), false);
  });
}

test('Gateway Studio survives migration', async () => {
  const { settings } = await storedSettings({ mode: 'gateway' });
  assert.equal(settings.mode, 'gateway');
});

test('no shipped validator or mode menu accepts the removed studio value', async () => {
  const paths = ['../src/lib/config.js', '../src/popup/popup.js', '../src/options/options.js', '../src/options/options.html', '../src/popup/popup.html'];
  for (const path of paths) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"]studio['"]/, `${path} still accepts the removed studio mode`);
  }
  const options = await readFile(new URL('../src/options/options.html', import.meta.url), 'utf8');
  const popup = await readFile(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  assert.match(options, /<select id="mode">\s*<option value="standalone">/);
  assert.match(popup, /<select id="workingMode"[^>]*>\s*<option value="standalone">/);
});
