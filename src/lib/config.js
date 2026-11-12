import { FALLBACK_VIDEO_MODELS, defaultVideoModel, modelsForMode, upgradeStoredVideoSettings } from './video-models.js';

const DEFAULT_VIDEO_MODEL = defaultVideoModel('image');

// Flow lives at a fixed address now: a move is a code change, not a setting.
export const FLOW_WORKSPACE_URL = 'https://flow.google.com';

export const DEFAULTS = {
  theme: 'system',
  mode: 'studio',
  studioBaseUrl: 'http://localhost:8766',
  flowProjectId: '',
  flowProjectName: '',
  // Where Google Flow lives. Fixed in code since the Flow settings UI was removed.
  flowWorkspaceUrl: FLOW_WORKSPACE_URL,
  // 'text' generates directly from the motion prompt; 'image' starts from a
  // scene/uploaded/generated image. The current Flow app uses a different model
  // key for each, so the mode and model move together.
  videoMode: 'image',
  videoModelKey: DEFAULT_VIDEO_MODEL.key,
  videoModelLabel: DEFAULT_VIDEO_MODEL.label,
  videoModelSource: 'fallback',
  videoDurationSec: DEFAULT_VIDEO_MODEL.durationSec,
  videoSource: 'existing',
  imageModel: 'nano-banana-2',
  aspectRatio: '16:9',
  humanDelayMinSec: 5,
  humanDelayMaxSec: 15,
  providerAccountProfileId: '',
  // A temporary service limit can either pause the queue for review or wait
  // before safely retrying work that never reached paid submission.
  providerCooldown: { autoResume: false, minutes: 15 },
  lastProject: '',
  lastEpisode: '',
  // Third, separate mode: Gateway Studio claims generation jobs from this
  // extension. The token lives in local storage (never sync); the URL and
  // worker id are syncable convenience values.
  gatewayUrl: 'http://127.0.0.1:8787',
  gatewayWorkerId: '',
};

const STORAGE_KEY = 'videoSettings';
const CREDENTIALS_KEY = 'studioCredentials';

export function normalizeFlowProjectId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(
    /(?:\/project\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
  );
  return match ? match[1].toLowerCase() : raw;
}

// The stored flowWorkspaceUrl key stays readable for compatibility but always
// normalizes to the fixed origin.
export function normalizeFlowWorkspaceUrl() {
  return FLOW_WORKSPACE_URL;
}

export function flowWorkspace(settings) {
  const origin = normalizeFlowWorkspaceUrl(settings?.flowWorkspaceUrl);
  return { origin, url: `${origin}/`, match: `${origin}/*`, project: (id) => `${origin}/project/${id}` };
}

function normalize(settings) {
  const first = Math.max(0, Math.min(3600, Number(settings.humanDelayMinSec) || 0));
  const second = Math.max(0, Math.min(3600, Number(settings.humanDelayMaxSec) || 0));
  settings.humanDelayMinSec = Math.min(first, second);
  settings.humanDelayMaxSec = Math.max(first, second);
  settings.providerAccountProfileId = String(settings.providerAccountProfileId || '').trim().slice(0, 160);
  const cooldown = settings.providerCooldown || {};
  settings.providerCooldown = {
    autoResume: cooldown.autoResume === true,
    minutes: Math.max(1, Math.min(1440, Math.round(Number(cooldown.minutes) || 15))),
  };
  settings.flowProjectId = normalizeFlowProjectId(settings.flowProjectId);
  settings.flowWorkspaceUrl = normalizeFlowWorkspaceUrl(settings.flowWorkspaceUrl);
  if (!['studio', 'standalone', 'gateway'].includes(settings.mode)) settings.mode = DEFAULTS.mode;
  settings.gatewayUrl = String(settings.gatewayUrl || DEFAULTS.gatewayUrl).trim().replace(/\/+$/, '');
  settings.gatewayWorkerId = String(settings.gatewayWorkerId || '').trim().slice(0, 160);
  if (!['image', 'text'].includes(settings.videoMode)) settings.videoMode = DEFAULTS.videoMode;
  if (!['existing', 'generate'].includes(settings.videoSource)) settings.videoSource = DEFAULTS.videoSource;
  if (!['16:9', '9:16'].includes(settings.aspectRatio)) settings.aspectRatio = DEFAULTS.aspectRatio;
  // Keep an unavailable selection visible; only a current request binding may
  // authorize it later. Loading settings must never silently switch models.
  const duration = Number(settings.videoDurationSec);
  settings.videoDurationSec = Number.isSafeInteger(duration) && duration > 0 ? duration : null;
  return settings;
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] || {};
  const upgraded = upgradeStoredVideoSettings(raw);
  if (JSON.stringify(upgraded) !== JSON.stringify(raw)) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: upgraded });
  }
  const settings = { ...DEFAULTS, ...upgraded };
  if (!Object.hasOwn(upgraded, 'videoDurationSec')) {
    const model = modelsForMode(FALLBACK_VIDEO_MODELS, settings.videoMode)
      .find((entry) => entry.key === settings.videoModelKey);
    settings.videoDurationSec = model?.durationSec ?? null;
  }
  return normalize(settings);
}

export async function saveSettings(patch) {
  const next = normalize({ ...(await getSettings()), ...patch });
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

export async function getCredentials() {
  const stored = await chrome.storage.local.get(CREDENTIALS_KEY);
  return stored[CREDENTIALS_KEY] || { username: '', password: '' };
}

export async function saveCredentials(credentials) {
  await chrome.storage.local.set({
    [CREDENTIALS_KEY]: {
      username: String(credentials?.username || ''),
      password: String(credentials?.password || ''),
    },
  });
}

const GATEWAY_TOKEN_KEY = 'gatewayWorkerToken';

export async function getGatewayToken() {
  const stored = await chrome.storage.local.get(GATEWAY_TOKEN_KEY);
  return String(stored[GATEWAY_TOKEN_KEY] || '');
}

export async function saveGatewayToken(token) {
  await chrome.storage.local.set({ [GATEWAY_TOKEN_KEY]: String(token || '').trim() });
}
