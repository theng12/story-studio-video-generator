import test from 'node:test';
import assert from 'node:assert/strict';
import { FLEET_QUEUE_ACTIONS, classifyInterruptedItem, eligibleVideoScenes, hasActiveDuplicate, isAllowedFleetQueueAction, migrateStoredQueue, standaloneDownloadPath } from '../src/lib/video-rules.js';
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
  assert.deepEqual(classifyInterruptedItem({ phase: 'downloading' }), { status: 'pending', phase: 'downloading' });
});
test('migrates persistent legacy queue items without replaying uncertain work', () => {
  const { queue } = migrateStoredQueue([{ id: 'known', status: 'running', phase: 'submitting', videoMediaId: 'video/1', videoModel: 'unknown', workflowId: 'dead' }, { id: 'uncertain', status: 'running', phase: 'submitting', videoModel: 'veo-3.1-fast' }, { id: 'legacy', status: 'pending', phase: 'queued', videoModel: 'veo-3.1-fast', videoProvider: 'workspace' }, { id: 'unknown', status: 'pending', phase: 'queued', videoModel: 'unmapped' }]);
  assert.equal(queue[0].videoMediaId, 'video/1'); assert.equal(queue[0].workflowId, undefined); assert.equal(queue[1].status, 'ambiguous'); assert.equal(queue[2].videoModelKey, 'veo_3_1_i2v_fast'); assert.equal(queue[3].status, 'failed');
});
test('deduplicates only active equivalent work including generation settings', () => {
  const item = { slug: 'p', episodeCode: 'E1', sceneId: 's1', videoModelKey: 'veo_x', aspectRatio: '16:9', videoSource: 'existing' };
  assert.equal(hasActiveDuplicate([{ ...item, status: 'pending' }], item), true); assert.equal(hasActiveDuplicate([{ ...item, status: 'done' }], item), false); assert.equal(hasActiveDuplicate([{ ...item, status: 'running', videoModelKey: 'veo_y' }], item), false);
});
test('selects only Story Studio scenes eligible for video', () => {
  const review = { animate_min_seconds: 4, scenes: [{ id: 'ok', scene_index: 1, approved: true, image_filename: '1.png', motion_prompt: 'pan', start_sec: 0, end_sec: 4 }, { id: 'short', scene_index: 2, approved: true, image_filename: '2.png', motion_prompt: 'pan', start_sec: 0, end_sec: 3 }, { id: 'blank', scene_index: 3, approved: true, image_filename: '3.png', motion_prompt: ' ', start_sec: 0, end_sec: 5 }] };
  assert.deepEqual(eligibleVideoScenes(review).map((scene) => scene.id), ['ok']);
});
test('uses a stable standalone Downloads path', () => assert.equal(standaloneDownloadPath('standalone_abc_01'), 'StoryStudioVideos/Standalone/standalone_abc_01.mp4'));
test('allows only consent-scoped Fleet queue commands', () => { assert.deepEqual(FLEET_QUEUE_ACTIONS, ['pause_after_current', 'resume_hub_pause', 'clear_pending']); assert.equal(isAllowedFleetQueueAction('change_model'), false); });
test('removes proven-dead video state', async () => {
  const sources = await Promise.all(['../src/lib/config.js', '../src/lib/flow-exec.js', '../src/background.js'].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const source of sources) { assert.doesNotMatch(source, /\bvideoProvider\b/); assert.doesNotMatch(source, /\bsaveTarget\b/); assert.doesNotMatch(source, /\bworkflowId\b/); assert.doesNotMatch(source, /\bremainingCredits\b/); }
});
