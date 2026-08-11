export const FALLBACK_VIDEO_MODELS = Object.freeze([
  { key: 'abra_i2v_4s', label: 'Omni Flash - 4 seconds' },
  { key: 'abra_i2v_6s', label: 'Omni Flash - 6 seconds' },
  { key: 'abra_i2v_8s', label: 'Omni Flash - 8 seconds' },
  { key: 'abra_i2v_10s', label: 'Omni Flash - 10 seconds' },
  { key: 'veo_3_1_i2v_lite', label: 'Veo 3.1 Lite' },
  { key: 'veo_3_1_i2v_fast', label: 'Veo 3.1 Fast' },
  { key: 'veo_3_1_i2v_quality', label: 'Veo 3.1 Quality' },
]);

const EXACT_KEY = /^[a-z0-9][a-z0-9_.-]{2,127}$/;
const LEGACY = Object.freeze({
  'omni-flash': { key: 'abra_i2v_4s', label: 'Omni Flash - 4 seconds' },
  'veo-3.1-lite': { key: 'veo_3_1_i2v_lite', label: 'Veo 3.1 Lite' },
  'veo-3.1-fast': { key: 'veo_3_1_i2v_fast', label: 'Veo 3.1 Fast' },
  'veo-3.1-quality': { key: 'veo_3_1_i2v_quality', label: 'Veo 3.1 Quality' },
});

export function normalizeVideoInventory(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const key = String(entry?.key || '').trim();
    const label = String(entry?.label || '').trim();
    if (!EXACT_KEY.test(key) || !label || label === key || seen.has(key)) return [];
    seen.add(key);
    return [{ key, label }];
  });
}

export function inventoryResult(entries, context = {}) {
  const models = normalizeVideoInventory(entries);
  return models.length && context.signedIn === true && String(context.projectId || '').trim()
    ? { source: 'live', models }
    : { source: 'fallback', models: FALLBACK_VIDEO_MODELS };
}

export function resolveVideoModel(key, models) {
  const exact = String(key || '').trim();
  if (!EXACT_KEY.test(exact)) throw new Error('Select an exact Flow model before queueing.');
  const match = normalizeVideoInventory(models).find((model) => model.key === exact);
  if (!match) throw new Error('The selected Flow model is not available in the current inventory. Refresh models and choose again.');
  return match;
}

export function migrateLegacyVideoModel(value) {
  const match = LEGACY[String(value || '')];
  if (!match) throw new Error('Unknown legacy video model. Refresh Flow models and choose again.');
  return { ...match };
}

export function snapshotVideoModel(key, models, source) {
  const model = resolveVideoModel(key, models);
  return {
    videoModelKey: model.key,
    videoModelLabel: model.label,
    videoModelSource: source === 'live' ? 'live' : 'fallback',
  };
}

export function upgradeStoredVideoSettings(raw) {
  const stored = { ...(raw || {}) };
  const legacyValue = stored.videoModel;
  delete stored.videoModel;
  delete stored['video' + 'Provider'];
  delete stored['save' + 'Target'];
  if (stored.videoModelKey || !legacyValue) return stored;
  try {
    const model = migrateLegacyVideoModel(legacyValue);
    return { ...stored, videoModelKey: model.key, videoModelLabel: model.label, videoModelSource: 'fallback' };
  } catch {
    return stored;
  }
}
