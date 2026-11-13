import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInterruptedItem, hasActiveDuplicate, migrateStoredQueue, standaloneDownloadPath } from '../src/lib/video-rules.js';
import { readFile } from 'node:fs/promises';

test('quarantines interrupted fresh-image submission without a media id', () => {
  assert.deepEqual(classifyInterruptedItem({ phase: 'image_submitting' }), { status: 'ambiguous', phase: 'image_submitting', ambiguityKind: 'image', error: 'Fresh-image generation may have reached Flow. Inspect the Flow project before explicitly regenerating it.' });
});
test('resumes safely after a saved image or known video media id', () => {
  assert.deepEqual(classifyInterruptedItem({ phase: 'image_submitting', startMediaId: 'img/1' }), { status: 'pending', phase: 'prepared' });
  assert.deepEqual(classifyInterruptedItem({ phase: 'submitting', videoMediaId: 'video/1' }), { status: 'pending', phase: 'polling' });
});
test('quarantines unknown paid video submission and requeues non-paid phases', () => {
  assert.equal(classifyInterruptedItem({ phase: 'submitting' }).ambiguityKind, 'video');
  assert.equal(classifyInterruptedItem({ phase: 'submitting', videoMode: 'text' }).ambiguityKind, 'video');
  assert.deepEqual(classifyInterruptedItem({ phase: 'downloading' }), { status: 'pending', phase: 'downloading' });
});
test('migrates persistent legacy queue items without replaying uncertain work', () => {
  const { queue } = migrateStoredQueue([{ id: 'known', status: 'running', phase: 'submitting', videoMediaId: 'video/1', videoModel: 'unknown', workflowId: 'dead' }, { id: 'uncertain', status: 'running', phase: 'submitting', videoModel: 'veo-3.1-fast' }, { id: 'legacy', status: 'pending', phase: 'queued', videoModel: 'veo-3.1-fast', videoProvider: 'workspace' }, { id: 'unknown', status: 'pending', phase: 'queued', videoModel: 'unmapped' }]);
  assert.equal(queue[0].videoMediaId, 'video/1'); assert.equal(queue[0].workflowId, undefined); assert.equal(queue[1].status, 'ambiguous'); assert.equal(queue[2].status, 'failed'); assert.equal(queue[2].videoModelKey, undefined); assert.equal(queue[3].status, 'failed');
});
test('modern unknown submission migration is persisted once and then stable', () => {
  const first = migrateStoredQueue([{ id: 'modern', videoMode: 'text', videoModelKey: 'current', status: 'running', phase: 'submitting' }]);
  assert.equal(first.changed, true);
  assert.equal(first.queue[0].status, 'ambiguous');
  assert.equal(first.queue[0].ambiguityKind, 'video');
  assert.equal(migrateStoredQueue(first.queue).changed, false);
  const active = migrateStoredQueue([{ id: 'active', videoMode: 'text', videoModelKey: 'current', status: 'running', phase: 'submitting', target: 'download' }], { recoverSubmissions: false });
  assert.equal(active.changed, false);
  assert.equal(active.queue[0].status, 'running');
});

test('deduplicates only active equivalent work including generation settings', () => {
  const item = { slug: 'p', episodeCode: 'E1', sceneId: 's1', videoMode: 'image', videoModelKey: 'veo_x', aspectRatio: '16:9', videoSource: 'existing' };
  assert.equal(hasActiveDuplicate([{ ...item, status: 'pending' }], item), true); assert.equal(hasActiveDuplicate([{ ...item, status: 'done' }], item), false); assert.equal(hasActiveDuplicate([{ ...item, status: 'running', videoModelKey: 'veo_y' }], item), false); assert.equal(hasActiveDuplicate([{ ...item, status: 'pending', videoMode: 'text' }], item), false);
});
test('migrates a removed Story Studio row to a standalone download instead of dropping it', () => {
  const { queue } = migrateStoredQueue([{ id: 'legacy-scene', status: 'pending', phase: 'polling', videoMediaId: 'video/1', sceneId: 'scene-9' }]);
  assert.equal(queue[0].target, 'download');
  assert.equal(queue[0].downloadPath, standaloneDownloadPath('scene-9'));
});
test('uses a stable standalone Downloads path', () => assert.equal(standaloneDownloadPath('standalone_abc_01'), 'StoryStudioVideos/Standalone/standalone_abc_01.mp4'));
test('removes proven-dead video state', async () => {
  const sources = await Promise.all(['../src/lib/config.js', '../src/lib/flow-exec.js', '../src/background.js'].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const source of sources) { assert.doesNotMatch(source, /\bvideoProvider\b/); assert.doesNotMatch(source, /\bsaveTarget\b/); assert.doesNotMatch(source, /\bworkflowId\b/); assert.doesNotMatch(source, /\bremainingCredits\b/); }
});
