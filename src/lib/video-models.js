// Video model catalog for the current Google Flow app.
//
// Historical references from the prior implementation, not current transport
// evidence. Preserve their model/length selections without authorizing paid work.
// Current executable mappings require live evidence; UI-only observations cannot
// supply provider keys, payload fields or a request binding.
export const FALLBACK_VIDEO_MODELS = Object.freeze([
  { key: 'macaron_cookie_t2v_4s', label: 'Omni 1.2 Flash - 4 seconds', mode: 'text', durationSec: 4 },
  { key: 'abra_t2v_8s', label: 'Omni Flash - 8 seconds', mode: 'text', durationSec: 8 },
  { key: 'macaron_cookie_r2v_3s', label: 'Omni 1.2 Flash - 3 seconds', mode: 'image', durationSec: 3 },
  { key: 'abra_r2v_10s', label: 'Omni Flash - 10 seconds', mode: 'image', durationSec: 10 },
]);

const EXACT_KEY = /^[a-z0-9][a-z0-9_.-]{2,127}$/;

export function normalizeVideoInventory(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const key = String(entry?.key || '').trim();
    const label = String(entry?.label || '').trim();
    if (!EXACT_KEY.test(key) || !label || label === key || seen.has(key)) return [];
    seen.add(key);
    const duration = Number.isSafeInteger(entry?.durationSec) && entry.durationSec > 0
      ? { durationSec: entry.durationSec } : {};
    return [{ key, label, mode: entry?.mode === 'text' ? 'text' : 'image', ...duration }];
  });
}

export function modelsForMode(models, mode = 'image') {
  return normalizeVideoInventory(models).filter((model) => model.mode === mode);
}

export function defaultVideoModel(mode = 'image') {
  return FALLBACK_VIDEO_MODELS.find((model) => model.mode === mode) || FALLBACK_VIDEO_MODELS[0];
}

export function inventoryResult(entries, context = {}) {
  const models = normalizeVideoInventory(entries);
  return models.length && context.signedIn === true && String(context.projectId || '').trim()
    ? { source: 'live', models }
    : { source: 'fallback', models: FALLBACK_VIDEO_MODELS };
}

export function resolveVideoModel(key, models, mode = 'image') {
  const exact = String(key || '').trim();
  if (!EXACT_KEY.test(exact)) throw new Error('Select an exact Flow model before queueing.');
  const match = modelsForMode(models, mode).find((model) => model.key === exact);
  if (!match) throw new Error('The selected Flow model is not available for this video source. Refresh models and choose again.');
  return match;
}

export function snapshotVideoModel(key, models, source, mode = 'image', durationSec) {
  const model = resolveVideoModel(key, models, mode);
  if (!Number.isSafeInteger(durationSec) || durationSec <= 0) {
    throw new Error('Select a positive whole-second clip length before queueing.');
  }
  if (!model.durationSec || durationSec !== model.durationSec) {
    throw new Error(`Video duration does not match a captured request for this model (${model.durationSec ? `${model.durationSec}s captured` : 'length unknown'}). The selected ${durationSec}s request is unavailable; nothing was submitted.`);
  }
  return {
    videoModelKey: model.key,
    videoModelLabel: model.label,
    videoModelSource: source === 'live' ? 'live' : 'fallback',
    durationSec,
    videoModelBinding: {
      modelKey: model.key,
      mode,
      durationSec,
      rpcId: mode === 'text' ? 'YhhmEf' : 'MZZa6b',
      inventorySource: source === 'live' ? 'live' : 'fallback',
    },
  };
}

// The pre-1.2 catalog is retired with the old Flow REST API. Drop the legacy
// fields so normalize() can select a model from the current catalog.
export function upgradeStoredVideoSettings(raw) {
  const stored = { ...(raw || {}) };
  delete stored.videoModel;
  delete stored['video' + 'Provider'];
  delete stored['save' + 'Target'];
  return stored;
}
