import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_VIDEO_MODELS,
  inventoryResult,
  migrateLegacyVideoModel,
  normalizeVideoInventory,
  resolveVideoModel,
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

test('uses live inventory when trustworthy entries exist and fallback otherwise', () => {
  assert.deepEqual(inventoryResult([{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }]), {
    source: 'live',
    models: [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }],
  });
  assert.deepEqual(inventoryResult([]), { source: 'fallback', models: FALLBACK_VIDEO_MODELS });
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
