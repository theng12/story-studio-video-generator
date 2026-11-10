import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FALLBACK_VIDEO_MODELS,
  defaultVideoModel,
  inventoryResult,
  modelsForMode,
  normalizeVideoInventory,
  resolveVideoModel,
  snapshotVideoModel,
  upgradeStoredVideoSettings,
} from '../src/lib/video-models.js';

test('catalog exposes tested models for both video sources', () => {
  assert.equal(modelsForMode(FALLBACK_VIDEO_MODELS, 'text').length, 2);
  assert.equal(modelsForMode(FALLBACK_VIDEO_MODELS, 'image').length, 2);
  assert.equal(defaultVideoModel('text').key, 'macaron_cookie_t2v_4s');
  assert.equal(defaultVideoModel('image').key, 'macaron_cookie_r2v_3s');
  assert.equal(defaultVideoModel('text').mode, 'text');
  assert.equal(defaultVideoModel('image').mode, 'image');
});

test('includes the captured Omni 1.2 Flash keys', () => {
  assert.ok(FALLBACK_VIDEO_MODELS.some((model) => model.key === 'macaron_cookie_t2v_4s' && model.mode === 'text'));
  assert.ok(FALLBACK_VIDEO_MODELS.some((model) => model.key === 'macaron_cookie_r2v_3s' && model.mode === 'image'));
});

test('normalizes only exact provider keys paired with distinct labels', () => {
  assert.deepEqual(
    normalizeVideoInventory([
      { key: 'veo_4_t2v_fast', label: 'Veo 4 Fast', mode: 'text' },
      { key: 'veo_4_t2v_fast', label: 'Duplicate', mode: 'text' },
      { key: 'Made Up Model', label: 'Made Up Model' },
      { key: 'some_key_here', label: '' },
    ]),
    [{ key: 'veo_4_t2v_fast', label: 'Veo 4 Fast', mode: 'text' }]
  );
  assert.deepEqual(
    normalizeVideoInventory([{ key: 'veo_i2v', label: 'Veo Image' }]),
    [{ key: 'veo_i2v', label: 'Veo Image', mode: 'image' }]
  );
});

test('uses live inventory only for a signed Flow project and fallback otherwise', () => {
  const live = inventoryResult(
    [{ key: 'veo_4_t2v_fast', label: 'Veo 4 Fast', mode: 'text' }],
    { signedIn: true, projectId: 'project-id' }
  );
  assert.equal(live.source, 'live');
  assert.deepEqual(inventoryResult([]), { source: 'fallback', models: FALLBACK_VIDEO_MODELS });
  assert.equal(
    inventoryResult([{ key: 'veo_4_t2v_fast', label: 'Veo 4 Fast' }], { signedIn: false, projectId: 'project-id' }).source,
    'fallback'
  );
  assert.equal(
    inventoryResult([{ key: 'veo_4_t2v_fast', label: 'Veo 4 Fast' }], { signedIn: true, projectId: '' }).source,
    'fallback'
  );
});

test('resolves exact selections per video source and refuses mismatches', () => {
  const models = [
    { key: 'veo_t2v', label: 'Veo Text', mode: 'text' },
    { key: 'veo_i2v', label: 'Veo Image', mode: 'image' },
  ];
  assert.deepEqual(resolveVideoModel('veo_t2v', models, 'text'), models[0]);
  assert.throws(() => resolveVideoModel('veo_t2v', models, 'image'), /not available/);
  assert.throws(() => resolveVideoModel('Veo Text', models, 'text'), /exact Flow model/);
});

test('snapshots executable model metadata for the selected source', () => {
  const imageModel = defaultVideoModel('image');
  assert.deepEqual(snapshotVideoModel(imageModel.key, FALLBACK_VIDEO_MODELS, 'fallback', 'image', 3), {
    videoModelKey: imageModel.key,
    videoModelLabel: imageModel.label,
    videoModelSource: 'fallback',
    durationSec: 3,
    videoModelBinding: { modelKey: imageModel.key, mode: 'image', durationSec: 3, rpcId: 'MZZa6b', inventorySource: 'fallback' },
  });
  assert.throws(
    () => snapshotVideoModel(defaultVideoModel('text').key, FALLBACK_VIDEO_MODELS, 'fallback', 'image'),
    /not available/
  );
});

test('drops the retired pre-1.2 settings before defaults apply', () => {
  assert.deepEqual(upgradeStoredVideoSettings({ videoModel: 'veo-3.1-fast', theme: 'dark' }), { theme: 'dark' });
});

test('Flow helper speaks the captured batchexecute contract', async () => {
  const source = await readFile(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');
  assert.match(source, /textToVideo:\s*'YhhmEf'/);
  assert.match(source, /imageToVideo:\s*'MZZa6b'/);
  assert.match(source, /checkVideo:\s*'jwpduf'/);
  assert.match(source, /getMedia:\s*'as29s'/);
  assert.match(source, /AiSandboxAngularFrontend\/data\/batchexecute/);
  assert.doesNotMatch(source, /labs\.google/);
  assert.doesNotMatch(source, /aisandbox-pa/);
});

test('background submits both video sources and fetches the signed media URL', async () => {
  const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /runFlow\(tab\.id, 'submitVideo'/);
  assert.match(source, /runFlow\(tab\.id, 'getMedia'/);
  assert.match(source, /videoMode/);
  assert.doesNotMatch(source, /submitVideoStartImage/);
});

test('panel exposes the video source control and inventory provenance', async () => {
  const html = await readFile(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  assert.match(html, /id="videoMode"/);
  assert.match(html, /id="modelInventoryState"/);
  assert.match(html, /id="refreshModels"/);
});
