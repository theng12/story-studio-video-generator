export const DEFAULTS = {
  theme: 'system',
  mode: 'studio',
  studioBaseUrl: 'http://localhost:8766',
  flowProjectId: '',
  flowProjectName: '',
  // Stored separately from the workspace so additional generation backends can
  // be added later without changing existing queue items.
  videoProvider: 'workspace',
  videoModel: 'veo-3.1-fast',
  videoSource: 'existing',
  imageModel: 'nano-banana-2',
  aspectRatio: '16:9',
  saveTarget: 'project',
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
  if (!['studio', 'standalone'].includes(settings.mode)) settings.mode = DEFAULTS.mode;
  if (!['project', 'download'].includes(settings.saveTarget)) settings.saveTarget = DEFAULTS.saveTarget;
  if (!['workspace'].includes(settings.videoProvider)) settings.videoProvider = DEFAULTS.videoProvider;
  if (!['existing', 'generate'].includes(settings.videoSource)) settings.videoSource = DEFAULTS.videoSource;
  if (!['16:9', '9:16'].includes(settings.aspectRatio)) settings.aspectRatio = DEFAULTS.aspectRatio;
  settings.fleetEnabled = settings.fleetEnabled === true;
  settings.fleetHubUrl = String(settings.fleetHubUrl || DEFAULTS.fleetHubUrl).trim().replace(/\/$/, '');
  settings.fleetMachineName = String(settings.fleetMachineName || '').trim().slice(0, 80);
  settings.fleetTelemetryConsent = settings.fleetTelemetryConsent === true;
  settings.fleetQueueControlConsent = settings.fleetQueueControlConsent === true;
  return settings;
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return normalize({ ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) });
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
