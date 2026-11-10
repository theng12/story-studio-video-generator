import {
  getSettings,
  saveSettings,
  normalizeFlowProjectId,
  flowWorkspace,
  getFleetCredentials,
  getGatewayToken,
} from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { flowCommand } from './lib/flow-exec.js';
import { inventoryResult, resolveVideoModel, snapshotVideoModel } from './lib/video-models.js';
import { classifyInterruptedItem, hasActiveDuplicate, isAllowedFleetQueueAction, migrateStoredQueue, standaloneDownloadPath } from './lib/video-rules.js';
import { gatewayJobToItem, isGatewayJobQueued } from './lib/gateway-worker.js';
import { claimGatewayJob, gatewayBinding, reportGatewayFailure, reportGatewayProgress, reportGatewayResult, testGateway } from './lib/gateway-client.js';
import { getGatewayArtifact, putGatewayArtifact, deleteGatewayArtifact } from './lib/gateway-artifacts.js';

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
const GATEWAY_ALARM = 'gatewayWorkerTick';
const GATEWAY_REFERENCES_KEY = 'gatewayJobReferences';
const GATEWAY_CLAIM_KEY = 'gatewayUnsettledClaim';

let claiming = false;
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

// ── Gateway Studio worker mode ─────────────────────────────────────────────
// A separate third mode: the extension claims jobs instead of being driven
// from the panel. Studio and standalone items never carry gatewayJobId, so the
// existing paths run unchanged.
async function gatewaySettings() {
  return { ...(await getSettings()), gatewayToken: await getGatewayToken() };
}

async function connectGateway() {
  const settings = await gatewaySettings();
  // The bearer token's authenticated identity replaces the old random local id.
  const health = await testGateway({ ...settings, gatewayWorkerId: '' });
  const current = await gatewaySettings();
  if (current.gatewayUrl !== settings.gatewayUrl || current.gatewayToken !== settings.gatewayToken || current.mode !== settings.mode) {
    throw new Error('Gateway settings changed during connection.');
  }
  if (settings.gatewayWorkerId !== health.workerId) await saveSettings({ gatewayWorkerId: health.workerId });
  return { settings: { ...settings, gatewayWorkerId: health.workerId }, health };
}

async function assertGatewayConnection(item) {
  const settings = await gatewaySettings();
  if (settings.mode !== 'gateway' || !item.gatewayBinding || await gatewayBinding(settings) !== item.gatewayBinding) {
    throw new Error('Gateway connection changed; restore the claiming connection before retrying this job.');
  }
  const marker = (await chrome.storage.local.get(GATEWAY_CLAIM_KEY))[GATEWAY_CLAIM_KEY];
  if (marker && (marker.claimId !== item.gatewayClaimId || marker.binding !== item.gatewayBinding || marker.jobId !== item.gatewayJobId)) {
    throw new Error('Another Gateway claim needs review; this job remains held.');
  }
  return settings;
}

const artifactKey = (item) => `${item.gatewayBinding}/${item.gatewayClaimId}`;

async function storeGatewayReferences(jobId, references) {
  if (!Array.isArray(references) || !references.length) return;
  const stored = (await chrome.storage.local.get(GATEWAY_REFERENCES_KEY))[GATEWAY_REFERENCES_KEY] || {};
  stored[jobId] = references;
  await chrome.storage.local.set({ [GATEWAY_REFERENCES_KEY]: stored });
}

async function gatewayReferences(jobId, remove = false) {
  const stored = (await chrome.storage.local.get(GATEWAY_REFERENCES_KEY))[GATEWAY_REFERENCES_KEY] || {};
  const references = Array.isArray(stored[jobId]) ? stored[jobId] : [];
  if (remove && references.length) {
    delete stored[jobId];
    await chrome.storage.local.set({ [GATEWAY_REFERENCES_KEY]: stored });
  }
  return references;
}

