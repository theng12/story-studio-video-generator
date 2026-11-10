import { FALLBACK_VIDEO_MODELS, defaultVideoModel, modelsForMode, upgradeStoredVideoSettings } from './video-models.js';

const DEFAULT_VIDEO_MODEL = defaultVideoModel('image');

export const DEFAULTS = {
  theme: 'system',
  mode: 'studio',
  studioBaseUrl: 'http://localhost:8766',
  flowProjectId: '',
  flowProjectName: '',
  // Where Google Flow lives. Google moved it once already (labs.google/fx →
  // flow.google.com); the next move is a Settings edit, not a code change.
  flowWorkspaceUrl: 'https://flow.google.com',
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
  humanDelayMaxSec: 60,
  // A temporary service limit can either pause the queue for review or wait
  // before safely retrying work that never reached paid submission.
  providerCooldown: { autoResume: false, minutes: 15 },
  fleetEnabled: false,
  fleetHubUrl: 'http://localhost:8799',
  fleetMachineName: '',
  fleetTelemetryConsent: false,
  fleetQueueControlConsent: false,
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
const FLEET_CREDENTIALS_KEY = 'videoFleetCredentials';

export function normalizeFlowProjectId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(
    /(?:\/project\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
  );
  return match ? match[1].toLowerCase() : raw;
}

// Only the https origin is kept: the worker builds the tab URL, the tab-match
// pattern, and the "is this really a Flow tab" guard from it.
export function normalizeFlowWorkspaceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol === 'https:' && url.hostname) return url.origin;
  } catch {
    /* fall through to the default */
  }
  return DEFAULTS.flowWorkspaceUrl;
}

export function flowWorkspace(settings) {
  const origin = normalizeFlowWorkspaceUrl(settings?.flowWorkspaceUrl);
  return { origin, url: `${origin}/`, match: `${origin}/*`, project: (id) => `${origin}/project/${id}` };
}

function normalize(settings) {
  const first = Math.max(0, Math.min(3600, Math.round(Number(settings.humanDelayMinSec) || 0)));
  const second = Math.max(0, Math.min(3600, Math.round(Number(settings.humanDelayMaxSec) || 0)));
  settings.humanDelayMinSec = Math.min(first, second);
  settings.humanDelayMaxSec = Math.max(first, second);
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
  settings.fleetEnabled = settings.fleetEnabled === true;
  settings.fleetHubUrl = String(settings.fleetHubUrl || DEFAULTS.fleetHubUrl).trim().replace(/\/$/, '');
  settings.fleetMachineName = String(settings.fleetMachineName || '').trim().slice(0, 80);
  settings.fleetTelemetryConsent = settings.fleetTelemetryConsent === true;
  settings.fleetQueueControlConsent = settings.fleetQueueControlConsent === true;
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

export async function getFleetCredentials() {
  const stored = await chrome.storage.local.get(FLEET_CREDENTIALS_KEY);
  const credentials = stored[FLEET_CREDENTIALS_KEY] || {};
  return {
    pairingSecret: String(credentials.pairingSecret || ''),
  };
}

export async function saveFleetCredentials(credentials) {
  await chrome.storage.local.set({
    [FLEET_CREDENTIALS_KEY]: {
      pairingSecret: String(credentials?.pairingSecret || '').trim(),
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
