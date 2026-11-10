// Actual MV3 background and transport; browser, storage and provider boundaries are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { FALLBACK_VIDEO_MODELS } from '../src/lib/video-models.js';
import { gatewayBinding } from '../src/lib/gateway-client.js';

const PROJECT = '5852b0c6-e4a4-455a-8215-5513c208c29d';
const MODEL = FALLBACK_VIDEO_MODELS.find((model) => model.key === 'abra_t2v_8s');
const JOB = { jobId: 'fixture-video', kind: 'video', videoMode: 'text', prompt: 'Slow push in.', modelKey: MODEL.key, modelLabel: MODEL.label, durationSec: 8, aspectRatio: '16:9', flowProjectId: PROJECT };
const VIDEO = Buffer.from('exact fixture video bytes');
const clone = (value) => value === undefined ? value : structuredClone(value);
const area = (state) => ({
  async get(keys) { return keys == null ? clone(state) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, clone(state[key])])); },
  async set(values) { Object.assign(state, clone(values)); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
});
function indexedStorage(rows) {
  return { rows, open() {
    const request = {};
    queueMicrotask(() => { request.result = { transaction() {
      const tx = { objectStore() {
        const operate = (fn) => {
          const entry = {};
          queueMicrotask(() => { entry.result = fn(globalThis.indexedDB.rows); tx.oncomplete?.(); });
          return entry;
        };
        return { get: (key) => operate((map) => clone(map.get(key))), put: (value, key) => operate((map) => { map.set(key, clone(value)); return key; }), delete: (key) => operate((map) => map.delete(key)) };
      } };
      return tx;
    } }; request.onsuccess?.(); });
    return request;
  } };
}
async function waitFor(predicate) {
  for (let n = 0; n < 400; n++) { if (predicate()) return; await pause(5); }
  throw new Error('Video background fixture timed out.');
}
async function boot({ local = {}, sync, rows = new Map(), mode = 'gateway', job = JOB, answers = [{ ok: true }], health = {}, failAnswer = { ok: true }, onClaim, onFlow, onTelemetry, claimReply, lostClaim = false, noTabs = false, storySave, assetReply, onTabs, flowReplies = {} } = {}) {
  sync ||= { videoSettings: { mode, gatewayUrl: 'http://127.0.0.1:49873', gatewayWorkerId: '', flowProjectId: PROJECT, humanDelayMinSec: 0, humanDelayMaxSec: 0, fleetEnabled: false } };
  const configuredToken = local.gatewayWorkerToken ?? 'fixture-token';
  // Isolate startup recovery from the explicit manager tick each test requests.
  local.gatewayWorkerToken = '';
  const desiredMode = sync.videoSettings.mode;
  sync.videoSettings.mode = 'studio';
  const prior = Object.fromEntries(['chrome', 'fetch', 'indexedDB'].map((key) => [key, globalThis[key]]));
  const calls = [], provider = [], downloads = [], alarms = [], scheduled = [];
  const control = Object.hasOwn(health, 'control') ? health.control : { revision: 'fixture-control', dispatchEnabled: true, closeRequested: false,
    pacing: { minSeconds: sync.videoSettings.humanDelayMinSec ?? 5, maxSeconds: sync.videoSettings.humanDelayMaxSec ?? 15 } };
  const account = () => ({ schema: 1, provider: 'flow', accountId: 'provider-observed-fixture', source: 'flow.account', observedAt: new Date(Date.now()).toISOString(),
    connection: 'connected', signIn: 'signed_in', readiness: 'ready',
    balance: { value: 10, unit: 'credits', source: 'flow.balance', observedAt: new Date(Date.now()).toISOString() } });
  let listener;
  globalThis.indexedDB = indexedStorage(rows);
  globalThis.chrome = {
    storage: { local: area(local), sync: area(sync) },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    alarms: { create(name, options) { scheduled.push({ name, ...options }); }, clear() {}, onAlarm: { addListener(fn) { alarms.push(fn); } } },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { query: async () => { await onTabs?.(sync); return noTabs ? [] : [{ id: 7, status: 'complete' }]; }, get: async () => ({ id: 7, url: `https://flow.google.com/project/${PROJECT}` }), create: async () => { throw new Error('Fixture refuses a new provider tab.'); } },
    scripting: { async executeScript({ args: [{ op, payload }] }) {
      provider.push({ op, payload });
      await onFlow?.(op, local, payload);
      const result = flowReplies[op] || {
        listVideoModels: { entries: FALLBACK_VIDEO_MODELS, signedIn: true, projectId: PROJECT },
        inspectAccount: { account: account(), quote: payload.preview ? { provider: 'flow', accountId: 'provider-observed-fixture',
          payloadSha256: payload.preview.payloadSha256, value: 1, unit: 'credits', source: 'flow.quote', observedAt: new Date(Date.now()).toISOString() } : null },
        uploadImage: { mediaId: 'start-media' },
        generateImage: { mediaId: 'start-media' },
        submitVideo: { mediaId: 'video-media' },
        checkVideo: { done: true },
        getMedia: { url: 'https://flow-content.google/video/fixture' },
      }[op];
      assert.ok(result, `Unexpected Flow command ${op}`);
      return [{ result: { ok: true, result } }];
    } },
    downloads: { async download(options) { downloads.push(options); return 17; } },
  };
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init }; calls.push(call);
    if (url === 'https://flow-content.google/video/fixture') return assetReply || new Response(VIDEO, { headers: { 'Content-Type': 'video/mp4' } });
    if (String(url).startsWith('http://localhost:8766/api/')) {
      assert.equal(mode, 'studio', 'Gateway/Standalone must not use Story credentials.');
      await storySave?.(call);
      return Response.json({ saved_as: 'fixture.mp4' });
    }
    assert.equal(new URL(url).origin, 'http://127.0.0.1:49873', 'No real network is permitted.');
    if (url.endsWith('/health')) return Response.json({ ok: true, workerId: 'fixture-worker', kind: 'video', maxResultBytes: 1024, leaseSeconds: 90, accountMaxAgeSeconds: 90, control, ...health });
    if (url.endsWith('/telemetry')) { await onTelemetry?.(local, sync); return Response.json({ ok: true, receivedAt: Date.now() / 1000, control }); }
    if (url.endsWith('/claim')) {
      const body = JSON.parse(init.body);
      if (body.quote || lostClaim) await onClaim?.(local, sync);
      if (lostClaim) throw new Error('Fixture lost claim response.');
      const custom = claimReply?.(body, control);
      if (custom) return Response.json(custom);
      if (!job) return new Response(null, { status: 204 });
      if (!body.quote) return Response.json({ job: null, quoteRequired: { job, payloadSha256: 'a'.repeat(64), executionAuthorized: false }, control });
      return Response.json({ job, accountBinding: { provider: body.account.provider, accountId: body.account.accountId },
        reservation: { payloadSha256: body.quote.payloadSha256, value: body.quote.value, unit: body.quote.unit }, control });
    }
    if (url.endsWith('/result')) {
      call.bytes = Buffer.from(await init.body.get('file').arrayBuffer());
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      return typeof answer === 'string' ? new Response(answer) : Response.json(answer);
    }
    if (url.endsWith('/progress')) return Response.json({ ok: true });
    if (url.endsWith('/fail')) return Response.json(failAnswer);
    throw new Error(`Unexpected fixture request ${url}`);
  };
  await import(`../src/background.js?video-runtime=${Date.now()}-${Math.random()}`);
  await pause(25);
  local.gatewayWorkerToken = configuredToken;
  sync.videoSettings.mode = desiredMode;
  return { local, sync, rows, calls, provider, downloads, scheduled, control, account,
    send(message) { return new Promise((resolve) => listener(message, {}, resolve)); },
    tick(name = 'gatewayWorkerTick') { for (const alarm of alarms) alarm({ name }); },
    async settled() { await pause(30); },
    restore() { for (const [key, value] of Object.entries(prior)) globalThis[key] = value; },
  };
}
const queueItem = (worker) => worker.local.videoQueue?.[0];
const count = (worker, suffix) => worker.calls.filter(({ url }) => url.endsWith(suffix)).length;
const generated = (worker) => worker.provider.filter(({ op }) => op === 'submitVideo').length;

