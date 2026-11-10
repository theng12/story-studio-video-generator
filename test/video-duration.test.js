import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { FALLBACK_VIDEO_MODELS, snapshotVideoModel, normalizeVideoInventory } from '../src/lib/video-models.js';
import { getSettings, saveSettings } from '../src/lib/config.js';
import { activeItemKey } from '../src/lib/video-rules.js';

for (const mode of ['text', 'image']) {
  test(`${mode} selections preserve each captured duration and RPC binding`, () => {
    const models = FALLBACK_VIDEO_MODELS.filter((model) => model.mode === mode);
    assert.equal(new Set(models.map((model) => model.durationSec)).size, 2);
    for (const model of models) {
      const snapshot = snapshotVideoModel(model.key, models, 'fallback', mode, model.durationSec);
      assert.equal(snapshot.durationSec, model.durationSec);
      assert.deepEqual(snapshot.videoModelBinding, {
        modelKey: model.key, mode, durationSec: model.durationSec,
        rpcId: mode === 'text' ? 'YhhmEf' : 'MZZa6b',
      });
      assert.throws(() => snapshotVideoModel(model.key, models, 'fallback', mode, 6), /unavailable/);
      assert.throws(() => snapshotVideoModel(model.key, models, 'fallback', mode), /clip length/);
    }
  });
}

test('UI label and key suffix cannot manufacture a duration binding', () => {
  const entries = normalizeVideoInventory([{ key: 'fixture_unverified_6s', label: 'Model · 6 seconds', mode: 'text' }]);
  assert.equal(entries[0].durationSec, undefined);
  assert.throws(() => snapshotVideoModel(entries[0].key, entries, 'live', 'text', 6), /length unknown/);
});

test('model and length choices survive save/reload including unavailable live selections', async (t) => {
  const original = globalThis.chrome;
  const state = {};
  globalThis.chrome = { storage: { sync: {
    async get(key) { return structuredClone({ [key]: state[key] }); },
    async set(values) { Object.assign(state, structuredClone(values)); },
  } } };
  t.after(() => { globalThis.chrome = original; });
  for (const model of FALLBACK_VIDEO_MODELS) {
    await saveSettings({ videoMode: model.mode, videoModelKey: model.key, videoModelLabel: model.label, videoDurationSec: model.durationSec });
    const reloaded = await getSettings();
    assert.equal(reloaded.videoModelKey, model.key);
    assert.equal(reloaded.videoDurationSec, model.durationSec);
  }
  await saveSettings({ videoModelKey: 'fixture_live_model', videoModelLabel: 'Saved live model', videoModelSource: 'live', videoDurationSec: 6 });
  const reloaded = await getSettings();
  assert.equal(reloaded.videoModelKey, 'fixture_live_model');
  assert.equal(reloaded.videoModelLabel, 'Saved live model');
  assert.equal(reloaded.videoModelSource, 'live');
  assert.equal(reloaded.videoDurationSec, 6);
});

test('duplicate detection distinguishes selected clip lengths', () => {
  const row = { sceneId: 'same-scene', videoModelKey: 'fixture_live_model', durationSec: 4 };
  assert.notEqual(activeItemKey(row), activeItemKey({ ...row, durationSec: 6 }));
});

test('popup refresh preserves unavailable model and length; enqueue snapshot uses current length', async () => {
  const nodes = new Map();
  const element = () => ({ value: '', textContent: '', options: [], attrs: {},
    replaceChildren(...options) { this.options = options; },
    setAttribute(key, value) { this.attrs[key] = value; },
    get selectedOptions() { return this.options.filter((option) => option.value === this.value); },
  });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, addEventListener() {} };
  const sandbox = { document, FALLBACK_VIDEO_MODELS, modelsForMode: (models, mode) => models.filter((model) => model.mode === mode),
    Option: function(text, value) { this.textContent = text; this.value = value; },
  };
  const source = (await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8')).replace(/^import .+;\n/gm, '');
  vm.runInNewContext(source + `\nsettings = { videoMode: 'text', videoModelKey: 'unavailable_model', videoModelLabel: 'Saved choice', videoDurationSec: 6 }; renderModelInventory({ source: 'fallback', models: FALLBACK_VIDEO_MODELS }); globalThis.snapshot = modelSnapshot();`, sandbox);
  assert.equal(document.getElementById('videoModel').value, 'unavailable_model');
  assert.equal(document.getElementById('videoDurationSec').value, 6);
  assert.equal(sandbox.snapshot.durationSec, 6);
  assert.equal(sandbox.snapshot.videoModelKey, 'unavailable_model');
  assert.match(document.getElementById('videoDurationState').textContent, /unavailable/);
  assert.match(document.getElementById('modelInventoryState').textContent, /availability is unknown/);
});
