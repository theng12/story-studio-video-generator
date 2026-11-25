import {
  getSettings,
  saveSettings,
  normalizeFlowProjectId,
  flowWorkspace,
  getGatewayToken,
} from './lib/config.js';
import { flowCommand } from './lib/flow-exec.js';
import { inventoryResult, resolveVideoModel, snapshotVideoModel } from './lib/video-models.js';
import { classifyInterruptedItem, hasActiveDuplicate, migrateStoredQueue, standaloneDownloadPath } from './lib/video-rules.js';
import { claimMarkerIsStale, gatewayJobToItem, isGatewayJobQueued } from './lib/gateway-worker.js';
import { claimGatewayJob, gatewayBinding, reportGatewayFailure, reportGatewayProgress, reportGatewayResult, reportGatewayTelemetry, testGateway } from './lib/gateway-client.js';
import { normalizeWorkerControl, observedAccount, observedQuote, workerObservation } from './lib/gateway-manager.js';
import { getGatewayArtifact, putGatewayArtifact, deleteGatewayArtifact } from './lib/gateway-artifacts.js';

const QUEUE_KEY = 'videoQueue';
const FLOW_MODEL_INVENTORY_KEY = 'flowVideoModelInventory';
const PAUSED_KEY = 'videoQueuePaused';
const STATUS_KEY = 'lastVideoStatus';
const NEXT_RUN_KEY = 'nextVideoProviderRunAt';
const COOLDOWN_KEY = 'videoProviderCooldownUntil';
const ALARM = 'videoQueueTick';
const GATEWAY_ALARM = 'gatewayWorkerTick';
const GATEWAY_REFERENCES_KEY = 'gatewayJobReferences';
const GATEWAY_CLAIM_KEY = 'gatewayUnsettledClaim';
const GATEWAY_CONTROL_KEY = 'gatewayAppliedControl';
const GATEWAY_DISPATCH_KEY = 'gatewayDispatchState';

let claiming = false;
let processing = false;
let sequence = 0;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isPaused = async () => Boolean((await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY]);

function createAlarm() {
  chrome.alarms?.create(ALARM, { periodInMinutes: 0.5 });
}

function clearAlarm() {
  chrome.alarms?.clear(ALARM);
}

function createRandomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function workerManagerTelemetry() {
  const [settings, stored] = await Promise.all([
    getSettings(), chrome.storage.local.get([NEXT_RUN_KEY, COOLDOWN_KEY, FLOW_MODEL_INVENTORY_KEY]),
  ]);
  return {
    account: {
      profileId: settings.providerAccountProfileId || null,
      identitySource: settings.providerAccountProfileId ? 'configured' : 'unknown',
      ready: null, creditBalance: null, creditResetAt: null,
    },
    pacing: {
      minimumSec: settings.humanDelayMinSec, maximumSec: settings.humanDelayMaxSec,
      nextGenerationAt: Number(stored[NEXT_RUN_KEY]) || 0,
      cooldownUntil: Number(stored[COOLDOWN_KEY]) || 0,
    },
    inventory: stored[FLOW_MODEL_INVENTORY_KEY] || null,
  };
}

async function writeStatus(text, kind = 'info', details = {}) {
  await chrome.storage.local.set({
    [STATUS_KEY]: { text, kind, timestamp: Date.now(), ...details },
  });
}

