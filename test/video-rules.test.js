import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInterruptedItem, hasActiveDuplicate, migrateStoredQueue } from '../src/lib/video-rules.js';

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