for (const answer of [{ ok: false, ignored: true }, { ok: true, ignored: true }, 'not-json']) {
  test(`rejected result ${JSON.stringify(answer)} retains exact bytes; retry delivers without Flow`, async () => {
    const worker = await boot({ answers: [answer, { ok: true }] });
    try {
      assert.equal((await worker.send({ type: 'gatewayClaimNow' })).ok, true);
      await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
      assert.equal(queueItem(worker).phase, 'delivery_pending');
      assert.equal(queueItem(worker).gatewaySettled, false);
      assert.equal(worker.rows.size, 1);
      assert.equal(count(worker, '/fail'), 0);
      assert.equal(generated(worker), 1);
      const before = worker.provider.length;
      assert.equal((await worker.send({ type: 'retryItem', id: queueItem(worker).id })).ok, true);
      await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
      assert.equal(worker.provider.length, before);
      assert.equal(worker.rows.size, 0);
      assert.equal(worker.local.gatewayUnsettledClaim, undefined);
      assert.equal(queueItem(worker).gatewaySettled, true);
      for (const call of worker.calls.filter(({ url }) => url.endsWith('/result'))) assert.deepEqual(call.bytes, VIDEO);
    } finally { worker.restore(); }
  });
}

test('retained video survives worker restart and delivery succeeds without an open Flow tab', async () => {
  const first = await boot({ answers: [{ ok: false }] });
  await first.send({ type: 'gatewayClaimNow' });
  await waitFor(() => queueItem(first)?.status === 'failed'); await first.settled(); first.restore();
  queueItem(first).status = 'running';
  const second = await boot({ local: first.local, sync: first.sync, rows: first.rows, noTabs: true });
  try {
    assert.equal(queueItem(second).status, 'failed');
    await second.send({ type: 'retryItem', id: queueItem(second).id });
    await waitFor(() => queueItem(second)?.status === 'done'); await second.settled();
    assert.equal(second.provider.length, 0);
    assert.equal(count(second, '/claim'), 0);
    assert.deepEqual(second.calls.find(({ url }) => url.endsWith('/result')).bytes, VIDEO);
  } finally { second.restore(); }
});

test('changed token refuses result retry and retains all bytes and ownership', async () => {
  const worker = await boot({ answers: [{ ok: false }] });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    worker.local.gatewayWorkerToken = 'replacement-token';
    const before = worker.calls.length;
    const reply = await worker.send({ type: 'retryItem', id: queueItem(worker).id });
    assert.equal(reply.ok, false); assert.match(reply.error, /connection changed/);
    assert.equal(worker.calls.length, before); assert.equal(worker.rows.size, 1);
    assert.ok(worker.local.gatewayUnsettledClaim);
  } finally { worker.restore(); }
});

test('serial claims adopt authenticated worker id and busy queue admits one job', async () => {
  const worker = await boot();
  try {
    worker.sync.videoSettings.gatewayWorkerId = 'obsolete-random-id';
    await Promise.all([worker.send({ type: 'gatewayClaimNow' }), worker.send({ type: 'gatewayClaimNow' })]);
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    assert.equal(count(worker, '/claim'), 2); assert.equal(generated(worker), 1);
    const body = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/claim')).init.body);
    assert.equal(body.workerId, 'fixture-worker');
  } finally { worker.restore(); }
});

test('mode change during preflight refuses the claim', async () => {
  const worker = await boot({ onTabs(sync) { sync.videoSettings.mode = 'studio'; } });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); assert.equal(count(worker, '/claim'), 0);
    assert.equal(worker.local.gatewayUnsettledClaim, undefined); assert.equal(worker.provider.length, 0);
  } finally { worker.restore(); }
});

test('paused queue never claims', async () => {
  const worker = await boot({ local: { videoQueuePaused: true } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(count(worker, '/claim'), 0);
    assert.equal(JSON.parse(worker.calls.find(({ url }) => url.endsWith('/telemetry')).init.body).telemetry.state.paused, true);
  }
  finally { worker.restore(); }
});

test('explicit empty claim clears only the idle receipt and performs no provider work', async () => {
  const worker = await boot({ job: null });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(count(worker, '/claim'), 1); assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    assert.ok(worker.provider.every(({ op }) => op === 'inspectAccount'));
  } finally { worker.restore(); }
});

test('lost claim remains held through restart and cannot be polled again', async () => {
  const first = await boot({ lostClaim: true });
  const reply = await first.send({ type: 'gatewayClaimNow' });
  assert.equal(reply.ok, false); assert.ok(first.local.gatewayUnsettledClaim); first.restore();
  const second = await boot({ local: first.local, sync: first.sync });
  try { const held = await second.send({ type: 'gatewayClaimNow' }); assert.equal(held.ok, false); assert.equal(count(second, '/claim'), 0); }
  finally { second.restore(); }
});