async function getQueue(recoverSubmissions = !processing) {
  const stored = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  const migrated = migrateStoredQueue(stored, { recoverSubmissions });
  if (migrated.changed) await chrome.storage.local.set({ [QUEUE_KEY]: migrated.queue });
  return migrated.queue;
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

// ── Gateway Studio worker mode ─────────────────────────────────────────────
// The second mode: the extension claims jobs instead of being driven from the
// panel. Standalone items never carry gatewayJobId, so the existing path runs
// unchanged.
async function gatewaySettings() {
  return { ...(await getSettings()), gatewayToken: await getGatewayToken() };
}

async function managerDispatchPaused(settings) {
  const saved = (await chrome.storage.local.get(GATEWAY_CONTROL_KEY))[GATEWAY_CONTROL_KEY];
  if (!saved) return settings.mode === 'gateway';
  const current = await gatewaySettings();
  try { return saved.binding !== await gatewayBinding(current) || !saved.dispatchEnabled; }
  catch { return true; }
}

// Gateway turning dispatch off is the whole reason this worker sits still, so it gets said once in
// each direction instead of every tick. A control we cannot tie to this connection proves nothing,
// so it is never reported as an off switch.
async function noteDispatchState(settings) {
  const saved = (await chrome.storage.local.get(GATEWAY_CONTROL_KEY))[GATEWAY_CONTROL_KEY];
  let disabled = null;
  if (saved) {
    try { disabled = saved.binding === await gatewayBinding(settings) ? !saved.dispatchEnabled : null; } catch { disabled = null; }
  }
  if (disabled === null) return;
  const last = (await chrome.storage.local.get(GATEWAY_DISPATCH_KEY))[GATEWAY_DISPATCH_KEY];
  if (last === disabled) return;
  await chrome.storage.local.set({ [GATEWAY_DISPATCH_KEY]: disabled });
  await writeStatus(
    disabled
      ? 'Gateway has dispatch turned off, so no video work is claimed until it is turned back on.'
      : 'Gateway dispatch is back on; this worker is claiming video work again.',
    'info',
    { source: 'gateway-dispatch', dispatchEnabled: !disabled },
  );
}

async function applyGatewayControl(raw, settings) {
  const binding = await gatewayBinding(settings);
  const previous = (await chrome.storage.local.get(GATEWAY_CONTROL_KEY))[GATEWAY_CONTROL_KEY];
  if (raw && previous?.binding === binding && previous.revision === raw.revision &&
      previous.dispatchEnabled === raw.dispatchEnabled && previous.closeRequested === (raw.closeRequested === true) &&
      settings.humanDelayMinSec === raw.pacing?.minSeconds && settings.humanDelayMaxSec === raw.pacing?.maxSeconds) return;
  // Stop dispatch before applying settings. A failed write must never acknowledge resume.
  await chrome.storage.local.set({ [GATEWAY_CONTROL_KEY]: { binding, dispatchEnabled: false, revision: null } });
  if (!raw) return;
  const control = normalizeWorkerControl(raw);
  const preserveLocalPacing = ((!previous || previous.binding !== binding) &&
    control.pacing.minSeconds === 5 && control.pacing.maxSeconds === 15 &&
    (settings.humanDelayMinSec !== 5 || settings.humanDelayMaxSec !== 15)) ||
    (previous?.preserveLocalPacing && previous.requestedRevision === control.revision);
  if (!preserveLocalPacing) await saveSettings({ humanDelayMinSec: control.pacing.minSeconds, humanDelayMaxSec: control.pacing.maxSeconds });
  const actual = await getSettings();
  const matches = actual.humanDelayMinSec === control.pacing.minSeconds && actual.humanDelayMaxSec === control.pacing.maxSeconds;
  await chrome.storage.local.set({ [GATEWAY_CONTROL_KEY]: { ...control, binding, preserveLocalPacing,
    dispatchEnabled: control.dispatchEnabled && matches,
    requestedRevision: control.revision, revision: matches ? control.revision : null } });
}

// The claim marker while it is still a real hold. One past Gateway's own lease is removed and
// reported as no hold, so the claim gate and telemetry agree on the same truth. `leaseSeconds` is
// the value the caller already read from Gateway's health; it is not fetched again here.
async function liveClaimMarker(leaseSeconds) {
  let marker = (await chrome.storage.local.get(GATEWAY_CLAIM_KEY))[GATEWAY_CLAIM_KEY];
  if (!marker) return null;
  // A marker saved before `at` existed cannot be proven old; stamp it once so it is bounded by
  // one lease from now instead of holding this worker until a person looks.
  if (!(Number(marker.at) > 0)) {
    marker = { ...marker, at: Date.now() };
    await chrome.storage.local.set({ [GATEWAY_CLAIM_KEY]: marker });
  }
  if (!claimMarkerIsStale(marker, leaseSeconds)) return marker;
  await chrome.storage.local.remove(GATEWAY_CLAIM_KEY);
  await writeStatus('The last Gateway claim went unanswered past its lease; it has expired and this worker will claim again.', 'err');
  return null;
}

async function gatewayObservation(settings, account = null, leaseSeconds) {
  const [queue, paused, stored] = await Promise.all([getQueue(), isPaused(),
    chrome.storage.local.get([GATEWAY_CLAIM_KEY, GATEWAY_CONTROL_KEY, NEXT_RUN_KEY, COOLDOWN_KEY])]);
  let control = stored[GATEWAY_CONTROL_KEY];
  if (control?.binding !== await gatewayBinding(settings)) control = null;
  if (control?.pacing?.minSeconds !== settings.humanDelayMinSec || control?.pacing?.maxSeconds !== settings.humanDelayMaxSec) control = control ? { ...control, revision: null } : null;
  // An expired marker is not a hold: reporting "recovering" while the worker goes on to claim
  // would tell Gateway this worker is stuck when it is not.
  const marker = await liveClaimMarker(leaseSeconds);
  return workerObservation(settings, { queue, paused, control, claim: marker,
    nextRunAt: Number(stored[NEXT_RUN_KEY]) || 0, cooldownUntil: Number(stored[COOLDOWN_KEY]) || 0 }, account);
}

async function applyBoundGatewayControl(control, requestSettings) {
  const current = await gatewaySettings();
  if (await gatewayBinding(current) !== await gatewayBinding(requestSettings)) {
    throw new Error('Gateway connection changed during the request; its control was not applied.');
  }
  await applyGatewayControl(control, current);
}

async function publishGatewayState(settings, account = null, leaseSeconds) {
  const current = await gatewaySettings();
  if (await gatewayBinding(current) !== await gatewayBinding(settings)) throw new Error('Gateway connection changed before telemetry.');
  const observation = await gatewayObservation(current, account, leaseSeconds);
  const response = await reportGatewayTelemetry(settings, observation);
  await applyBoundGatewayControl(response.control, settings);
  return observation;
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
  const connected = { ...settings, gatewayWorkerId: health.workerId };
  await applyBoundGatewayControl(health.control, connected);
  return { settings: await gatewaySettings(), health };
}

async function assertGatewayConnection(item, leaseSeconds) {
  const settings = await gatewaySettings();
  if (settings.mode !== 'gateway' || !item.gatewayBinding || await gatewayBinding(settings) !== item.gatewayBinding) {
    throw new Error('Gateway connection changed; restore the claiming connection before retrying this job.');
  }
  // Only a marker that is still a live hold may block this delivery; one past Gateway's lease
  // has been released there, so it must not keep retained work stuck here either.
  const marker = await liveClaimMarker(leaseSeconds);
  if (marker && (marker.claimId !== item.gatewayClaimId || marker.binding !== item.gatewayBinding || marker.jobId !== item.gatewayJobId)) {
    throw new Error('Another Gateway claim needs review; this job remains held.');
  }
  return settings;
}

async function assertProviderAccount(item, tab) {
  if (!item.gatewayJobId) return;
  if (!item.gatewayAccountBinding || !/^[0-9a-f]{64}$/.test(item.gatewayReservation?.payloadSha256 || '')) {
    throw new Error('Gateway generation has no observed quote/account reservation; no generation was submitted.');
  }
  const observed = observedAccount((await runFlow(tab.id, 'inspectAccount')).account, item.gatewayAccountMaxAgeSeconds);
  if (!observed || observed.provider !== item.gatewayAccountBinding.provider || observed.accountId !== item.gatewayAccountBinding.accountId ||
      observed.connection !== 'connected' || observed.signIn !== 'signed_in' || observed.readiness !== 'ready') {
    throw new Error('The actual provider account no longer matches the claimed account; no generation was submitted.');
  }
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
  await assertGatewayConnection(item, health.leaseSeconds);
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
    if (!initial.gatewayUrl || !initial.gatewayToken) return null;
    const { settings, health } = await connectGateway();
    await publishGatewayState(settings, null, health.leaseSeconds);
    // Connecting and reporting state in every mode is deliberate: a paired worker must stay visible
    // and stoppable from Gateway while stopped/not enabled. Only claiming is gated on Gateway mode.
    // The token is part of the connection binding, so the dispatch reading needs it too.
    const tickSettings = await gatewaySettings();
    if (tickSettings.mode !== 'gateway' || processing || await isPaused()) return null;
    await noteDispatchState(tickSettings);
    if (await managerDispatchPaused(tickSettings)) return null;
    const queue = await getQueue();
    if (queue.some((item) => ['pending', 'running'].includes(item.status) || (item.gatewayJobId && !item.gatewaySettled))) return null;
    // A live marker still blocks; one past Gateway's own lease has expired and this worker claims
    // again, so an uncertain claim no longer needs a person to unstick it.
    if (await liveClaimMarker(health.leaseSeconds)) {
      throw new Error('A Gateway claim has an uncertain outcome; review is required before claiming again.');
    }
    if (await holdForCooldown(initial, { label: 'Gateway video' }) || await waitForPacing(initial, { label: 'Gateway video' })) return null;
    const tabs = await chrome.tabs.query({ url: flowWorkspace(settings).match });
    if (!tabs.some((tab) => tab.status === 'complete')) {
      await writeStatus('Open the signed-in Flow workspace before claiming Gateway video work.', 'info');
      return null;
    }
    const binding = await gatewayBinding(settings);
    const current = await gatewaySettings();
    if (current.mode !== 'gateway' || await isPaused() || processing || await gatewayBinding(current) !== binding) return null;
    if (await holdForCooldown(current, { label: 'Gateway video' }) || await waitForPacing(current, { label: 'Gateway video' })) return null;
    const tab = tabs.find((entry) => entry.status === 'complete');
    const maxAge = health.accountMaxAgeSeconds;
    let inspected;
    try {
      inspected = await runFlow(tab.id, 'inspectAccount');
    } catch (error) {
      // Name the probe failure instead of looking like a signed-out worker.
      await writeStatus(`Flow is open but Relay could not read the account (${String(error?.message || error)}). Retrying on the next check.`, 'err');
      return null;
    }
    const account = Number.isFinite(maxAge) && maxAge > 0 ? observedAccount(inspected.account, maxAge) : null;
    await publishGatewayState(current, account, health.leaseSeconds);
    let observation = await gatewayObservation(await gatewaySettings(), account, health.leaseSeconds);
    if (!account || observation.telemetry.state.paused || !observation.telemetry.state.controlRevision ||
        account.connection !== 'connected' || account.signIn !== 'signed_in' || account.readiness !== 'ready') return null;
    const claimId = createRandomId();
    await chrome.storage.local.set({ [GATEWAY_CLAIM_KEY]: { binding, claimId, at: Date.now() } });
    let receipt = await claimGatewayJob(settings, observation);
    if (receipt) await applyBoundGatewayControl(receipt.control, settings);
    if (!receipt || receipt.quoteRequired) await chrome.storage.local.remove(GATEWAY_CLAIM_KEY);
    if (!receipt) return null;
    if (!receipt.quoteRequired) throw new Error('Gateway returned executable work without an observed quote; claim remains held.');
    // This preview is explicitly unclaimed. Never enqueue it or invoke generation.
    const preview = receipt.quoteRequired;
    const quoted = await runFlow(tab.id, 'inspectAccount', { preview });
    const currentAccount = observedAccount(quoted.account, maxAge);
    const quote = observedQuote(quoted.quote, currentAccount, preview, maxAge);
    if (!quote || currentAccount.provider !== account.provider || currentAccount.accountId !== account.accountId ||
        currentAccount.connection !== 'connected' || currentAccount.signIn !== 'signed_in' || currentAccount.readiness !== 'ready') {
      await writeStatus(`Preview not executed: ${quoted.reason || 'no exact provider quote or account observation'}.`, 'info');
      return null;
    }
    // The page's own price wins, but a disagreement with the rate table is reported
    // rather than resolved silently.
    if (quoted.pricing?.disagreement) {
      await writeStatus(`Flow's page quotes ${quoted.pricing.disagreement.page} credits where the rate table says ${quoted.pricing.disagreement.table}; the page is used.`, 'info');
    }
    observation = await gatewayObservation(await gatewaySettings(), currentAccount, health.leaseSeconds);
    if (await isPaused() || processing || await managerDispatchPaused(await getSettings()) ||
        await gatewayBinding(await gatewaySettings()) !== binding || !observation.telemetry.state.controlRevision ||
        await holdForCooldown(await getSettings(), { label: 'Gateway video' }) ||
        await waitForPacing(await getSettings(), { label: 'Gateway video' })) return null;
    await chrome.storage.local.set({ [GATEWAY_CLAIM_KEY]: { binding, claimId, at: Date.now() } });
    receipt = await claimGatewayJob(settings, observation, quote);
    if (receipt) await applyBoundGatewayControl(receipt.control, settings);
    if (!receipt || receipt.quoteRequired) { await chrome.storage.local.remove(GATEWAY_CLAIM_KEY); return null; }
    const job = receipt.job;
    await chrome.storage.local.set({ [GATEWAY_CLAIM_KEY]: { binding, claimId, jobId: job.jobId, at: Date.now() } });
    if (receipt.accountBinding?.provider !== currentAccount.provider || receipt.accountBinding?.accountId !== currentAccount.accountId ||
        receipt.reservation?.payloadSha256 !== quote.payloadSha256 || receipt.reservation?.value !== quote.value || receipt.reservation?.unit !== quote.unit) {
      throw new Error('Gateway reservation/account does not match the observed quote; ownership remains held.');
    }
    // The Gateway advertises claimMaxBytes; an oversized claim is refused before it is stored or run.
    const claimBytes = new TextEncoder().encode(JSON.stringify(job)).byteLength;
    if (Number.isSafeInteger(health.claimMaxBytes) && health.claimMaxBytes > 0 && claimBytes > health.claimMaxBytes) {
      throw new Error(`Gateway job is ${claimBytes} bytes; the advertised claim limit is ${health.claimMaxBytes}. It was not run.`);
    }
    const latest = await getQueue();
    if (isGatewayJobQueued(latest, job.jobId)) throw new Error('Gateway returned an already recorded job; the new claim remains held.');
    const item = { ...gatewayJobToItem(job, settings), gatewayBinding: binding, gatewayClaimId: claimId,
      gatewayAccountBinding: receipt.accountBinding, gatewayReservation: receipt.reservation, gatewayAccountMaxAgeSeconds: maxAge };
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
    if (settings.mode === 'gateway' || await getGatewayToken()) {
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
  const flowSettings = await getSettings();
  const { origin } = flowWorkspace(flowSettings);
  if (!String(tab?.url || '').startsWith(`${origin}/`)) {
    throw new Error(`Refusing to run a Flow command outside ${origin}.`);
  }
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: flowCommand,
    // The configured ids are only a fallback; the page resolves them from observed exchanges first.
    args: [{ op, payload: { ...payload, rpcFallback: flowSettings.rpcIds } }],
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
  if (settings.humanDelayMaxSec === 0) {
    await chrome.storage.local.remove(NEXT_RUN_KEY);
    return false;
  }
  const nextRunAt = Number((await chrome.storage.local.get(NEXT_RUN_KEY))[NEXT_RUN_KEY]) || 0;
  if (nextRunAt <= Date.now()) return false;
  await writeStatus(`Waiting before ${item.label}…`, 'info', { countdownUntil: nextRunAt, countdownReason: 'pacing' });
  chrome.alarms?.create(ALARM, { when: nextRunAt });
  return true;
}

async function setNextRun(settings, pauseMs) {
  if (pauseMs === undefined) {
    const minimum = settings.humanDelayMinSec;
    const maximum = settings.humanDelayMaxSec;
    pauseMs = Math.round((minimum + Math.random() * (maximum - minimum)) * 1000);
  }
  await chrome.storage.local.set({ [NEXT_RUN_KEY]: Date.now() + pauseMs });
  return pauseMs;
}

async function generationBoundary(item, tab) {
  const settings = await getSettings();
  if (await managerDispatchPaused(settings) || await holdForCooldown(settings, item) || await waitForPacing(settings, item)) {
    throw Object.assign(new Error('The next generation is waiting for its saved pause.'), { code: 'VIDEO_PACING_WAIT' });
  }
  await assertProviderAccount(item, tab);
  // Persist before the paid request so a worker restart cannot erase the pause.
  const pauseMs = await setNextRun(settings);
  await patchItem(item.id, { pendingGenerationPauseMs: pauseMs });
  return pauseMs;
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
    await chrome.storage.local.set({ [PAUSED_KEY]: true });
    await writeStatus('Generation service cooldown is active; queue paused for review.', 'info', { countdownUntil: Number(resumeAt), countdownReason: 'cooldown' });
    return true;
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
  const mode = item.videoMode === 'text' ? 'text' : 'image';

  if (!item.videoMediaId) {
    await assertProviderAccount(item, tab);
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

  if (!item.videoMediaId && mode === 'image' && !item.startMediaId) {
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
      const imagePauseMs = await generationBoundary(item, tab);
      await patchItem(item.id, { phase: 'image_submitting', imageSubmissionStartedAt: Date.now() });
      await writeStatus(`${item.label}: generating a start image…`, 'running');
      const generated = await runFlow(tab.id, 'generateImage', {
        projectId,
        prompt: item.imagePrompt || item.motionPrompt,
        model: item.imageModel || settings.imageModel,
        aspectRatio: item.aspectRatio,
        recaptchaMaxAttempts: 4,
      });
      if (typeof generated?.mediaId !== 'string' || !generated.mediaId.trim()) {
        throw new Error('Fresh-image generation returned no media id; its paid outcome remains unknown.');
      }
      item.startMediaId = generated.mediaId;
      await patchItem(item.id, { startMediaId: item.startMediaId, phase: 'prepared' });
      await setNextRun(settings, imagePauseMs);
    } else {
      // The removed Story Studio mode was the only producer of an existing
      // scene image. Legacy rows must be requeued rather than guess a source.
      throw new Error('This video needs a Story Studio scene image, and that mode was removed. Requeue it as a standalone prompt.');
    }
  }

  if (!item.videoMediaId) {
    // Persist BEFORE the paid request. If the worker dies before receiving the
    // media id, startup quarantines this item instead of charging again.
    if (item.gatewayJobId) await assertGatewayConnection(item);
    await generationBoundary(item, tab);
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

  await patchItem(item.id, { phase: 'downloading' });
  const mp4 = await fetchVideo(tab, projectId, item.videoMediaId);
  if (item.target === 'gateway') {
    const artifact = { binding: item.gatewayBinding, jobId: item.gatewayJobId, buffer: mp4 };
    await putGatewayArtifact(artifactKey(item), artifact);
    await patchItem(item.id, { phase: 'delivery_pending' });
    return deliverGatewayArtifact(item, artifact);
  }
  if (item.target !== 'download') {
    throw new Error('This video has no delivery target. Requeue it as a standalone prompt.');
  }
  const filename = `${String(item.downloadPath || 'StoryStudioVideos/Standalone/video.mp4').replace(/\.(mp4|webm)$/i, '')}.mp4`;
  await chrome.downloads.download({
    url: `data:video/mp4;base64,${bufferToBase64(mp4)}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return filename;
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
  await chrome.storage.local.remove(PAUSED_KEY);
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
      if (pending.startMediaId && !pending.videoMediaId && pending.phase === 'prepared' && Number.isFinite(pending.pendingGenerationPauseMs)) {
        await setNextRun(settings, pending.pendingGenerationPauseMs);
        await patchItem(pending.id, { pendingGenerationPauseMs: undefined });
      }
      if (!pending.videoMediaId && pending.phase !== 'delivery_pending' &&
          (await managerDispatchPaused(settings) || await holdForCooldown(settings, pending) || await waitForPacing(settings, pending))) {
        if (pending.gatewayJobId) {
          await patchItem(pending.id, { status: 'failed', error: 'Eligibility changed after claim; Gateway work is held for review.' });
          await chrome.storage.local.set({ [PAUSED_KEY]: true });
        }
        break;
      }
      if (await isPaused()) break;
      const current = await patchItem(pending.id, {
        status: 'running',
        startedAt: pending.startedAt || Date.now(),
      });
      if (!current) continue;
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
        if (error.code === 'VIDEO_PACING_WAIT') {
          await patchItem(current.id, { status: current.gatewayJobId ? 'failed' : 'pending', error: current.gatewayJobId ? 'Pacing changed after claim; Gateway work is held for review.' : undefined });
          if (current.gatewayJobId) await chrome.storage.local.set({ [PAUSED_KEY]: true });
          break;
        }
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
        const latest = (await getQueue()).find((item) => item.id === current.id);
        if (Number.isFinite(latest?.pendingGenerationPauseMs)) {
          await setNextRun(settings, latest.pendingGenerationPauseMs);
          await patchItem(current.id, { pendingGenerationPauseMs: undefined });
        }
      }
    }
    const queue = await getQueue();
    if (!queue.some((item) => ['pending', 'running'].includes(item.status))) {
      const nextRunAt = Number((await chrome.storage.local.get(NEXT_RUN_KEY))[NEXT_RUN_KEY]) || 0;
      if (nextRunAt > Date.now()) chrome.alarms?.create(ALARM, { when: nextRunAt });
      else clearAlarm();
    }
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
    if (item.status === 'done' && Number.isFinite(item.pendingGenerationPauseMs)) {
      await setNextRun(await getSettings(), item.pendingGenerationPauseMs);
      delete item.pendingGenerationPauseMs;
      changed = true;
    }
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
  if (queue.some((item) => item.status === 'ambiguous')) await chrome.storage.local.set({ [PAUSED_KEY]: true });
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
        Promise.all([getQueue(), isPaused(), chrome.storage.local.get(COOLDOWN_KEY), workerManagerTelemetry()]).then(([queue, paused, stored, manager]) => ({
          ok: true,
          queue,
          paused,
          cooldownUntil: Number(stored[COOLDOWN_KEY]) || 0,
          manager,
        }))
      );
      return true;
    case 'enqueueStandalone':
      reply(enqueueStandalone(message.payload));
      return true;
    case 'pauseQueue':
      reply(
        chrome.storage.local
          .set({ [PAUSED_KEY]: true })
          .then(() => ({ ok: true }))
      );
      return true;
    case 'resumeQueue':
      reply(
        chrome.storage.local.remove([PAUSED_KEY, COOLDOWN_KEY]).then(() => {
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
  if (alarm.name === ALARM) processQueue().then(() => gatewayTick()).catch(() => {});
  if (alarm.name === GATEWAY_ALARM) gatewayTick().catch(() => {});
});

try {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch {
  // Older Chrome versions do not support sidePanel.
}

const startupReady = recoverInterruptedJobs();
startupReady.then(() => {
  syncGatewayAlarm();
  processQueue();
}).catch(() => writeStatus('Video recovery failed; retained work is held.', 'err'));

// One account probe per worker start, delayed so it never races the first claim tick. A broken
// account read is named here instead of being discovered at the first claim.
async function accountProbeSelfCheck() {
  try {
    const settings = await getSettings();
    if (settings.mode !== 'gateway') return;
    const tabs = await chrome.tabs.query({ url: flowWorkspace(settings).match });
    const tab = tabs.find((entry) => entry.status === 'complete');
    if (!tab) return;
    try {
      await runFlow(tab.id, 'inspectAccount');
    } catch (error) {
      await writeStatus(`Account probe failed: ${String(error?.message || error)}. Claims retry after the next check; manual work still works.`, 'err');
    }
  } catch { /* best effort */ }
}
setTimeout(() => { accountProbeSelfCheck().catch(() => {}); }, 10000);
