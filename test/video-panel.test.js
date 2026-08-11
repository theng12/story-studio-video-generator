import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ambiguityRetryCopy, isCurrentLoad, sceneEnqueueContext } from '../src/lib/video-panel.js';

test('discards a slow Story Studio response after the selection changes', () => {
  assert.equal(isCurrentLoad(1, 2, { slug: 'old', episodeCode: 'E1' }, { slug: 'new', episodeCode: 'E2' }), false);
  assert.equal(isCurrentLoad(2, 2, { slug: 'new', episodeCode: 'E2' }, { slug: 'new', episodeCode: 'E2' }), true);
});

test('captures immutable project, episode, and scenes for a later enqueue', () => {
  const context = sceneEnqueueContext({ slug: 'p', name: 'Project' }, { code: 'E1', title: 'Episode' }, [{ id: 's1' }]);
  assert.deepEqual(context, { slug: 'p', projectName: 'Project', episodeCode: 'E1', episodeTitle: 'Episode', scenes: [{ id: 's1' }] });
});

test('describes the billed retry action for image and video ambiguity', () => {
  assert.match(ambiguityRetryCopy({ ambiguityKind: 'image' }).confirmLabel, /Regenerate image/);
  assert.match(ambiguityRetryCopy({ ambiguityKind: 'image' }).body, /fresh start image/);
  assert.match(ambiguityRetryCopy({ ambiguityKind: 'video' }).confirmLabel, /Resubmit video/);
  assert.match(ambiguityRetryCopy({ ambiguityKind: 'video' }).body, /paid video/);
});

test('captures the scene-load token before the asynchronous review request', async () => {
  const source = await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  assert.match(source, /async function loadScenes\(\)[\s\S]*?const token = \+\+storyLoadToken;[\s\S]*?await studio\.sceneReview/);
});