test('duplicate completed row cannot clear a new claim hold or replay generation', async () => {
  const worker = await boot({ local: { videoQueue: [{ id: 'old', gatewayJobId: JOB.jobId, status: 'done', phase: 'done', gatewaySettled: true }] } });
  try {
    const reply = await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(reply.ok, false); assert.match(reply.error, /already recorded/);
    assert.ok(worker.local.gatewayUnsettledClaim?.claimId);
    assert.equal(generated(worker), 0);
    worker.tick(); await worker.settled(); assert.equal(count(worker, '/claim'), 2);
  } finally { worker.restore(); }
});

test('ignored failure acknowledgement stays held and retry only re-sends failure', async () => {
  const answer = { ok: false, ignored: true };
  const worker = await boot({ failAnswer: answer, onFlow(op) { if (op === 'listVideoModels') throw new Error('Fixture pre-submission failure.'); } });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.equal(queueItem(worker).gatewaySettled, false); assert.ok(worker.local.gatewayUnsettledClaim);
    answer.ok = true; answer.ignored = false;
    await worker.send({ type: 'retryItem', id: queueItem(worker).id });
    assert.equal(queueItem(worker).gatewaySettled, true); assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    assert.equal(generated(worker), 0); assert.equal(count(worker, '/fail'), 2);
  } finally { worker.restore(); }
});

test('unknown paid submission is held; explicit local retry cannot resubmit a Gateway job', async () => {
  const worker = await boot({ onFlow(op) { if (op === 'submitVideo') throw new Error('Fixture outcome unknown.'); } });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'ambiguous'); await worker.settled();
    const reply = await worker.send({ type: 'retryItem', id: queueItem(worker).id, acceptAmbiguousRisk: true });
    assert.equal(reply.ok, false); assert.equal(generated(worker), 1);
    assert.ok(worker.local.gatewayUnsettledClaim); assert.equal(queueItem(worker).gatewaySettled, false);
    const failure = worker.calls.find(({ url }) => url.endsWith('/fail'));
    assert.equal(JSON.parse(failure.init.body).ambiguous, true);
  } finally { worker.restore(); }
});

test('missing paid-submission id remains ambiguous and never becomes an unspent failure', async () => {
  const worker = await boot({ flowReplies: { submitVideo: {} } });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'ambiguous'); await worker.settled();
    assert.equal(generated(worker), 1); assert.equal(queueItem(worker).gatewaySettled, false);
    assert.equal(JSON.parse(worker.calls.find(({ url }) => url.endsWith('/fail')).init.body).ambiguous, true);
  } finally { worker.restore(); }
});

test('fallback inventory cannot authorize a Gateway paid submission', async () => {
  const worker = await boot({ flowReplies: { listVideoModels: { entries: [], signedIn: false } } });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.match(queueItem(worker).error, /availability is unknown/); assert.equal(generated(worker), 0);
    assert.equal(queueItem(worker).gatewaySettled, true);
  } finally { worker.restore(); }
});

test('Clear pending preserves Gateway-owned rows and references', async () => {
  const worker = await boot({ local: { videoQueuePaused: true, gatewayJobReferences: { owned: [{ dataBase64: 'fixture' }] }, videoQueue: [{ id: 'owned', gatewayJobId: 'owned', status: 'pending' }, { id: 'local', status: 'pending' }] } });
  try {
    await worker.send({ type: 'clearQueue' }); assert.deepEqual(worker.local.videoQueue.map(({ id }) => id), ['owned']);
    assert.ok(worker.local.gatewayJobReferences.owned);
  } finally { worker.restore(); }
});

test('Gateway result size uses advertised bound and retains oversized completed bytes', async () => {
  const worker = await boot({ health: { maxResultBytes: 1 } });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.match(queueItem(worker).error, /advertised 1 byte/); assert.equal(worker.rows.size, 1); assert.equal(count(worker, '/result'), 0);
  } finally { worker.restore(); }
});

test('oversized streamed video is cancelled before retaining an oversized chunk', async () => {
  let cancelled = false;
  const assetReply = { ok: true, headers: new Headers({ 'Content-Type': 'video/mp4' }), body: { getReader() { return {
    async read() { return { done: false, value: { byteLength: 256 * 1024 * 1024 + 1 } }; },
    async cancel() { cancelled = true; }, releaseLock() {},
  }; } } };
  const worker = await boot({ assetReply });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.match(queueItem(worker).error, /exceeded 256 MB/); assert.equal(cancelled, true);
    assert.equal(worker.rows.size, 0); assert.equal(count(worker, '/fail'), 0);
    assert.equal(queueItem(worker).videoMediaId, 'video-media');
  } finally { worker.restore(); }
});

test('requested duration must match the captured model key before paid submission', async () => {
  const worker = await boot({ job: { ...JOB, durationSec: 9 } });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.match(queueItem(worker).error, /duration does not match/); assert.equal(generated(worker), 0);
    assert.equal(queueItem(worker).gatewaySettled, true);
  } finally { worker.restore(); }
});

test('no open Flow workspace never claims or starts generation', async () => {
  const worker = await boot({ noTabs: true });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(count(worker, '/claim'), 0); assert.equal(worker.provider.length, 0);
    assert.match(worker.local.lastVideoStatus.text, /Open the signed-in Flow/);
  } finally { worker.restore(); }
});

test('image-to-video reference remains until accepted delivery and is never replaced by paid image generation', async () => {
  const imageModel = FALLBACK_VIDEO_MODELS.find(({ key }) => key === 'abra_r2v_10s');
  const reference = { mediaType: 'image/png', dataBase64: 'fixture-reference' };
  const worker = await boot({ job: { ...JOB, videoMode: 'image', modelKey: imageModel.key, modelLabel: imageModel.label, durationSec: 10, referenceImages: [reference] }, answers: [{ ok: false }, { ok: true }] });
  try {
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.deepEqual(worker.local.gatewayJobReferences[JOB.jobId], [reference]);
    assert.equal(worker.provider.filter(({ op }) => op === 'generateImage').length, 0);
    assert.equal(worker.provider.filter(({ op }) => op === 'uploadImage').length, 1);
    await worker.send({ type: 'retryItem', id: queueItem(worker).id });
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    assert.equal(worker.local.gatewayJobReferences[JOB.jobId], undefined); assert.equal(generated(worker), 1);
  } finally { worker.restore(); }
});

