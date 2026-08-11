import {
  getSettings,
  saveSettings,
  normalizeFlowProjectId,
  getFleetCredentials,
} from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { flowCommand } from './lib/flow-exec.js';
import { inventoryResult, resolveVideoModel, snapshotVideoModel } from './lib/video-models.js';
import { classifyInterruptedItem, hasActiveDuplicate, isAllowedFleetQueueAction, migrateStoredQueue, standaloneDownloadPath } from './lib/video-rules.js';

const FLOW_URL = 'https://labs.google/fx/tools/flow';
const FLOW_MATCH = 'https://labs.google/fx/*';
const QUEUE_KEY = 'videoQueue';
const FLOW_MODEL_INVENTORY_KEY = 'flowVideoModelInventory';
const PAUSED_KEY = 'videoQueuePaused';
const STATUS_KEY = 'lastVideoStatus';
const NEXT_RUN_KEY = 'nextVideoProviderRunAt';
const COOLDOWN_KEY = 'videoProviderCooldownUntil';
const ALARM = 'videoQueueTick';
const FLEET_ALARM = 'videoFleetHeartbeat';
const FLEET_IDENTITY_KEY = 'videoFleetIdentity';
const FLEET_RESPONSE_NONCES_KEY = 'videoFleetResponseNonces';
const FLEET_COMMAND_RECEIPTS_KEY = 'videoFleetCommandReceipts';
const FLEET_HUB_PAUSE_KEY = 'videoFleetHubPause';
const FLEET_PROTOCOL_VERSION = 2;
const FLEET_PATH = '/api/v2/agents/heartbeat';
const FLEET_MAX_AGE_MS = 60 * 1000;

let processing = false;
let sequence = 0;
const fleetBootSessionId = createRandomId();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isPaused = async () => Boolean((await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY]);

function createAlarm() {
  chrome.alarms?.create(ALARM, { periodInMinutes: 0.5 });
}

function clearAlarm() {
  chrome.alarms?.clear(ALARM);
}

function createFleetAlarm() {
  chrome.alarms?.create(FLEET_ALARM, { periodInMinutes: 1 });
}

function createRandomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fleetText(value, limit = 240) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>&]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fleetSignature(secret, timestamp, nonce, bodyText) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const canonical = `POST\n${FLEET_PATH}\n${timestamp}\n${nonce}\n${bodyText}`;
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical))));
}

