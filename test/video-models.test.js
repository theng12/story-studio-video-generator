import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FALLBACK_VIDEO_MODELS,
  inventoryResult,
  migrateLegacyVideoModel,
  normalizeVideoInventory,
  resolveVideoModel,
  snapshotVideoModel,
  upgradeStoredVideoSettings,
} from '../src/lib/video-models.js';

test('normalizes only exact provider keys paired with distinct labels', () => {
  assert.deepEqual(
    normalizeVideoInventory([
      { key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' },
      { key: 'veo_4_i2v_fast', label: 'Duplicate' },
      { key: 'Made Up Model', label: 'Made Up Model' },
      { key: 'veo_4_i2v_quality', label: '' },
    ]),
    [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }]
  );
});

test('uses live inventory only for a signed Flow project and fallback otherwise', () => {
  assert.deepEqual(inventoryResult([{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }], { signedIn: true, projectId: 'project-id' }), {
    source: 'live',
    models: [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }],
  });
  assert.deepEqual(inventoryResult([]), { source: 'fallback', models: FALLBACK_VIDEO_MODELS });
  assert.deepEqual(inventoryResult([{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }], { signedIn: false, projectId: 'project-id' }), { source: 'fallback', models: FALLBACK_VIDEO_MODELS });
  assert.deepEqual(inventoryResult([{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }], { signedIn: true, projectId: '' }), { source: 'fallback', models: FALLBACK_VIDEO_MODELS });
});

test('resolves exact selections and refuses unknown or malformed keys', () => {
  const models = [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }];
  assert.deepEqual(resolveVideoModel('veo_4_i2v_fast', models), models[0]);
  assert.throws(() => resolveVideoModel('Veo 4 Fast', models), /exact Flow model/);
  assert.throws(() => resolveVideoModel('veo_3_1_i2v_fast', models), /not available/);
});

test('migrates only the four previously shipped model choices', () => {
  assert.deepEqual(migrateLegacyVideoModel('veo-3.1-fast'), {
    key: 'veo_3_1_i2v_fast',
    label: 'Veo 3.1 Fast',
  });
  assert.throws(() => migrateLegacyVideoModel('future-display-name'), /legacy video model/);
});

test('upgrades raw stored settings before defaults can hide the legacy field', () => {
  assert.deepEqual(upgradeStoredVideoSettings({ videoModel: 'veo-3.1-fast', theme: 'dark' }), {
    videoModelKey: 'veo_3_1_i2v_fast',
    videoModelLabel: 'Veo 3.1 Fast',
    videoModelSource: 'fallback',
    theme: 'dark',
  });
  assert.deepEqual(upgradeStoredVideoSettings({ videoModel: 'unknown-old-value' }), {});
});

test('Flow exposes one read-only video inventory operation and no model fallback at submission', async () => {
  const source = await readFile(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');
  assert.match(source, /listVideoModels/);
  assert.match(source, /signedIn/);
  assert.match(source, /videoModelKey:\s*payload\.modelKey/);
  assert.doesNotMatch(source, /I2V_MODELS\[.*\]\s*\|\|/);
  assert.doesNotMatch(source, /transportKey/);
  assert.doesNotMatch(source, /script\[type=.*application\/json/);
});

test('queue snapshots exact model metadata and removes provider state', async () => {
  const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /videoModelKey:\s*model\.key/);
  assert.match(source, /videoModelLabel:\s*model\.label/);
  assert.doesNotMatch(source, /videoProvider:/);
});

test('snapshotVideoModel returns executable exact queue metadata and refuses stale selections', () => {
  const models = [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }];
  assert.deepEqual(snapshotVideoModel('veo_4_i2v_fast', models, 'live'), {
    videoModelKey: 'veo_4_i2v_fast',
    videoModelLabel: 'Veo 4 Fast',
    videoModelSource: 'live',
  });
  assert.throws(() => snapshotVideoModel('removed_key', models, 'live'), /not available/);
});

test('panel identifies live or fallback inventory and has an explicit refresh action', async () => {
  const html = await readFile(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  assert.match(html, /id="modelInventoryState"/);
  assert.match(html, /id="refreshModels"/);
  assert.doesNotMatch(html, /id="videoProvider"/);
});