test('token change while claim is in flight prevents provider work', async () => {
  const worker = await boot({ onClaim(local) { local.gatewayWorkerToken = 'changed-token'; } });
  try {
    const response = await worker.send({ type: 'gatewayClaimNow' }); await worker.settled();
    assert.equal(response.ok, false); assert.match(response.error, /control was not applied/);
    assert.equal(worker.local.videoQueue?.length || 0, 0);
    assert.ok(worker.provider.every(({ op }) => op === 'inspectAccount')); assert.equal(count(worker, '/fail'), 0); assert.ok(worker.local.gatewayUnsettledClaim);
  } finally { worker.restore(); }
});

for (const durationSec of [4, 8]) {
  test(`Standalone ${durationSec}s selection reaches persisted row and Flow without a hardcoded length`, async () => {
    const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === 'text' && entry.durationSec === durationSec);
    const worker = await boot({ mode: 'standalone' });
    try {
      const result = await worker.send({ type: 'enqueueStandalone', payload: {
        prompts: ['Keep this length.'], projectId: PROJECT, videoMode: 'text', videoModelKey: model.key, durationSec,
      } });
      assert.equal(result.ok, true, result.error);
      await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
      const row = queueItem(worker);
      assert.equal(row.durationSec, durationSec);
      assert.equal(row.videoModelBinding.durationSec, durationSec);
      const payload = worker.provider.find(({ op }) => op === 'submitVideo').payload;
      assert.equal(payload.durationSec, durationSec);
      assert.deepEqual(payload.modelBinding, row.videoModelBinding);
      assert.equal(payload.modelKey, model.key);
      assert.equal(count(worker, '/claim'), 0);
    } finally { worker.restore(); }
  });
}

test('Story explicit clip length is bound separately from scene timeline length', async () => {
  const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === 'text' && entry.durationSec === 4);
  const worker = await boot({ mode: 'studio' });
  try {
    const result = await worker.send({ type: 'enqueueScenes', payload: {
      slug: 'fixture', episodeCode: 'E01', projectId: PROJECT, videoMode: 'text', videoModelKey: model.key,
      durationSec: 4, scenes: [{ id: 'scene-1', motionPrompt: 'Slow push.', durationSec: 12 }],
    } });
    assert.equal(result.ok, true, result.error);
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    assert.equal(queueItem(worker).durationSec, 4);
    assert.equal(queueItem(worker).sceneDurationSec, 12);
    assert.equal(worker.provider.find(({ op }) => op === 'submitVideo').payload.durationSec, 4);
    assert.equal(count(worker, '/upload-clip/scene-1'), 1);
  } finally { worker.restore(); }
});

for (const mode of ['studio', 'standalone']) {
  test(`${mode} historical fallback cannot authorize new image or video work`, async () => {
    const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === 'image');
    const row = { id: 'historical', status: 'pending', phase: 'queued', videoMode: 'image',
      videoModelKey: model.key, videoModelLabel: model.label, durationSec: model.durationSec,
      videoSource: 'generate', projectId: PROJECT, motionPrompt: 'Never submit historical transport.' };
    const worker = await boot({ mode, local: { videoQueue: [row] },
      flowReplies: { listVideoModels: { entries: [], signedIn: true, projectId: PROJECT } },
    });
    try {
      await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
      assert.match(queueItem(worker).error, /current model and duration request mapping is unverified/);
      assert.equal(queueItem(worker).durationSec, model.durationSec);
      assert.equal(queueItem(worker).videoModelKey, model.key);
      assert.equal(worker.provider.filter(({ op }) => ['submitVideo', 'generateImage', 'uploadImage'].includes(op)).length, 0);
    } finally { worker.restore(); }
  });
}

test('unknown Gateway controls are retained and refuse provider work without a default substitution', async () => {
  const worker = await boot({ job: { ...JOB, futureControl: { value: 'unmapped' }, sceneDurationSec: 12 } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    const row = queueItem(worker);
    assert.deepEqual(row.unmappedFields, { futureControl: { value: 'unmapped' }, sceneDurationSec: 12 });
    assert.equal(row.durationSec, JOB.durationSec);
    assert.match(row.error, /unsupported fields.*retained for review/);
    assert.equal(worker.provider.filter(({ op }) => ['submitVideo', 'generateImage', 'uploadImage'].includes(op)).length, 0);
    assert.equal(row.gatewaySettled, true);
  } finally { worker.restore(); }
});

test('unverified Standalone duration is refused before queueing or fresh-image generation', async () => {
  const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === 'image');
  const worker = await boot({ mode: 'standalone' });
  try {
    const reply = await worker.send({ type: 'enqueueStandalone', payload: {
      prompts: ['Never generate.'], projectId: PROJECT, videoMode: 'image', videoModelKey: model.key, durationSec: 6,
    } });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /unavailable/);
    assert.equal(worker.local.videoQueue?.length || 0, 0);
    assert.equal(worker.provider.filter(({ op }) => ['submitVideo', 'generateImage', 'uploadImage'].includes(op)).length, 0);
  } finally { worker.restore(); }
});

test('queue restart retains duration and binding and refuses a changed request mapping', async () => {
  const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === 'text' && entry.durationSec === 4);
  const binding = { modelKey: model.key, mode: 'text', durationSec: 4, rpcId: 'YhhmEf' };
  const row = { id: 'restart-duration', status: 'running', phase: 'queued', videoMode: 'text',
    videoModelKey: model.key, videoModelLabel: model.label, videoModelBinding: binding, durationSec: 4,
    target: 'download', projectId: PROJECT, motionPrompt: 'Keep the exact selection.' };
  const worker = await boot({ mode: 'standalone', local: { videoQueuePaused: true, videoQueue: [row] },
    flowReplies: { listVideoModels: { entries: [{ ...model, durationSec: 6 }], signedIn: true, projectId: PROJECT } },
  });
  try {
    const stored = (await worker.send({ type: 'getQueue' })).queue[0];
    assert.equal(stored.status, 'pending');
    assert.equal(stored.durationSec, 4);
    assert.deepEqual(stored.videoModelBinding, binding);
    await worker.send({ type: 'resumeQueue' });
    await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.equal(queueItem(worker).durationSec, 4);
    assert.deepEqual(queueItem(worker).videoModelBinding, binding);
    assert.match(queueItem(worker).error, /duration does not match/);
    assert.equal(generated(worker), 0);
  } finally { worker.restore(); }
});

