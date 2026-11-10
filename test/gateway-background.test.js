// Actual MV3 background and transport; browser, storage and provider boundaries are stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { FALLBACK_VIDEO_MODELS } from '../src/lib/video-models.js';

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
async function boot({ local = {}, sync, rows = new Map(), mode = 'gateway', job = JOB, answers = [{ ok: true }], health = {}, failAnswer = { ok: true }, onClaim, onFlow, lostClaim = false, noTabs = false, storySave, assetReply, onTabs, flowReplies = {} } = {}) {
  sync ||= { videoSettings: { mode, gatewayUrl: 'http://127.0.0.1:49873', gatewayWorkerId: '', flowProjectId: PROJECT, humanDelayMinSec: 0, humanDelayMaxSec: 0, fleetEnabled: false } };
  local.gatewayWorkerToken ??= 'fixture-token';
  const desiredMode = sync.videoSettings.mode;
  sync.videoSettings.mode = 'studio';
  const prior = Object.fromEntries(['chrome', 'fetch', 'indexedDB'].map((key) => [key, globalThis[key]]));
  const calls = [], provider = [], downloads = [], alarms = [];
  let listener;
  globalThis.indexedDB = indexedStorage(rows);
  globalThis.chrome = {
    storage: { local: area(local), sync: area(sync) },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener(fn) { alarms.push(fn); } } },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { query: async () => { await onTabs?.(sync); return noTabs ? [] : [{ id: 7, status: 'complete' }]; }, get: async () => ({ id: 7, url: `https://flow.google.com/project/${PROJECT}` }), create: async () => { throw new Error('Fixture refuses a new provider tab.'); } },
    scripting: { async executeScript({ args: [{ op, payload }] }) {
      provider.push({ op, payload });
      await onFlow?.(op, local);
      const result = flowReplies[op] || {
        listVideoModels: { entries: FALLBACK_VIDEO_MODELS, signedIn: true, projectId: PROJECT },
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
    if (url.endsWith('/health')) return Response.json({ ok: true, workerId: 'fixture-worker', kind: 'video', maxResultBytes: 1024, leaseSeconds: 90, ...health });
    if (url.endsWith('/claim')) {
      await onClaim?.(local, sync);
      if (lostClaim) throw new Error('Fixture lost claim response.');
      return job ? Response.json({ job }) : new Response(null, { status: 204 });
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
  sync.videoSettings.mode = desiredMode;
  return { local, sync, rows, calls, provider, downloads,
    send(message) { return new Promise((resolve) => listener(message, {}, resolve)); },
    tick() { for (const alarm of alarms) alarm({ name: 'gatewayWorkerTick' }); },
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
    assert.equal(count(worker, '/claim'), 1); assert.equal(generated(worker), 1);
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
  try { await worker.send({ type: 'gatewayClaimNow' }); assert.equal(worker.calls.length, 0); }
  finally { worker.restore(); }
});

test('explicit empty claim clears only the idle receipt and performs no provider work', async () => {
  const worker = await boot({ job: null });
  try {
    await worker.send({ type: 'gatewayClaimNow' });
    assert.equal(count(worker, '/claim'), 1); assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    assert.equal(worker.provider.length, 0);
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
    worker.tick(); await worker.settled(); assert.equal(count(worker, '/claim'), 1);
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
    await worker.send({ type: 'gatewayClaimNow' }); await waitFor(() => queueItem(worker)?.status === 'failed'); await worker.settled();
    assert.equal(worker.provider.length, 0); assert.equal(count(worker, '/fail'), 0); assert.ok(worker.local.gatewayUnsettledClaim);
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