async function settleGatewayClaim(item) {
  const marker = (await chrome.storage.local.get(GATEWAY_CLAIM_KEY))[GATEWAY_CLAIM_KEY];
  if (marker?.claimId && marker.claimId === item.gatewayClaimId && marker.binding === item.gatewayBinding && marker.jobId === item.gatewayJobId) {
    await chrome.storage.local.remove(GATEWAY_CLAIM_KEY);
  }
}

async function deliverGatewayArtifact(item, artifact) {
  const settings = await assertGatewayConnection(item);
  const health = await testGateway(settings);
  if (artifact.binding !== item.gatewayBinding || artifact.jobId !== item.gatewayJobId || !artifact.buffer?.byteLength) {
    throw new Error('Retained Gateway video does not match this claim; work is held.');
  }
  if (artifact.buffer.byteLength > health.maxResultBytes) {
    throw new Error(`Gateway video exceeds the advertised ${health.maxResultBytes} byte result limit; bytes are retained.`);
  }
  await assertGatewayConnection(item);
  await reportGatewayResult(settings, item.gatewayJobId, artifact.buffer, 'video/mp4');
  // Persist acceptance before cleanup: an interrupted cleanup must never upload again.
  await patchItem(item.id, { status: 'done', phase: 'done', gatewaySettled: true, finishedAt: Date.now(), error: undefined });
  await settleGatewayClaim(item);
  await deleteGatewayArtifact(artifactKey(item));
  await gatewayReferences(item.gatewayJobId, true);
  return `${item.gatewayJobId}.mp4`;
}

async function gatewayTick() {
  if (claiming) return null;
  claiming = true;
  try {
    await startupReady;
    const initial = await gatewaySettings();
    if (initial.mode !== 'gateway' || !initial.gatewayUrl || !initial.gatewayToken || processing || await isPaused()) return null;
    const queue = await getQueue();
    if (queue.some((item) => ['pending', 'running'].includes(item.status) || (item.gatewayJobId && !item.gatewaySettled))) return null;
    if ((await chrome.storage.local.get(GATEWAY_CLAIM_KEY))[GATEWAY_CLAIM_KEY]) {
      throw new Error('A Gateway claim has an uncertain outcome; review is required before claiming again.');
    }
    const { settings } = await connectGateway();
    const tabs = await chrome.tabs.query({ url: flowWorkspace(settings).match });
    if (!tabs.some((tab) => tab.status === 'complete')) {
      await writeStatus('Open the signed-in Flow workspace before claiming Gateway video work.', 'info');
      return null;
    }
    const binding = await gatewayBinding(settings);
    const current = await gatewaySettings();
    if (current.mode !== 'gateway' || await isPaused() || processing || await gatewayBinding(current) !== binding) return null;
    const claimId = createRandomId();
    await chrome.storage.local.set({ [GATEWAY_CLAIM_KEY]: { binding, claimId, at: Date.now() } });
    const job = await claimGatewayJob(settings);
    if (!job) {
      await chrome.storage.local.remove(GATEWAY_CLAIM_KEY);
      return null;
    }
    await chrome.storage.local.set({ [GATEWAY_CLAIM_KEY]: { binding, claimId, jobId: job.jobId, at: Date.now() } });
    const latest = await getQueue();
    if (isGatewayJobQueued(latest, job.jobId)) throw new Error('Gateway returned an already recorded job; the new claim remains held.');
    const item = { ...gatewayJobToItem(job, settings), gatewayBinding: binding, gatewayClaimId: claimId };
    await storeGatewayReferences(job.jobId, (job.referenceImages || []).filter((reference) => reference?.dataBase64));
    latest.push(item);
    await setQueue(latest);
    createAlarm();
    processQueue();
    return item;
  } catch (error) {
    await writeStatus(String(error?.message || error), 'err');
    throw error;
  } finally {
    claiming = false;
  }
}

async function syncGatewayAlarm() {
  try {
    const settings = await getSettings();
    if (settings.mode === 'gateway') {
      chrome.alarms?.create(GATEWAY_ALARM, { periodInMinutes: 0.5 });
      await gatewayTick().catch(() => {});
    } else {
      chrome.alarms?.clear(GATEWAY_ALARM);
    }
  } catch {
    // The mode simply does not start; the panel still shows the setting.
  }
}