for (const mode of ['studio', 'standalone']) {
  test(`${mode} still polls known video and saves exact bytes without Gateway requests`, async () => {
    const item = { id: 'local-video', status: 'pending', phase: 'polling', videoMediaId: 'known-video', projectId: PROJECT, videoMode: 'text', sceneId: 'scene-1', slug: 'fixture', episodeCode: 'E01', label: 'Fixture video', target: mode === 'standalone' ? 'download' : undefined, downloadPath: 'StoryStudioVideos/Standalone/fixture.mp4' };
    const worker = await boot({ mode, local: { videoQueue: [item] }, storySave(call) { assert.deepEqual(Buffer.from(call.init.body), VIDEO); } });
    try {
      await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
      assert.equal(count(worker, '/claim'), 0); assert.equal(generated(worker), 0);
      if (mode === 'standalone') {
        assert.equal(worker.downloads[0].filename, item.downloadPath);
        assert.deepEqual(Buffer.from(worker.downloads[0].url.split(',')[1], 'base64'), VIDEO);
      } else assert.equal(count(worker, '/upload-clip/scene-1'), 1);
    } finally { worker.restore(); }
  });
}

// Synthetic inventory and a controlled clock exercise scheduling, never real paid work.
function pacingClock(t) {
  const original = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  t.after(() => { Date.now = original; });
  return { advanceTo(value) { now = value; } };
}
function pacedSync(mode = 'standalone', extra = {}) {
  return { videoSettings: { mode, gatewayUrl: 'http://127.0.0.1:49873', flowProjectId: PROJECT,
    humanDelayMinSec: 5, humanDelayMaxSec: 15, fleetEnabled: false, ...extra } };
}
function pacedRow(id = 'paced-video', extra = {}) {
  return { id, label: id, status: 'pending', phase: 'queued', videoMode: 'text',
    videoModelKey: MODEL.key, videoModelLabel: MODEL.label, durationSec: MODEL.durationSec,
    projectId: PROJECT, target: 'download', motionPrompt: 'Offline pacing fixture.', ...extra };
}

test('first generation is immediate; next deadline persists across restart and native alarm', async (t) => {
  const clock = pacingClock(t);
  let worker = await boot({ sync: pacedSync(), local: { videoQueue: [pacedRow('one'), pacedRow('two')] },
    onFlow(op, local) { if (op === 'submitVideo') assert.ok(local.nextVideoProviderRunAt > Date.now()); } });
  try {
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    assert.equal(generated(worker), 1);
    assert.equal(worker.local.videoQueue[1].status, 'pending');
    const next = worker.local.nextVideoProviderRunAt;
    assert.ok(next >= Date.now() + 5000 && next <= Date.now() + 15000);
    assert.ok(worker.scheduled.some((alarm) => alarm.name === 'videoQueueTick' && alarm.when === next));
    const state = { local: worker.local, sync: worker.sync };
    worker.restore();
    worker = await boot(state);
    assert.equal(generated(worker), 0);
    assert.equal(worker.local.nextVideoProviderRunAt, next);
    clock.advanceTo(next);
    worker.tick('videoQueueTick');
    await waitFor(() => worker.local.videoQueue[1].status === 'done'); await worker.settled();
    assert.equal(generated(worker), 1);
  } finally { worker.restore(); }
});

test('explicit zero override clears an old deadline and runs consecutive generations', async (t) => {
  pacingClock(t);
  const worker = await boot({ sync: pacedSync('standalone', { humanDelayMinSec: 0, humanDelayMaxSec: 0 }),
    local: { nextVideoProviderRunAt: Date.now() + 60000, videoQueue: [pacedRow('one'), pacedRow('two')] } });
  try {
    await waitFor(() => worker.local.videoQueue.every((row) => row.status === 'done')); await worker.settled();
    assert.equal(generated(worker), 2);
    assert.ok(!worker.scheduled.some((alarm) => alarm.when > Date.now()));
    assert.equal(worker.sync.videoSettings.humanDelayMaxSec, 0);
  } finally { worker.restore(); }
});

test('fresh image finishes then pauses before video; restart reuses its media id', async (t) => {
  const clock = pacingClock(t);
  const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === 'image');
  let worker = await boot({ sync: pacedSync(), local: { videoQueue: [pacedRow('fresh-image', {
    videoMode: 'image', videoSource: 'generate', videoModelKey: model.key, videoModelLabel: model.label, durationSec: model.durationSec,
  })] } });
  try {
    await waitFor(() => queueItem(worker)?.startMediaId && queueItem(worker).status === 'pending'); await worker.settled();
    assert.equal(worker.provider.filter(({ op }) => op === 'generateImage').length, 1);
    assert.equal(generated(worker), 0);
    const next = worker.local.nextVideoProviderRunAt;
    assert.ok(next > Date.now());
    const state = { local: worker.local, sync: worker.sync };
    worker.restore(); clock.advanceTo(next);
    worker = await boot(state);
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    assert.equal(worker.provider.filter(({ op }) => op === 'generateImage').length, 0);
    assert.equal(generated(worker), 1);
    assert.equal(worker.provider.find(({ op }) => op === 'submitVideo').payload.mediaId, 'start-media');
  } finally { worker.restore(); }
});

test('known paid media keeps its sampled completion pause after restart, without image replay', async (t) => {
  pacingClock(t);
  const worker = await boot({ sync: pacedSync(), local: { nextVideoProviderRunAt: Date.now() - 1,
    videoQueue: [pacedRow('recover', { status: 'running', phase: 'polling', videoMode: 'image', videoSource: 'generate',
      videoMediaId: 'known-video', pendingGenerationPauseMs: 11000 }), pacedRow('next')] } });
  try {
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    assert.equal(generated(worker), 0);
    assert.equal(worker.provider.filter(({ op }) => op === 'generateImage').length, 0);
    assert.equal(worker.local.nextVideoProviderRunAt, Date.now() + 11000);
    assert.equal(worker.local.videoQueue[1].status, 'pending');
    assert.equal(queueItem(worker).pendingGenerationPauseMs, undefined);
  } finally { worker.restore(); }
});

test('known-media recovery without a new generation does not extend an existing gap or cooldown', async (t) => {
  pacingClock(t);
  const next = Date.now() + 9000, cooldown = Date.now() + 45000;
  const worker = await boot({ sync: pacedSync(), local: { nextVideoProviderRunAt: next, videoProviderCooldownUntil: cooldown,
    videoQueue: [pacedRow('poll-only', { phase: 'polling', videoMediaId: 'known-video' })] } });
  try {
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    assert.equal(generated(worker), 0);
    assert.equal(worker.local.nextVideoProviderRunAt, next);
    assert.equal(worker.local.videoProviderCooldownUntil, cooldown);
  } finally { worker.restore(); }
});