function fleetSignaturesMatch(actual, expected) {
  const left = String(actual || '').toLowerCase();
  const right = String(expected || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(left) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function getFleetIdentity() {
  const stored = await chrome.storage.local.get(FLEET_IDENTITY_KEY);
  const existing = stored[FLEET_IDENTITY_KEY];
  if (existing?.agentId && existing?.machineId) return existing;
  const identity = { agentId: createRandomId(), machineId: createRandomId() };
  await chrome.storage.local.set({ [FLEET_IDENTITY_KEY]: identity });
  return identity;
}

function fleetRevision(queue, paused, cooldownUntil) {
  const canonical = JSON.stringify({
    paused: Boolean(paused),
    cooldownUntil: Number(cooldownUntil) || 0,
    queue: queue
      .map((item) => ({
        id: String(item.id || ''),
        status: String(item.status || ''),
        phase: String(item.phase || ''),
        media: Boolean(item.videoMediaId),
        submitted: Boolean(item.submissionStartedAt),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function fleetQueueState() {
  const [queue, paused, stored, hubPause] = await Promise.all([
    getQueue(),
    isPaused(),
    chrome.storage.local.get([COOLDOWN_KEY, NEXT_RUN_KEY, STATUS_KEY]),
    chrome.storage.local.get(FLEET_HUB_PAUSE_KEY),
  ]);
  const counts = { pending: 0, running: 0, done: 0, failed: 0, ambiguous: 0 };
  for (const item of queue) {
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
  }
  const current = queue.find((item) => item.status === 'running');
  const cooldownUntil = Number(stored[COOLDOWN_KEY]) || 0;
  const needsLocalReview = counts.ambiguous > 0;
  let state = 'idle';
  if (needsLocalReview) state = 'needs-local-review';
  else if (cooldownUntil > Date.now()) state = 'cooldown';
  else if (paused) state = hubPause[FLEET_HUB_PAUSE_KEY] ? 'paused-by-hub' : 'paused-locally';
  else if (counts.running) state = 'running';
  else if (counts.pending) state = 'queued';
  return {
    queue,
    paused,
    cooldownUntil,
    nextRunAt: Number(stored[NEXT_RUN_KEY]) || 0,
    needsLocalReview,
    hubPause: hubPause[FLEET_HUB_PAUSE_KEY] || null,
    revision: fleetRevision(queue, paused, cooldownUntil),
    snapshot: {
      state,
      counts,
      current: current
        ? { phase: fleetText(current.phase, 80), label: fleetText(current.label, 120) }
        : null,
      cooldownUntil,
      nextRunAt: Number(stored[NEXT_RUN_KEY]) || 0,
      needsLocalReview,
      lastStatus: stored[STATUS_KEY]
        ? { kind: fleetText(stored[STATUS_KEY].kind, 24), text: fleetText(stored[STATUS_KEY].text, 240) }
        : null,
    },
  };
}

async function getFleetCommandReceipts() {
  const stored = await chrome.storage.local.get(FLEET_COMMAND_RECEIPTS_KEY);
  return Array.isArray(stored[FLEET_COMMAND_RECEIPTS_KEY]) ? stored[FLEET_COMMAND_RECEIPTS_KEY] : [];
}

async function saveFleetCommandReceipt(receipt) {
  const receipts = await getFleetCommandReceipts();
  const next = [...receipts.filter((item) => item.commandId !== receipt.commandId), receipt].slice(-256);
  await chrome.storage.local.set({ [FLEET_COMMAND_RECEIPTS_KEY]: next });
  return receipt;
}

async function rememberFleetResponseNonce(nonce) {
  const stored = await chrome.storage.local.get(FLEET_RESPONSE_NONCES_KEY);
  const nonces = Array.isArray(stored[FLEET_RESPONSE_NONCES_KEY]) ? stored[FLEET_RESPONSE_NONCES_KEY] : [];
  if (nonces.includes(nonce)) throw new Error('Fleet response replay rejected.');
  await chrome.storage.local.set({ [FLEET_RESPONSE_NONCES_KEY]: [...nonces, nonce].slice(-256) });
}

function fleetHubEndpoint(baseUrl) {
  const endpoint = new URL(FLEET_PATH, `${String(baseUrl || '').replace(/\/$/, '')}/`);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Fleet Hub URL must use HTTP or HTTPS.');
  return endpoint;
}

async function fleetHostAccessGranted(baseUrl) {
  const endpoint = fleetHubEndpoint(baseUrl);
  if (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) return true;
  return chrome.permissions.contains({ origins: [`${endpoint.protocol}//${endpoint.hostname}/*`] });
}

async function runFleetCommand(command, state, identity) {
  const commandId = fleetText(command?.commandId || command?.id, 160);
  const action = fleetText(command?.action, 80);
  const receipt = { commandId, action, at: Date.now(), status: 'rejected' };
  if (!commandId || !action) return { ...receipt, reason: 'Invalid command.' };
  if (!isAllowedFleetQueueAction(action)) return { ...receipt, reason: 'Unsupported Fleet action.' };
  if (!Number.isInteger(command.expectedQueueRevision) || command.expectedQueueRevision !== state.revision) {
    return { ...receipt, reason: 'Queue revision no longer matches.' };
  }
  if (fleetText(command.targetAgentId, 160) !== identity.agentId) {
    return { ...receipt, reason: 'Command targets another agent.' };
  }
  if (fleetText(command.targetSessionId, 160) !== fleetBootSessionId) {
    return { ...receipt, reason: 'Command targets a stale agent session.' };
  }
  // Fleet v2 uses epoch milliseconds so every MV3 agent can compare command
  // lifetimes without locale-dependent date parsing.
  const createdAt = Number(command.createdAt);
  const expiry = Number(command.expiresAt);
  const now = Date.now();
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiry) ||
    createdAt > now + FLEET_MAX_AGE_MS ||
    expiry <= createdAt ||
    expiry - createdAt > 15 * 60 * 1000
  ) {
    return { ...receipt, reason: 'Command lifetime is invalid.' };
  }
  if (expiry < now) return { ...receipt, status: 'expired', reason: 'Command expired.' };

  if (action === 'pause_after_current') {
    await chrome.storage.local.set({
      [PAUSED_KEY]: true,
      [FLEET_HUB_PAUSE_KEY]: { commandId, sessionId: fleetBootSessionId, at: Date.now() },
    });
    return { ...receipt, status: 'succeeded', queueRevision: (await fleetQueueState()).revision };
  }

  if (action === 'resume_hub_pause') {
    if (!state.hubPause || !state.paused) return { ...receipt, reason: 'The queue is not paused by Fleet Hub.' };
    if (state.cooldownUntil > Date.now()) return { ...receipt, reason: 'Provider cooldown remains active.' };
    if (state.needsLocalReview) return { ...receipt, reason: 'A paid submission needs local review.' };
    await chrome.storage.local.remove([PAUSED_KEY, FLEET_HUB_PAUSE_KEY]);
    createAlarm();
    processQueue();
    return { ...receipt, status: 'succeeded', queueRevision: (await fleetQueueState()).revision };
  }

  if (action === 'clear_pending') {
    await clearQueue();
    return { ...receipt, status: 'succeeded', queueRevision: (await fleetQueueState()).revision };
  }

  return { ...receipt, reason: 'Unsupported Fleet action.' };
}

async function applyFleetCommands(commands, identity) {
  const settings = await getSettings();
  if (!settings.fleetQueueControlConsent || !Array.isArray(commands)) return [];
  const receipts = [];
  for (const command of commands.slice(0, 20)) {
    const commandId = fleetText(command?.commandId || command?.id, 160);
    const prior = (await getFleetCommandReceipts()).find((item) => item.commandId === commandId);
    if (prior) {
      receipts.push(prior);
      continue;
    }
    const receipt = await runFleetCommand(command, await fleetQueueState(), identity);
    await saveFleetCommandReceipt(receipt);
    receipts.push(receipt);
  }
  return receipts;
}

async function sendFleetHeartbeat({ allowCommands = true, forceTelemetry = false } = {}) {
  const [settings, credentials] = await Promise.all([getSettings(), getFleetCredentials()]);
  if ((!settings.fleetEnabled || !settings.fleetTelemetryConsent) && !forceTelemetry) {
    return { ok: false, skipped: 'Fleet telemetry is disabled.' };
  }
  if (!credentials.pairingSecret) return { ok: false, skipped: 'A local Fleet pairing secret is required.' };
  if (!(await fleetHostAccessGranted(settings.fleetHubUrl))) return { ok: false, skipped: 'Fleet Hub site access has not been granted.' };
  const [identity, state, commandResults] = await Promise.all([
    getFleetIdentity(),
    fleetQueueState(),
    getFleetCommandReceipts(),
  ]);
  const body = {
    protocolVersion: FLEET_PROTOCOL_VERSION,
    agentId: identity.agentId,
    machineId: identity.machineId,
    sessionId: fleetBootSessionId,
    extensionType: 'video',
    machineName: fleetText(settings.fleetMachineName, 80),
    queueRevision: state.revision,
    snapshot: state.snapshot,
    capabilities: { telemetry: true, queueControls: ['pause_after_current', 'resume_hub_pause', 'clear_pending'] },
    consent: { telemetry: settings.fleetTelemetryConsent === true, queueControl: settings.fleetQueueControlConsent === true },
    commandResults: commandResults.slice(-64),
  };
  const bodyText = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = createRandomId();
  const signature = await fleetSignature(credentials.pairingSecret, timestamp, nonce, bodyText);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(fleetHubEndpoint(settings.fleetHubUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fleet-Timestamp': timestamp,
        'X-Fleet-Nonce': nonce,
        'X-Fleet-Signature': signature,
      },
      body: bodyText,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Fleet Hub rejected heartbeat (${response.status}).`);
  const responseTimestamp = response.headers.get('X-Fleet-Timestamp');
  const responseNonce = response.headers.get('X-Fleet-Nonce');
  const responseSignature = response.headers.get('X-Fleet-Signature');
  if (!responseTimestamp || !responseNonce || !responseSignature) throw new Error('Fleet Hub response is not signed.');
  if (!/^\d{10,}$/.test(responseTimestamp) || Math.abs(Date.now() - Number(responseTimestamp)) > FLEET_MAX_AGE_MS) {
    throw new Error('Fleet Hub response is stale.');
  }
  const expectedSignature = await fleetSignature(credentials.pairingSecret, responseTimestamp, responseNonce, responseText);
  if (!fleetSignaturesMatch(responseSignature, expectedSignature)) throw new Error('Fleet Hub response signature is invalid.');
  await rememberFleetResponseNonce(responseNonce);
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error('Fleet Hub returned invalid JSON.');
  }
  if (payload?.protocolVersion !== FLEET_PROTOCOL_VERSION) throw new Error('Fleet Hub protocol version is incompatible.');
  const applied = allowCommands ? await applyFleetCommands(payload.commands, identity) : [];
  await chrome.storage.local.set({
    lastVideoFleetStatus: { ok: true, timestamp: Date.now(), appliedCommands: applied },
  });
  return { ok: true, commands: applied.length };
}

async function writeStatus(text, kind = 'info', details = {}) {
  await chrome.storage.local.set({
    [STATUS_KEY]: { text, kind, timestamp: Date.now(), ...details },
  });
}

async function getQueue() {
  const stored = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  const migrated = migrateStoredQueue(stored);
  if (migrated.changed) await chrome.storage.local.set({ [QUEUE_KEY]: migrated.queue });
  return migrated.queue;
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function patchItem(id, patch) {
  const queue = await getQueue();
  const item = queue.find((candidate) => candidate.id === id);
  if (item) Object.assign(item, patch);
  await setQueue(queue);
  return item;
}

async function ensureFlowTab() {
  const tabs = await chrome.tabs.query({ url: FLOW_MATCH });
  const ready = tabs.find((tab) => tab.status === 'complete');
  if (ready) return ready;
  const tab = tabs[0] || (await chrome.tabs.create({ url: FLOW_URL, active: false }));
  if (tab.status !== 'complete') {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Flow tab timed out while loading.'));
      }, 60000);
      const listener = (tabId, info) => {
        if (tabId !== tab.id || info.status !== 'complete') return;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
  await sleep(1500);
  return chrome.tabs.get(tab.id);
}

async function runFlow(tabId, op, payload = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https:\/\/labs\.google\/fx\//i.test(tab?.url || '')) {
    throw new Error('Refusing to run a Flow command outside labs.google/fx.');
  }
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: flowCommand,
    args: [{ op, payload }],
  });
  if (!result?.ok) throw new Error(result?.error || `Flow ${op} failed.`);
  return result.result;
}

async function flowContext() {
  const tab = await ensureFlowTab();
  return { ok: true, ...(await runFlow(tab.id, 'getContext')) };
}

async function refreshFlowModels(tab) {
  const activeTab = tab || await ensureFlowTab();
  const discovered = await runFlow(activeTab.id, 'listVideoModels');
  const inventory = { ...inventoryResult(discovered.entries), refreshedAt: Date.now() };
  await chrome.storage.local.set({ [FLOW_MODEL_INVENTORY_KEY]: inventory });
  return { ok: true, ...inventory };
}

async function requireCurrentModel(modelKey, tab) {
  const inventory = await refreshFlowModels(tab);
  return { ...resolveVideoModel(modelKey, inventory.models), source: inventory.source };
}

async function createFlowProject() {
  const tab = await ensureFlowTab();
  const created = await runFlow(tab.id, 'createProject');
  await saveSettings({
    flowProjectId: created.projectId,
    flowProjectName: created.title || '',
  });
  await chrome.tabs.update(tab.id, {
    url: `${FLOW_URL}/project/${created.projectId}`,
    autoDiscardable: false,
  });
  return { ok: true, ...created };
}

async function fetchVideo(mediaId) {
  const endpoint =
    `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect` +
    `?name=${encodeURIComponent(mediaId)}&mediaUrlType=MEDIA_URL_TYPE_FULL_MEDIA`;
  const response = await fetch(endpoint, { credentials: 'include' });
  if (!response.ok) throw new Error(`Video retrieval failed (${response.status}).`);
  const mediaUrl = new URL(response.url);
  if (
    mediaUrl.protocol !== 'https:' ||
    !(mediaUrl.hostname === 'flow-content.google' ||
      mediaUrl.hostname.endsWith('.flow-content.google'))
  ) {
    throw new Error('Flow returned an untrusted video URL.');
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('video/')) throw new Error('Flow returned a non-video asset.');
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error('Retrieved video was empty.');
  if (buffer.byteLength > 256 * 1024 * 1024) throw new Error('Retrieved video exceeded 256 MB.');
  return buffer;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function waitForPacing(settings, item) {
  for (;;) {
    const nextRunAt = Number((await chrome.storage.local.get(NEXT_RUN_KEY))[NEXT_RUN_KEY]) || 0;
    const remaining = nextRunAt - Date.now();
    if (remaining <= 0) return;
    await writeStatus(`Waiting before ${item.label}…`, 'info', { countdownUntil: nextRunAt });
    await sleep(Math.min(remaining, 10000));
  }
}

async function setNextRun(settings) {
  const minimum = Math.max(0, Number(settings.humanDelayMinSec) || 0);
  const maximum = Math.max(minimum, Number(settings.humanDelayMaxSec) || 0);
  const seconds = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
  await chrome.storage.local.set({ [NEXT_RUN_KEY]: Date.now() + seconds * 1000 });
}

function isTemporaryLimit(error) {
  return /(?:\b429\b|rate[ -]?limit|too many requests|quota|resource[_ -]?exhausted|limit reached)/i.test(
    String(error?.message || error || '')
  );
}

async function holdForCooldown(settings, item) {
  const { [COOLDOWN_KEY]: resumeAt = 0 } = await chrome.storage.local.get(COOLDOWN_KEY);
  const remaining = Number(resumeAt) - Date.now();
  if (remaining <= 0) {
    if (resumeAt) await chrome.storage.local.remove(COOLDOWN_KEY);
    return false;
  }
  if (!settings.providerCooldown.autoResume) {
    await chrome.storage.local.remove(COOLDOWN_KEY);
    return false;
  }
  await writeStatus('Generation service cooldown; the queue will resume automatically.', 'info', {
    countdownUntil: Number(resumeAt),
    countdownReason: 'cooldown',
    countdownLabel: item.label,
  });
  createAlarm();
  return true;
}

async function requeueForCooldown(id) {
  const queue = await getQueue();
  const item = queue.find((candidate) => candidate.id === id);
  if (!item) return false;
  item.status = 'pending';
  item.phase = item.videoMediaId ? 'polling' : item.startMediaId ? 'prepared' : 'queued';
  delete item.error;
  delete item.startedAt;
  delete item.finishedAt;
  await setQueue(queue);
  return true;
}

async function generateAndSave(item, settings, tab) {
  const projectId = normalizeFlowProjectId(item.projectId || settings.flowProjectId);
  if (!projectId) throw new Error('No Flow project selected.');
  const studio = new StudioClient(settings.studioBaseUrl);

  if (!item.videoMediaId) {
    const model = await requireCurrentModel(item.videoModelKey, tab);
    if (model.label !== item.videoModelLabel) {
      throw new Error('The selected Flow model changed. Refresh models and queue again.');
    }
  }

  if (!item.startMediaId) {
    await patchItem(item.id, { phase: 'preparing' });
    if (item.videoSource === 'generate') {
      await patchItem(item.id, { phase: 'image_submitting', imageSubmissionStartedAt: Date.now() });
      await writeStatus(`${item.label}: generating a start image…`, 'running');
      const generated = await runFlow(tab.id, 'generateImage', {
        projectId,
        prompt: item.imagePrompt || item.motionPrompt,
        model: item.imageModel || settings.imageModel,
        aspectRatio: item.aspectRatio,
        recaptchaMaxAttempts: 4,
      });
      item.startMediaId = generated.mediaId;
      await patchItem(item.id, { startMediaId: item.startMediaId, phase: 'prepared' });
    } else {
      await writeStatus(`${item.label}: uploading the scene image…`, 'running');
      const image = await studio.sceneImageBase64(item.slug, item.episodeCode, item.sceneId);
      const uploaded = await runFlow(tab.id, 'uploadImage', {
        projectId,
        base64: image.base64,
        mime: image.mime,
        fileName: `${item.sceneId}.png`,
      });
      item.startMediaId = uploaded.mediaId;
    }
    if (item.videoSource !== 'generate') await patchItem(item.id, { startMediaId: item.startMediaId, phase: 'prepared' });
  }

  if (!item.videoMediaId) {
    // Persist BEFORE the paid request. If the worker dies before receiving the
    // media id, startup quarantines this item instead of charging again.
    await patchItem(item.id, { phase: 'submitting', submissionStartedAt: Date.now() });
    await writeStatus(`${item.label}: submitting paid video generation…`, 'running');
    const submitted = await runFlow(tab.id, 'submitVideoStartImage', {
      projectId,
      mediaId: item.startMediaId,
      motionPrompt: item.motionPrompt,
      modelKey: item.videoModelKey,
      aspectRatio: item.aspectRatio,
      durationSec: item.durationSec,
    });
    item.videoMediaId = submitted.mediaId;
    await patchItem(item.id, {
      videoMediaId: submitted.mediaId,
      phase: 'polling',
    });
  }

  const deadline = Date.now() + 8 * 60 * 1000;
  for (;;) {
    const status = await runFlow(tab.id, 'checkVideo', {
      projectId,
      mediaId: item.videoMediaId,
    });
    if (status.done) break;
    if (status.failed) throw new Error(`Flow video generation ${status.status}.`);
    if (Date.now() > deadline) throw new Error(`Video timed out (${status.status}).`);
    await writeStatus(
      `${item.label}: ${String(status.status)
        .replace('MEDIA_GENERATION_STATUS_', '')
        .toLowerCase()}…`,
      'running'
    );
    await sleep(10000);
  }

  await patchItem(item.id, { phase: item.target === 'download' ? 'downloading' : 'ingesting' });
  const mp4 = await fetchVideo(item.videoMediaId);
  if (item.target === 'download') {
    const filename = `${String(item.downloadPath || 'StoryStudioVideos/Standalone/video.mp4').replace(/\.(mp4|webm)$/i, '')}.mp4`;
    await chrome.downloads.download({
      url: `data:video/mp4;base64,${bufferToBase64(mp4)}`,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    return filename;
  }
  await studio.uploadClip(item.slug, item.episodeCode, item.sceneId, mp4);
  return `${item.sceneId}.mp4`;
}

function itemKey(item) {
  return `${item.slug}::${item.episodeCode}::${item.sceneId}`;
}

async function enqueueScenes(payload) {
  const settings = await getSettings();
  const projectId = normalizeFlowProjectId(payload.projectId || settings.flowProjectId);
  if (!projectId) throw new Error('Select a Flow project before queuing videos.');
  const inventory = await refreshFlowModels();
  const snapshot = snapshotVideoModel(payload.videoModelKey, inventory.models, inventory.source);
  const model = { key: snapshot.videoModelKey, label: snapshot.videoModelLabel };
  const queueModel = {
    videoModelKey: model.key,
    videoModelLabel: model.label,
    videoModelSource: snapshot.videoModelSource,
  };
  const queue = await getQueue();
  const active = new Set(
    queue
      .filter((item) => ['pending', 'running'].includes(item.status))
      .map(itemKey)
  );
  let added = 0;
  let skipped = 0;
  for (const scene of payload.scenes || []) {
    const item = {
      id: `${Date.now()}_${sequence++}`,
      status: 'pending',
      phase: 'queued',
      queuedAt: Date.now(),
      slug: payload.slug,
      projectName: payload.projectName || payload.slug,
      episodeCode: payload.episodeCode,
      episodeTitle: payload.episodeTitle || '',
      sceneId: scene.id,
      label: `${payload.episodeCode} · ${scene.label || scene.id}`,
      motionPrompt: scene.motionPrompt || '',
      imagePrompt: scene.imagePrompt || '',
      durationSec: scene.durationSec,
      projectId,
      ...queueModel,
      videoSource: payload.videoSource || settings.videoSource,
      imageModel: settings.imageModel,
      aspectRatio: payload.aspectRatio || settings.aspectRatio,
    };
    if (hasActiveDuplicate(queue, item)) {
      skipped++;
      continue;
    }
    queue.push(item);
    added++;
  }
  await setQueue(queue);
  if (added) {
    // A local enqueue is an explicit user decision, so it must not leave a
    // stale Hub-owned pause marker that could later be resumed remotely.
    await chrome.storage.local.remove([PAUSED_KEY, FLEET_HUB_PAUSE_KEY]);
    createAlarm();
    processQueue();
  }
  return { ok: true, added, skipped };
}

function standaloneSceneId(prompt) {
  let hash = 5381;
  for (const char of String(prompt).trim()) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  return `standalone_${(hash >>> 0).toString(36)}`;
}

async function enqueueStandalone(payload) {
  const settings = await getSettings();
  const projectId = normalizeFlowProjectId(payload?.projectId || settings.flowProjectId);
  const prompts = Array.isArray(payload?.prompts)
    ? payload.prompts.map((prompt) => String(prompt || '').trim()).filter(Boolean).slice(0, 100)
    : [String(payload?.prompt || '').trim()].filter(Boolean);
  if (!projectId) throw new Error('Select a generation workspace before queuing a video.');
  if (!prompts.length) throw new Error('Enter at least one video prompt before queuing.');
  const inventory = await refreshFlowModels();
  const snapshot = snapshotVideoModel(payload.videoModelKey, inventory.models, inventory.source);
  const model = { key: snapshot.videoModelKey, label: snapshot.videoModelLabel };
  const queueModel = {
    videoModelKey: model.key,
    videoModelLabel: model.label,
    videoModelSource: snapshot.videoModelSource,
  };
  const queue = await getQueue();
  let added = 0;
  let skipped = 0;
  for (const [index, prompt] of prompts.entries()) {
    const sceneId = `${standaloneSceneId(prompt)}_${String(index + 1).padStart(2, '0')}`;
    const item = {
      id: `${Date.now()}_${sequence++}`,
      status: 'pending',
      phase: 'queued',
      queuedAt: Date.now(),
      slug: 'standalone',
      projectName: 'Standalone',
      episodeCode: 'Standalone',
      episodeTitle: '',
      sceneId,
      label: prompts.length > 1 ? `Standalone video ${index + 1}/${prompts.length}` : 'Standalone video',
      motionPrompt: prompt,
      imagePrompt: prompt,
      durationSec: 4,
      projectId,
      ...queueModel,
      videoSource: 'generate',
      imageModel: settings.imageModel,
      aspectRatio: payload.aspectRatio || settings.aspectRatio,
      target: 'download',
      downloadPath: standaloneDownloadPath(sceneId),
    };
    if (hasActiveDuplicate(queue, item)) {
      skipped += 1;
      continue;
    }
    queue.push(item);
    added += 1;
  }
  await setQueue(queue);
  await chrome.storage.local.remove([PAUSED_KEY, FLEET_HUB_PAUSE_KEY]);
  createAlarm();
  processQueue();
  return { ok: true, added, skipped };
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      if (await isPaused()) break;
      const queue = await getQueue();
      const pending = queue.find((item) => item.status === 'pending');
      if (!pending) break;
      const settings = await getSettings();
      if (await holdForCooldown(settings, pending)) break;
      await waitForPacing(settings, pending);
      if (await isPaused()) break;
      const current = await patchItem(pending.id, {
        status: 'running',
        startedAt: pending.startedAt || Date.now(),
      });
      if (!current) continue;
      let providerAttempted = false;
      try {
        const tab = await ensureFlowTab();
        providerAttempted = true;
        const savedAs = await generateAndSave(current, settings, tab);
        await patchItem(current.id, {
          status: 'done',
          phase: 'done',
          savedAs,
          finishedAt: Date.now(),
          error: undefined,
        });
      } catch (error) {
        const latest = (await getQueue()).find((item) => item.id === current.id) || current;
        const recovery = classifyInterruptedItem(latest);
        if (recovery.status === 'ambiguous') {
          await patchItem(current.id, {
            status: 'ambiguous',
            ambiguityKind: recovery.ambiguityKind,
            error: recovery.error,
            finishedAt: Date.now(),
          });
          await chrome.storage.local.set({ [PAUSED_KEY]: true });
          await writeStatus('Paid submission needs review; the video queue is paused.', 'err');
          break;
        }
        if (isTemporaryLimit(error)) {
          await requeueForCooldown(current.id);
          if (settings.providerCooldown.autoResume) {
            const resumeAt = Date.now() + settings.providerCooldown.minutes * 60 * 1000;
            await chrome.storage.local.set({ [COOLDOWN_KEY]: resumeAt });
            await writeStatus('Generation service limit reached; resuming automatically.', 'info', {
              countdownUntil: resumeAt,
              countdownReason: 'cooldown',
              countdownLabel: latest.label,
            });
            createAlarm();
          } else {
            await chrome.storage.local.set({ [PAUSED_KEY]: true });
            await writeStatus('Generation service limit reached; queue paused for review.', 'info');
          }
          break;
        }
        await patchItem(current.id, {
          status: 'failed',
          error: String(error?.message || error),
          finishedAt: Date.now(),
        });
      } finally {
        if (providerAttempted) await setNextRun(settings);
      }
    }
    const queue = await getQueue();
    if (!queue.some((item) => ['pending', 'running'].includes(item.status))) clearAlarm();
  } finally {
    processing = false;
  }
}

async function retryItem(id, acceptAmbiguousRisk = false) {
  const queue = await getQueue();
  const item = queue.find((candidate) => candidate.id === id);
  if (!item || !['failed', 'ambiguous'].includes(item.status)) {
    return { ok: false, error: 'Video job is not retryable.' };
  }
  if (item.status === 'ambiguous' && !acceptAmbiguousRisk) {
    return { ok: false, ambiguous: true, error: 'Explicit duplicate-charge acceptance is required.' };
  }
  if (item.status === 'ambiguous') {
    if (item.ambiguityKind === 'image') { delete item.startMediaId; delete item.imageSubmissionStartedAt; item.phase = 'queued'; }
    else { delete item.submissionStartedAt; item.phase = 'prepared'; }
  }
  item.status = 'pending';
  delete item.error;
  delete item.finishedAt;
  await setQueue(queue);
  await chrome.storage.local.remove(PAUSED_KEY);
  createAlarm();
  processQueue();
  return { ok: true };
}

async function clearQueue() {
  const queue = await getQueue();
  await setQueue(queue.filter((item) => item.status !== 'pending'));
  return { ok: true };
}

async function recoverInterruptedJobs() {
  const queue = await getQueue();
  let changed = false;
  for (const item of queue) {
    if (item.status !== 'running') continue;
    changed = true;
    Object.assign(item, classifyInterruptedItem(item));
  }
  if (changed) await setQueue(queue);
  if (queue.some((item) => item.status === 'pending')) {
    createAlarm();
    processQueue();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const reply = (promise) =>
    promise
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  switch (message?.type) {
    case 'getQueue':
      reply(
        Promise.all([getQueue(), isPaused(), chrome.storage.local.get(COOLDOWN_KEY)]).then(([queue, paused, stored]) => ({
          ok: true,
          queue,
          paused,
          cooldownUntil: Number(stored[COOLDOWN_KEY]) || 0,
        }))
      );
      return true;
    case 'enqueueScenes':
      reply(enqueueScenes(message.payload));
      return true;
    case 'enqueueStandalone':
      reply(enqueueStandalone(message.payload));
      return true;
    case 'pauseQueue':
      reply(
        chrome.storage.local
          .set({ [PAUSED_KEY]: true })
          .then(() => chrome.storage.local.remove(FLEET_HUB_PAUSE_KEY))
          .then(() => ({ ok: true }))
      );
      return true;
    case 'resumeQueue':
      reply(
        chrome.storage.local.remove([PAUSED_KEY, COOLDOWN_KEY, FLEET_HUB_PAUSE_KEY]).then(() => {
          createAlarm();
          processQueue();
          return { ok: true };
        })
      );
      return true;
    case 'clearQueue':
      reply(clearQueue());
      return true;
    case 'retryItem':
      reply(retryItem(message.id, message.acceptAmbiguousRisk === true));
      return true;
    case 'flowContext':
      reply(flowContext());
      return true;
    case 'refreshFlowModels':
      reply(refreshFlowModels());
      return true;
    case 'newFlowProject':
      reply(createFlowProject());
      return true;
    case 'openFlow':
      reply(
        ensureFlowTab().then(async (tab) => {
          await chrome.tabs.update(tab.id, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          return { ok: true };
        })
      );
      return true;
    case 'fleetTest':
      reply(sendFleetHeartbeat({ allowCommands: false, forceTelemetry: true }));
      return true;
    case 'fleetSettingsChanged':
      createFleetAlarm();
      reply(Promise.resolve({ ok: true }));
      return true;
    default:
      return false;
  }
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === ALARM) processQueue();
  if (alarm.name === FLEET_ALARM) {
    sendFleetHeartbeat().catch(async (error) => {
      await chrome.storage.local.set({
        lastVideoFleetStatus: { ok: false, timestamp: Date.now(), error: fleetText(error?.message || error) },
      });
    });
  }
});

try {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch {
  // Older Chrome versions do not support sidePanel.
}

recoverInterruptedJobs();
createFleetAlarm();
