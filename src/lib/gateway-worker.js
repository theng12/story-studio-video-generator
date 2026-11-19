// Gateway Studio worker mode — pure mapping between a gateway job and a queue
// item. Standalone rows stay untouched; the queue processor only sees ordinary
// items, with gateway ones tagged by gatewayJobId.

// The Gateway owns the claim truth: it holds a job whose worker has been silent past its own
// advertised `leaseSeconds` (GET /api/workers/health). The local claim marker is only a guard
// against claiming twice, so it expires on that same clock instead of waiting for a person.
// An unreadable lease (`leaseSeconds` undefined — health could not be read) is never treated as
// expired: we cannot prove Gateway let the job go. One settle window is added so our marker
// never expires before Gateway's own reaper.
export const GATEWAY_CLAIM_SETTLE_SECONDS = 30;
export function claimMarkerIsStale(marker, leaseSeconds, now = Date.now()) {
  if (!marker || typeof marker !== 'object') return false;
  const at = Number(marker.at);
  // A marker with no usable time cannot be proven old, so it is never judged stale here. The
  // caller stamps one on first sight, which bounds it to one lease from then.
  if (!Number.isFinite(at) || at <= 0) return false;
  const lease = Number(leaseSeconds);
  if (!Number.isFinite(lease) || lease <= 0) return false; // lease unknown: hold, never guess
  return now - at > (lease + GATEWAY_CLAIM_SETTLE_SECONDS) * 1000;
}

export const GATEWAY_KINDS = Object.freeze(['video']);
const JOB_FIELDS = new Set(['jobId', 'kind', 'prompt', 'videoMode', 'modelKey', 'modelLabel', 'durationSec', 'resolution', 'aspectRatio', 'referenceImages', 'flowProjectId']);

export function createGatewayWorkerId() {
  if (globalThis.crypto?.randomUUID) return `worker_${crypto.randomUUID()}`;
  return `worker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeGatewayJob(job) {
  const jobId = String(job?.jobId || '').trim();
  if (!jobId) throw new Error('Gateway job has no id.');
  const kind = String(job?.kind || 'video');
  if (!GATEWAY_KINDS.includes(kind)) throw new Error(`Gateway job kind ${kind} is not supported.`);
  const prompt = String(job?.prompt || '').trim();
  if (!prompt) throw new Error('Gateway job has no prompt.');
  const modelKey = String(job?.modelKey || '').trim();
  if (!modelKey) throw new Error('Gateway job has no model key.');
  if (!['text', 'image'].includes(job?.videoMode)) throw new Error('Gateway video source is not supported.');
  // Only 16:9 has a captured Flow aspect value. Refuse 9:16 at claim rather than
  // accept work this extension cannot submit without guessing a paid enum.
  if (job?.aspectRatio !== '16:9') throw new Error('Gateway video aspect ratio is not supported — only 16:9 is captured for Flow.');
  if (!Number.isSafeInteger(job?.durationSec) || job.durationSec <= 0) throw new Error('Gateway video duration is unavailable.');
  const videoMode = job.videoMode;
  const references = (Array.isArray(job?.referenceImages) ? job.referenceImages : [])
    .map((reference) => ({
      mediaType: String(reference?.mediaType || 'image/png'),
      dataBase64: String(reference?.dataBase64 || ''),
    }))
    .filter((reference) => reference.dataBase64);
  if (videoMode === 'image' && references.length !== 1) throw new Error('Gateway image-to-video needs exactly one reference image.');
  if (videoMode === 'text' && references.length) throw new Error('Gateway text-to-video does not accept reference images.');
  return {
    jobId,
    kind,
    prompt,
    videoMode,
    modelKey,
    modelLabel: String(job?.modelLabel || modelKey),
    durationSec: Math.max(0, Number(job?.durationSec) || 0),
    // Priced, not yet transmitted: resolution has no captured Flow request field.
    resolution: String(job?.resolution || ''),
    aspectRatio: '16:9',
    references,
    flowProjectId: String(job?.flowProjectId || '').trim(),
    // Future controls stay inert until their counterpart/request mapping exists.
    unmappedFields: structuredClone(Object.fromEntries(Object.entries(job).filter(([key]) => !JOB_FIELDS.has(key)))),
  };
}

export function gatewayJobToItem(job, settings) {
  const normalized = normalizeGatewayJob(job);
  const projectId = String(normalized.flowProjectId || settings?.flowProjectId || '').trim();
  if (!projectId) throw new Error('Gateway job has no Flow project id.');
  return {
    id: `gateway_${normalized.jobId}`,
    status: 'pending',
    phase: 'queued',
    queuedAt: Date.now(),
    slug: 'gateway',
    projectName: 'Gateway Studio',
    episodeCode: normalized.jobId.slice(0, 8),
    episodeTitle: '',
    sceneId: `gateway_${normalized.jobId}`,
    label: `Gateway · ${normalized.jobId.slice(0, 8)}`,
    motionPrompt: normalized.prompt,
    imagePrompt: normalized.prompt,
    durationSec: normalized.durationSec,
    resolution: normalized.resolution,
    unmappedFields: normalized.unmappedFields,
    projectId,
    videoModelKey: normalized.modelKey,
    videoModelLabel: normalized.modelLabel,
    videoModelSource: 'gateway',
    videoMode: normalized.videoMode,
    videoSource: normalized.videoMode === 'image'
      ? (normalized.references.length ? 'existing' : 'generate')
      : null,
    imageModel: settings?.imageModel,
    aspectRatio: normalized.aspectRatio,
    target: 'gateway',
    gatewayJobId: normalized.jobId,
  };
}

export function isGatewayJobQueued(queue, jobId) {
  return (Array.isArray(queue) ? queue : []).some((item) => item.gatewayJobId === jobId);
}
