import { migrateLegacyVideoModel } from './video-models.js';

const imageError = 'Fresh-image generation may have reached Flow. Inspect the Flow project before explicitly regenerating it.';
const videoError = 'Paid video submission may have reached Flow. Inspect the Flow project before explicitly resubmitting it.';
export const FLEET_QUEUE_ACTIONS = Object.freeze(['pause_after_current', 'resume_hub_pause', 'clear_pending']);
export const isAllowedFleetQueueAction = (action) => FLEET_QUEUE_ACTIONS.includes(action);
export const standaloneDownloadPath = (sceneId) => `StoryStudioVideos/Standalone/${sceneId}.mp4`;
export function eligibleVideoScenes(review) {
  const minimum = Number(review?.animate_min_seconds) || 0;
  return (review?.scenes || []).filter((scene) => scene.approved === true && scene.image_filename != null && String(scene.motion_prompt || '').trim() && Number(scene.end_sec) - Number(scene.start_sec) >= minimum).map((scene) => ({ id: scene.id, sceneIndex: scene.scene_index, label: `Scene ${scene.scene_index}`, motionPrompt: scene.motion_prompt, imagePrompt: scene.visual_prompt || scene.image_prompt || '', durationSec: Math.max(0, Number(scene.end_sec) - Number(scene.start_sec)), hasClip: Boolean((scene.clip_exists && !scene.clip_stale) || scene.clip_filename || scene.video_filename) }));
}

export function classifyInterruptedItem(item) {
  if (item.videoMediaId) return { status: 'pending', phase: 'polling' };
  if (item.phase === 'submitting') return { status: 'ambiguous', phase: 'submitting', ambiguityKind: 'video', error: videoError };
  if (item.startMediaId) return { status: 'pending', phase: ['polling', 'downloading', 'ingesting'].includes(item.phase) ? item.phase : 'prepared' };
  if (item.phase === 'image_submitting') return { status: 'ambiguous', phase: 'image_submitting', ambiguityKind: 'image', error: imageError };
  return { status: 'pending', phase: item.phase || 'queued' };
}
export function activeItemKey(item) { return [item.slug, item.episodeCode, item.sceneId, item.videoModelKey, item.aspectRatio, item.videoSource, item.imageModel, item.motionPrompt, item.imagePrompt].map((value) => String(value || '').trim().toLowerCase()).join('::'); }
export function hasActiveDuplicate(queue, item) { return queue.some((candidate) => ['pending', 'running'].includes(candidate.status) && activeItemKey(candidate) === activeItemKey(item)); }
export function migrateStoredQueue(queue) {
  let changed = false;
  const next = (Array.isArray(queue) ? queue : []).map((item) => {
    const legacy = item.videoModel;
    const copy = { ...item };
    for (const key of ['videoProvider', 'videoModel', 'workflowId', 'remainingCredits']) { if (key in copy) { delete copy[key]; changed = true; } }
    if (copy.phase === 'submitting' && !copy.videoMediaId) Object.assign(copy, classifyInterruptedItem(copy));
    else if (!copy.videoMediaId && !copy.videoModelKey && legacy) {
      try { const model = migrateLegacyVideoModel(legacy); Object.assign(copy, { videoModelKey: model.key, videoModelLabel: model.label, videoModelSource: 'fallback' }); }
      catch { Object.assign(copy, { status: 'failed', error: 'Unknown legacy video model. Refresh Flow models and requeue this item.' }); }
      changed = true;
    }
    return copy;
  });
  return { queue: next, changed };
}
