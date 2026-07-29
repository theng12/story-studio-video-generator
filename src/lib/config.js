export const DEFAULTS = {
  studioBaseUrl: 'http://localhost:8766',
  flowProjectId: '',
  flowProjectName: '',
  videoModel: 'veo-3.1-fast',
  videoSource: 'existing',
  imageModel: 'nano-banana-2',
  aspectRatio: '16:9',
  saveTarget: 'project',
  downloadSubdir: 'StoryStudioVideos/{project}/{episodeCode}',
  filenameTemplate: '{episodeCode}_{sceneId}',
  humanDelayMinSec: 5,
  humanDelayMaxSec: 60,
  lastProject: '',
  lastEpisode: '',
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

function normalize(settings) {
  const first = Math.max(0, Math.min(3600, Math.round(Number(settings.humanDelayMinSec) || 0)));
  const second = Math.max(0, Math.min(3600, Math.round(Number(settings.humanDelayMaxSec) || 0)));
  settings.humanDelayMinSec = Math.min(first, second);
  settings.humanDelayMaxSec = Math.max(first, second);
  settings.flowProjectId = normalizeFlowProjectId(settings.flowProjectId);
  if (!['existing', 'generate'].includes(settings.videoSource)) settings.videoSource = DEFAULTS.videoSource;
  if (!['16:9', '9:16'].includes(settings.aspectRatio)) settings.aspectRatio = DEFAULTS.aspectRatio;
  if (!['project', 'download'].includes(settings.saveTarget)) settings.saveTarget = DEFAULTS.saveTarget;
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