test('preflight refusal never samples a generation pause', async (t) => {
  pacingClock(t);
  const worker = await boot({ sync: pacedSync(), local: { videoQueue: [pacedRow()] },
    flowReplies: { listVideoModels: { entries: [], signedIn: true, projectId: PROJECT } } });
  try {
    await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.equal(generated(worker), 0);
    assert.equal(worker.local.nextVideoProviderRunAt, undefined);
  } finally { worker.restore(); }
});

test('Gateway waits before claim, rechecks a changed deadline after preflight, and claims once eligible', async (t) => {
  const clock = pacingClock(t);
  let moved = false;
  const worker = await boot({ sync: pacedSync('gateway'), local: { nextVideoProviderRunAt: Date.now() + 6000 },
    onTabs() { if (!moved) { moved = true; worker.local.nextVideoProviderRunAt = Date.now() + 8000; } } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(count(worker, '/claim'), 0); assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    clock.advanceTo(worker.local.nextVideoProviderRunAt);
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(count(worker, '/claim'), 0); assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    clock.advanceTo(worker.local.nextVideoProviderRunAt);
    await Promise.all([worker.send({ type: 'gatewayClaimNow' }), worker.send({ type: 'gatewayClaimNow' })]);
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    assert.equal(count(worker, '/claim'), 2); assert.equal(generated(worker), 1);
  } finally { worker.restore(); }
});

for (const autoResume of [false, true]) {
  test(`provider cooldown stays authoritative before claims (auto-resume ${autoResume})`, async (t) => {
    const clock = pacingClock(t);
    const until = Date.now() + 30000;
    const worker = await boot({ sync: pacedSync('gateway', { humanDelayMinSec: 0, humanDelayMaxSec: 0,
      providerCooldown: { autoResume, minutes: 15 } }), local: { videoProviderCooldownUntil: until } });
    try {
      await worker.send({ type: 'gatewayClaimNow' });
      assert.equal(count(worker, '/claim'), 0);
      assert.equal(worker.local.videoProviderCooldownUntil, until);
      if (!autoResume) {
        assert.equal(worker.local.videoQueuePaused, true);
        clock.advanceTo(until); worker.tick(); await worker.settled();
        assert.equal(count(worker, '/claim'), 0);
      } else {
        clock.advanceTo(until); worker.tick();
        await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
        assert.equal(count(worker, '/claim'), 2);
      }
    } finally { worker.restore(); }
  });
}

test('unknown paid outcome keeps claim and queue held despite elapsed pacing', async (t) => {
  const clock = pacingClock(t);
  const worker = await boot({ sync: pacedSync('gateway'), onFlow(op) {
    if (op === 'submitVideo') throw new Error('Fixture lost paid submission response.');
  } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    await waitFor(() => queueItem(worker)?.status === 'ambiguous'); await worker.settled();
    assert.equal(queueItem(worker).phase, 'submitting');
    assert.equal(worker.local.videoQueuePaused, true);
    assert.ok(worker.local.gatewayUnsettledClaim);
    assert.equal(JSON.parse(worker.calls.find(({ url }) => url.endsWith('/fail')).init.body).ambiguous, true);
    clock.advanceTo(worker.local.nextVideoProviderRunAt + 60000);
    worker.tick('videoQueueTick'); await worker.settled();
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(count(worker, '/claim'), 2); assert.equal(generated(worker), 1);
  } finally { worker.restore(); }
});

test('eligibility changed while claiming holds ownership for review without a delayed paid request', async (t) => {
  const clock = pacingClock(t);
  const worker = await boot({ sync: pacedSync('gateway'), onClaim(local) { local.nextVideoProviderRunAt = Date.now() + 60000; } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.match(queueItem(worker).error, /Eligibility changed after claim/);
    assert.equal(worker.local.videoQueuePaused, true);
    assert.ok(worker.local.gatewayUnsettledClaim);
    assert.equal(generated(worker), 0);
    clock.advanceTo(worker.local.nextVideoProviderRunAt);
    worker.tick('videoQueueTick'); await worker.settled();
    assert.equal(count(worker, '/claim'), 2); assert.equal(generated(worker), 0);
  } finally { worker.restore(); }
});

test('restart immediately after a fresh image preserves a completion gap before its video', async (t) => {
  pacingClock(t);
  const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === 'image');
  const worker = await boot({ sync: pacedSync(), local: { nextVideoProviderRunAt: Date.now() - 1,
    videoQueue: [pacedRow('image-checkpoint', { status: 'running', phase: 'prepared', videoMode: 'image', videoSource: 'generate',
      videoModelKey: model.key, videoModelLabel: model.label, durationSec: model.durationSec,
      startMediaId: 'saved-start-image', pendingGenerationPauseMs: 7000 })] } });
  try {
    await worker.settled();
    assert.equal(queueItem(worker).status, 'pending');
    assert.equal(worker.local.nextVideoProviderRunAt, Date.now() + 7000);
    assert.equal(queueItem(worker).pendingGenerationPauseMs, undefined);
    assert.equal(generated(worker), 0);
    assert.equal(worker.provider.length, 0);
  } finally { worker.restore(); }
});

test('a cooldown appearing during model preflight stops the actual generation boundary', async (t) => {
  pacingClock(t);
  const worker = await boot({ sync: pacedSync(), local: { videoQueue: [pacedRow()] }, onFlow(op, local) {
    if (op === 'listVideoModels') local.videoProviderCooldownUntil = Date.now() + 60000;
  } });
  try {
    await worker.settled();
    assert.equal(generated(worker), 0);
    assert.equal(queueItem(worker).status, 'pending');
    assert.equal(worker.local.videoQueuePaused, true);
    assert.equal(worker.local.nextVideoProviderRunAt, undefined);
  } finally { worker.restore(); }
});

test('restart between completion and finally retains the sampled gap before another job', async (t) => {
  pacingClock(t);
  const worker = await boot({ sync: pacedSync(), local: { nextVideoProviderRunAt: Date.now() - 1,
    videoQueue: [pacedRow('completed', { status: 'done', phase: 'done', videoMediaId: 'completed-video', pendingGenerationPauseMs: 9500 }), pacedRow('next')] } });
  try {
    await worker.settled();
    assert.equal(worker.local.nextVideoProviderRunAt, Date.now() + 9500);
    assert.equal(queueItem(worker).pendingGenerationPauseMs, undefined);
    assert.equal(worker.local.videoQueue[1].status, 'pending');
    assert.equal(generated(worker), 0);
  } finally { worker.restore(); }
});

for (const phase of ['image_submitting', 'submitting']) {
  test(`restart during ${phase} pauses subsequent jobs instead of treating elapsed pacing as clearance`, async (t) => {
    pacingClock(t);
    const worker = await boot({ sync: pacedSync(), local: { nextVideoProviderRunAt: Date.now() - 1,
      videoQueue: [pacedRow('unknown', { status: 'running', phase, pendingGenerationPauseMs: 5000 }), pacedRow('next')] } });
    try {
      await worker.settled();
      assert.equal(queueItem(worker).status, 'ambiguous');
      assert.equal(worker.local.videoQueuePaused, true);
      assert.equal(worker.local.videoQueue[1].status, 'pending');
      assert.equal(worker.provider.length, 0);
    } finally { worker.restore(); }
  });
}

test('fresh-image reply without a media id stays held and never submits its video', async (t) => {
  pacingClock(t);
  const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === 'image');
  const worker = await boot({ sync: pacedSync(), local: { videoQueue: [pacedRow('unknown-image', {
    videoMode: 'image', videoSource: 'generate', videoModelKey: model.key, videoModelLabel: model.label, durationSec: model.durationSec,
  })] }, flowReplies: { generateImage: {} } });
  try {
    await waitFor(() => queueItem(worker)?.status === 'ambiguous'); await worker.settled();
    assert.equal(queueItem(worker).ambiguityKind, 'image');
    assert.equal(worker.local.videoQueuePaused, true);
    assert.equal(generated(worker), 0);
    assert.equal(worker.provider.filter(({ op }) => op === 'generateImage').length, 1);
  } finally { worker.restore(); }
});

const lastTelemetry = (worker) => JSON.parse(worker.calls.filter(({ url }) => url.endsWith('/telemetry')).at(-1).init.body);

test('unbound provider reports state independently and never treats a profile label as account proof', async () => {
  const worker = await boot({ sync: pacedSync('gateway', { providerAccountProfileId: 'configured-only' }),
    flowReplies: { inspectAccount: { account: null, quote: null } } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    const report = lastTelemetry(worker);
    assert.equal(Object.hasOwn(report, 'account'), false);
    assert.equal(report.telemetry.state.signIn, 'unknown');
    assert.equal(report.telemetry.state.readiness, 'unknown');
    assert.ok(!JSON.stringify(report).includes('configured-only'));
    assert.equal(count(worker, '/claim'), 0); assert.equal(generated(worker), 0);
    assert.equal(worker.local.gatewayUnsettledClaim, undefined);
  } finally { worker.restore(); }
});

test('missing manager control stays OFF without a revision acknowledgement', async () => {
  const worker = await boot({ health: { control: null } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(lastTelemetry(worker).telemetry.state.paused, true);
    assert.equal(lastTelemetry(worker).telemetry.state.controlRevision, null);
    assert.equal(worker.local.gatewayAppliedControl.dispatchEnabled, false);
    assert.equal(count(worker, '/claim'), 0); assert.equal(worker.provider.length, 0);
  } finally { worker.restore(); }
});

test('unclaimed preview without an exact quote never becomes queued or generated work', async () => {
  const replies = {};
  const worker = await boot({ flowReplies: replies, onFlow(op, _local, payload) {
    if (op === 'inspectAccount' && payload.preview) replies.inspectAccount = { account: worker.account(), quote: null };
  } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(count(worker, '/claim'), 1);
    assert.equal(worker.local.videoQueue?.length || 0, 0);
    assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    assert.equal(generated(worker), 0);
    assert.ok(worker.provider.every(({ op }) => op === 'inspectAccount'));
  } finally { worker.restore(); }
});

test('quoted executable claim carries same-request observed account and applied revision', async () => {
  const worker = await boot();
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    const bodies = worker.calls.filter(({ url }) => url.endsWith('/claim')).map(({ init }) => JSON.parse(init.body));
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].quote, undefined);
    assert.equal(bodies[1].account.provider, bodies[1].quote.provider);
    assert.equal(bodies[1].account.accountId, bodies[1].quote.accountId);
    assert.equal(bodies[1].telemetry.state.controlRevision, worker.control.revision);
    assert.equal(bodies[1].telemetry.state.paused, false);
    assert.ok(Date.parse(bodies[1].telemetry.state.nextEligibleAt) <= Date.now());
    assert.equal(generated(worker), 1);
  } finally { worker.restore(); }
});

test('stop acknowledgement reports active generation, then safe idle state without killing or replaying work', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const worker = await boot({ onFlow: async (op) => { if (op === 'submitVideo') await blocked; } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    await waitFor(() => generated(worker) === 1);
    Object.assign(worker.control, { revision: 'stop-revision', dispatchEnabled: false, closeRequested: true });
    await worker.send({ type: 'gatewayClaimNow' });
    let state = lastTelemetry(worker).telemetry.state;
    assert.equal(state.controlRevision, 'stop-revision'); assert.equal(state.paused, true);
    assert.equal(state.activity, 'generating'); assert.equal(state.nextEligibleAt, null);
    assert.ok(worker.local.gatewayUnsettledClaim);
    release(); await waitFor(() => queueItem(worker)?.status === 'done'); await worker.settled();
    await worker.send({ type: 'gatewayClaimNow' });
    state = lastTelemetry(worker).telemetry.state;
    assert.equal(state.activity, 'idle'); assert.equal(state.paused, true);
    assert.equal(state.controlRevision, 'stop-revision');
    assert.equal(count(worker, '/claim'), 2); assert.equal(generated(worker), 1);
  } finally { release(); worker.restore(); }
});

test('persistent manager OFF survives restart and local resume cannot override it', async () => {
  let worker = await boot({ health: { control: { revision: 'off-revision', dispatchEnabled: false, closeRequested: true, pacing: { minSeconds: 0, maxSeconds: 0 } } } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    const saved = { local: worker.local, sync: worker.sync, health: { control: worker.control } };
    saved.local.videoQueue = [pacedRow('remain-pending')];
    worker.restore(); worker = await boot(saved);
    await worker.send({ type: 'resumeQueue' }); await worker.settled();
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(generated(worker), 0); assert.equal(count(worker, '/claim'), 0);
    assert.equal(queueItem(worker).status, 'pending');
    assert.equal(lastTelemetry(worker).telemetry.state.paused, true);
    assert.equal(lastTelemetry(worker).telemetry.state.controlRevision, 'off-revision');
  } finally { worker.restore(); }
});

test('initial manager default preserves custom zero and withholds ack until desired pacing matches', async () => {
  const worker = await boot({ job: null, health: { control: { revision: 'default-revision', dispatchEnabled: true, closeRequested: false,
    pacing: { minSeconds: 5, maxSeconds: 15 } } } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(worker.sync.videoSettings.humanDelayMaxSec, 0);
    assert.equal(lastTelemetry(worker).telemetry.state.controlRevision, null);
    assert.equal(lastTelemetry(worker).telemetry.state.paused, true);
    assert.equal(count(worker, '/claim'), 0);
    Object.assign(worker.control, { revision: 'explicit-zero', pacing: { minSeconds: 0, maxSeconds: 0 } });
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(lastTelemetry(worker).telemetry.state.controlRevision, 'explicit-zero');
    assert.deepEqual(lastTelemetry(worker).telemetry.state.pacing, { minSeconds: 0, maxSeconds: 0 });
  } finally { worker.restore(); }
});

test('failed pacing write never acknowledges resume or clears persisted OFF', async () => {
  const worker = await boot({ job: null });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    Object.assign(worker.control, { revision: 'unapplied-pacing', pacing: { minSeconds: 2, maxSeconds: 3 } });
    globalThis.chrome.storage.sync.set = async () => { throw new Error('Fixture settings write failed.'); };
    const response = await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(response.ok, false);
    assert.equal(worker.local.gatewayAppliedControl.dispatchEnabled, false);
    assert.equal(worker.local.gatewayAppliedControl.revision, null);
    assert.notEqual(lastTelemetry(worker).telemetry.state.controlRevision, 'unapplied-pacing');
  } finally { worker.restore(); }
});

test('provider account change after reservation refuses actual generation', async () => {
  const replies = {}; let inspections = 0;
  const worker = await boot({ flowReplies: replies, onFlow(op) {
    if (op === 'inspectAccount' && ++inspections === 3) replies.inspectAccount = { account: { ...worker.account(), accountId: 'different-provider-account' } };
  } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.equal(generated(worker), 0);
    assert.match(queueItem(worker).error, /actual provider account no longer matches/);
  } finally { worker.restore(); }
});

test('an executable reply to an unquoted request remains held and cannot generate', async () => {
  const worker = await boot({ claimReply(_body, control) { return { job: JOB, control }; } });
  try {
    const response = await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(response.ok, false); assert.match(response.error, /without an observed quote/);
    assert.ok(worker.local.gatewayUnsettledClaim);
    assert.equal(worker.local.videoQueue?.length || 0, 0);
    assert.equal(generated(worker), 0);
  } finally { worker.restore(); }
});

test('legacy queued claim without a quote reservation cannot start generation', async () => {
  const worker = await boot({ job: null });
  try {
    await worker.send({ type: 'gatewayTest' });
    const binding = await gatewayBinding({ ...worker.sync.videoSettings, gatewayToken: worker.local.gatewayWorkerToken });
    worker.local.videoQueue = [pacedRow('legacy', { gatewayJobId: 'legacy', gatewayClaimId: 'old-claim', gatewayBinding: binding, target: 'gateway', gatewaySettled: false })];
    worker.local.gatewayUnsettledClaim = { binding, claimId: 'old-claim', jobId: 'legacy' };
    await worker.send({ type: 'resumeQueue' });
    await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.match(queueItem(worker).error, /no observed quote\/account reservation/);
    assert.equal(generated(worker), 0);
  } finally { worker.restore(); }
});

test('account is checked again at the paid boundary after model preflight', async () => {
  const replies = {};
  const worker = await boot({ flowReplies: replies, onFlow(op) {
    if (op === 'listVideoModels') replies.inspectAccount = { account: { ...worker.account(), accountId: 'changed-before-submit' } };
  } });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.equal(generated(worker), 0);
    assert.match(queueItem(worker).error, /actual provider account no longer matches/);
  } finally { worker.restore(); }
});

test('a reply from the previous token cannot apply control to a new connection', async () => {
  const worker = await boot({ onTelemetry(local) { local.gatewayWorkerToken = 'changed-fixture-token'; } });
  try {
    const response = await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(response.ok, false);
    assert.match(response.error, /control was not applied/);
    const currentBinding = await gatewayBinding({ ...worker.sync.videoSettings, gatewayToken: worker.local.gatewayWorkerToken });
    assert.notEqual(worker.local.gatewayAppliedControl.binding, currentBinding);
    assert.equal(count(worker, '/claim'), 0); assert.equal(generated(worker), 0);
  } finally { worker.restore(); }
});

for (const mode of ['studio', 'standalone']) {
  test(`paired ${mode} worker still acknowledges manager stop without claiming jobs`, async () => {
    const worker = await boot({ mode, health: { control: { revision: 'stop-outside-gateway', dispatchEnabled: false,
      closeRequested: true, pacing: { minSeconds: 0, maxSeconds: 0 } } } });
    try {
      await worker.send({ type: 'gatewayModeChanged' });
      assert.ok(worker.scheduled.some((alarm) => alarm.name === 'gatewayWorkerTick'));
      const state = lastTelemetry(worker).telemetry.state;
      assert.equal(state.controlRevision, 'stop-outside-gateway');
      assert.equal(state.paused, true); assert.equal(state.enabled, false); assert.equal(state.activity, 'idle');
      assert.equal(count(worker, '/claim'), 0); assert.equal(worker.provider.length, 0);
      assert.equal(Object.hasOwn(lastTelemetry(worker), 'safeToClose'), false);
    } finally { worker.restore(); }
  });
}

test('configured shared identity is local telemetry; readiness and credits stay unknown', async () => {
  const worker = await boot({ sync: pacedSync('gateway', { providerAccountProfileId: 'shared-account-profile' }) });
  try {
    const response = await worker.send({ type: 'getQueue' });
    assert.deepEqual(response.manager.account, { profileId: 'shared-account-profile', identitySource: 'configured',
      ready: null, creditBalance: null, creditResetAt: null });
    assert.deepEqual(response.manager.pacing, { minimumSec: 5, maximumSec: 15, nextGenerationAt: 0, cooldownUntil: 0 });
    assert.equal(response.manager.inventory, null);
    assert.equal(worker.calls.length, 0);
  } finally { worker.restore(); }
});
