const imageError = 'Fresh-image generation may have reached Flow. Inspect the Flow project before explicitly regenerating it.';
const videoError = 'Paid video submission may have reached Flow. Inspect the Flow project before explicitly resubmitting it.';
export const standaloneDownloadPath = (sceneId) => `StoryStudioVideos/Standalone/${sceneId}.mp4`;

export function classifyInterruptedItem(item) {
  if (item.videoMediaId) return { status: 'pending', phase: 'polling' };
  if (item.phase === 'submitting') return { status: 'ambiguous', phase: 'submitting', ambiguityKind: 'video', error: videoError };
  if (item.startMediaId) return { status: 'pending', phase: ['polling', 'downloading'].includes(item.phase) ? item.phase : 'prepared' };
  if (item.phase === 'image_submitting') return { status: 'ambiguous', phase: 'image_submitting', ambiguityKind: 'image', error: imageError };
  return { status: 'pending', phase: item.phase || 'queued' };
}
export function activeItemKey(item) { return [item.slug, item.episodeCode, item.sceneId, item.videoMode || 'image', item.videoModelKey, item.durationSec, item.aspectRatio, item.videoSource, item.imageModel, item.motionPrompt, item.imagePrompt].map((value) => String(value || '').trim().toLowerCase()).join('::'); }
export function hasActiveDuplicate(queue, item) { return queue.some((candidate) => ['pending', 'running'].includes(candidate.status) && activeItemKey(candidate) === activeItemKey(item)); }
export function migrateStoredQueue(queue, { recoverSubmissions = true } = {}) {
  let changed = false;
  const next = (Array.isArray(queue) ? queue : []).map((item) => {
    const legacy = item.videoModel;
    const copy = { ...item };
    for (const key of ['videoProvider', 'videoModel', 'workflowId', 'remainingCredits']) { if (key in copy) { delete copy[key]; changed = true; } }
    if (copy.videoMode !== 'text' && copy.videoMode !== 'image') { copy.videoMode = 'image'; changed = true; }
    // Story Studio rows had no download target. Preserve their bytes/polling by
    // delivering to Standalone Downloads instead of dropping the work.
    if (!copy.gatewayJobId && copy.target !== 'gateway' && copy.target !== 'download') {
      copy.target = 'download';
      copy.downloadPath = copy.downloadPath || standaloneDownloadPath(copy.sceneId || copy.id);
      changed = true;
    }
    if (recoverSubmissions && copy.phase === 'submitting' && !copy.videoMediaId) {
      const recovery = classifyInterruptedItem(copy);
      if (Object.entries(recovery).some(([key, value]) => copy[key] !== value)) {
        Object.assign(copy, recovery);
        changed = true;
      }
    }
    else if (!copy.videoMediaId && !copy.videoModelKey && legacy) {
      Object.assign(copy, { status: 'failed', error: 'Unknown legacy video model. Refresh Flow models and requeue this item.' });
      changed = true;
    }
    return copy;
  });
  return { queue: next, changed };
}