async function patchItem(id, patch) {
  const queue = await getQueue();
  const item = queue.find((candidate) => candidate.id === id);
  if (item) Object.assign(item, patch);
  await setQueue(queue);
  if (item?.gatewayJobId) {
    assertGatewayConnection(item)
      .then((settings) => reportGatewayProgress(settings, item.gatewayJobId, item.phase, item.label))
      .catch(() => {});
  }
  return item;
}

async function ensureFlowTab() {
  const workspace = flowWorkspace(await getSettings());
  const tabs = await chrome.tabs.query({ url: workspace.match });
  const ready = tabs.find((tab) => tab.status === 'complete');
  if (ready) return ready;
  const tab = tabs[0] || (await chrome.tabs.create({ url: workspace.url, active: false }));
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
  const { origin } = flowWorkspace(await getSettings());
  if (!String(tab?.url || '').startsWith(`${origin}/`)) {
    throw new Error(`Refusing to run a Flow command outside ${origin}.`);
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
  const inventory = { ...inventoryResult(discovered.entries, discovered), observedSelection: discovered.observedSelection || null, refreshedAt: Date.now() };
  await chrome.storage.local.set({ [FLOW_MODEL_INVENTORY_KEY]: inventory });
  return { ok: true, ...inventory };
}

async function requireCurrentModel(modelKey, tab, mode) {
  const inventory = await refreshFlowModels(tab);
  return { ...resolveVideoModel(modelKey, inventory.models, mode), source: inventory.source };
}

async function createFlowProject() {
  const tab = await ensureFlowTab();
  const created = await runFlow(tab.id, 'createProject');
  await saveSettings({
    flowProjectId: created.projectId,
    flowProjectName: created.title || '',
  });
  await chrome.tabs.update(tab.id, {
    url: flowWorkspace(await getSettings()).project(created.projectId),
    autoDiscardable: false,
  });
  return { ok: true, ...created };
}

async function fetchVideo(tab, projectId, mediaId) {
  const media = await runFlow(tab.id, 'getMedia', { projectId, mediaId });
  const mediaUrl = new URL(String(media?.url || ''));
  if (
    mediaUrl.protocol !== 'https:' ||
    !(mediaUrl.hostname === 'flow-content.google' || mediaUrl.hostname.endsWith('.flow-content.google')) ||
    !mediaUrl.pathname.startsWith('/video/')
  ) {
    throw new Error('Flow returned an untrusted video URL.');
  }
  const response = await fetch(mediaUrl.href, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`Video retrieval failed (${response.status}).`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('video/')) throw new Error('Flow returned a non-video asset.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Video retrieval did not provide a readable body.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024 * 1024) throw new Error('Retrieved video exceeded 256 MB.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!size) throw new Error('Retrieved video was empty.');
  return new Blob(chunks, { type: contentType }).arrayBuffer();
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
  const mode = item.videoMode === 'text' ? 'text' : 'image';

  if (!item.videoMediaId) {
    if (Object.keys(item.unmappedFields || {}).length) {
      throw new Error('This video request contains unsupported fields. They were retained for review; no image or video was submitted.');
    }
    const model = await requireCurrentModel(item.videoModelKey, tab, mode);
    if (model.source !== 'live') {
      throw new Error('Live Flow model availability is unknown; the current model and duration request mapping is unverified. No image or video was submitted.');
    }
    const snapshot = snapshotVideoModel(model.key, [model], model.source, mode, item.durationSec);
    if (model.label !== item.videoModelLabel) {
      throw new Error('The selected Flow model changed. Refresh models and queue again.');
    }
    if (item.videoModelBinding && ['modelKey', 'mode', 'durationSec', 'rpcId'].some((key) => item.videoModelBinding[key] !== snapshot.videoModelBinding[key])) {
      throw new Error('The captured model and duration binding changed; review this queued video.');
    }
    item.videoModelBinding = snapshot.videoModelBinding;
    await patchItem(item.id, { videoModelBinding: item.videoModelBinding });
  }

  if (mode === 'image' && !item.startMediaId) {
    await patchItem(item.id, { phase: 'preparing' });
    if (item.gatewayJobId) {
      await assertGatewayConnection(item);
      const references = await gatewayReferences(item.gatewayJobId);
      if (references[0]) {
        await writeStatus(`${item.label}: uploading the reference image…`, 'running');
        const uploaded = await runFlow(tab.id, 'uploadImage', {
          projectId,
          base64: references[0].dataBase64,
          mime: references[0].mediaType || 'image/png',
          fileName: `${item.gatewayJobId}.png`,
        });
        item.startMediaId = uploaded.mediaId;
      } else {
        throw new Error('Gateway image-to-video reference is missing; no replacement image was generated.');
      }
      await patchItem(item.id, { startMediaId: item.startMediaId, phase: 'prepared' });
    } else if (item.videoSource === 'generate') {
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
      await patchItem(item.id, { startMediaId: item.startMediaId, phase: 'prepared' });
    }
  }

  if (!item.videoMediaId) {
    // Persist BEFORE the paid request. If the worker dies before receiving the
    // media id, startup quarantines this item instead of charging again.
    if (item.gatewayJobId) await assertGatewayConnection(item);
    await patchItem(item.id, { phase: 'submitting', submissionStartedAt: Date.now() });
    await writeStatus(`${item.label}: submitting paid video generation…`, 'running');
    if (item.gatewayJobId) await assertGatewayConnection(item);
    const submitted = await runFlow(tab.id, 'submitVideo', {
      projectId,
      mode,
      prompt: item.motionPrompt,
      mediaId: item.startMediaId,
      modelKey: item.videoModelKey,
      durationSec: item.durationSec,
      modelBinding: item.videoModelBinding,
      aspectRatio: item.aspectRatio,
    });
    if (typeof submitted?.mediaId !== 'string' || !submitted.mediaId.trim()) {
      throw new Error('Flow submission returned no video id; the paid outcome remains unknown.');
    }
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
    if (status.failed) throw new Error(`Flow video generation failed (status ${status.status}).`);
    if (Date.now() > deadline) throw new Error(`Video timed out (status ${status.status}).`);
    await writeStatus(`${item.label}: generating video…`, 'running');
    await sleep(10000);
  }

  await patchItem(item.id, { phase: item.target === 'download' ? 'downloading' : 'ingesting' });
  const mp4 = await fetchVideo(tab, projectId, item.videoMediaId);
  if (item.target === 'gateway') {
    const artifact = { binding: item.gatewayBinding, jobId: item.gatewayJobId, buffer: mp4 };
    await putGatewayArtifact(artifactKey(item), artifact);
    await patchItem(item.id, { phase: 'delivery_pending' });
    return deliverGatewayArtifact(item, artifact);
  }
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
  const mode = payload.videoMode === 'text' ? 'text' : 'image';
  const inventory = await refreshFlowModels();
  const queueModel = snapshotVideoModel(payload.videoModelKey, inventory.models, inventory.source, mode, payload.durationSec);
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
      sceneDurationSec: scene.durationSec,
      projectId,
      ...queueModel,
      videoMode: mode,
      videoSource: mode === 'image' ? payload.videoSource || settings.videoSource : null,
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
  const mode = payload?.videoMode === 'text' ? 'text' : 'image';
  const inventory = await refreshFlowModels();
  const queueModel = snapshotVideoModel(payload.videoModelKey, inventory.models, inventory.source, mode, payload.durationSec);
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
      projectId,
      ...queueModel,
      videoMode: mode,
      videoSource: mode === 'image' ? 'generate' : null,
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
    await startupReady;
    for (;;) {
      if (await isPaused()) break;
      const queue = await getQueue();
      const pending = queue.find((item) => item.status === 'pending');
      if (!pending) break;
      const settings = await getSettings();
      if (pending.gatewayJobId && settings.mode !== 'gateway') break;
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
        let artifact;
        if (current.gatewayJobId) {
          await assertGatewayConnection(current);
          artifact = await getGatewayArtifact(artifactKey(current));
          if (!artifact && current.phase === 'delivery_pending') throw new Error('Retained Gateway video is missing; work remains held.');
        }
        let savedAs;
        if (artifact) {
          savedAs = await deliverGatewayArtifact(current, artifact);
        } else {
          const tab = await ensureFlowTab();
          providerAttempted = true;
          savedAs = await generateAndSave(current, settings, tab);
        }
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
        if (current.gatewayJobId) {
          if (latest.gatewaySettled) {
            await writeStatus('Gateway accepted the video; retained-file cleanup needs attention.', 'err');
            break;
          }
          let settled = false;
          const uncertain = recovery.status === 'ambiguous' || Boolean(latest.videoMediaId) || latest.phase === 'delivery_pending';
          // A known video id or retained result is delivery work, never a definite unspent failure.
          if (!latest.videoMediaId && latest.phase !== 'delivery_pending') {
            try {
              const gateway = await assertGatewayConnection(latest);
              await reportGatewayFailure(gateway, latest.gatewayJobId, 'Video worker could not complete this job.', uncertain);
              settled = !uncertain;
            } catch { /* Unacknowledged ownership remains held. */ }
          }
          await patchItem(current.id, {
            status: recovery.status === 'ambiguous' ? 'ambiguous' : 'failed',
            ambiguityKind: recovery.ambiguityKind,
            gatewaySettled: settled,
            error: String(error?.message || error),
            finishedAt: Date.now(),
          });
          if (settled) await settleGatewayClaim(latest);
          await chrome.storage.local.set({ [PAUSED_KEY]: true });
          await writeStatus(settled ? 'Gateway acknowledged the failure; video queue paused.' : 'Gateway video is held; retained work will not regenerate automatically.', 'err');
          break;
        }
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
  if (item.gatewayJobId) {
    if (item.gatewaySettled || item.status === 'ambiguous') {
      return { ok: false, error: 'This Gateway job must be resolved in Gateway; generation will not be replayed here.' };
    }
    const gateway = await assertGatewayConnection(item);
    if (!item.videoMediaId && item.phase !== 'delivery_pending') {
      await reportGatewayFailure(gateway, item.gatewayJobId, 'Video worker could not complete this job.', false);
      item.gatewaySettled = true;
      await setQueue(queue);
      await settleGatewayClaim(item);
      return { ok: true };
    }
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
  await setQueue(queue.filter((item) => item.gatewayJobId || item.status !== 'pending'));
  return { ok: true };
}

async function recoverInterruptedJobs() {
  const queue = await getQueue();
  let changed = false;
  for (const item of queue) {
    if (item.gatewayJobId && item.gatewaySettled) {
      await settleGatewayClaim(item);
      await deleteGatewayArtifact(artifactKey(item));
      await gatewayReferences(item.gatewayJobId, true);
      continue;
    }
    if (item.status !== 'running') continue;
    changed = true;
    const recovery = classifyInterruptedItem(item);
    Object.assign(item, recovery);
    if (item.gatewayJobId && recovery.status !== 'ambiguous') {
      item.status = 'failed';
      item.error = 'Interrupted Gateway work is retained. Retry only resumes polling or result delivery.';
    }
  }
  if (changed) await setQueue(queue);
  if (queue.some((item) => item.status === 'pending')) createAlarm();
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
    case 'gatewayTest':
      reply(connectGateway().then(({ health }) => health));
      return true;
    case 'gatewayModeChanged':
      reply(syncGatewayAlarm().then(() => ({ ok: true })));
      return true;
    case 'gatewayClaimNow':
      reply(gatewayTick().then(() => ({ ok: true })));
      return true;
    default:
      return false;
  }
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === ALARM) processQueue();
  if (alarm.name === GATEWAY_ALARM) gatewayTick().catch(() => {});
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

const startupReady = recoverInterruptedJobs();
startupReady.then(() => {
  createFleetAlarm();
  syncGatewayAlarm();
  processQueue();
}).catch(() => writeStatus('Video recovery failed; retained work is held.', 'err'));
