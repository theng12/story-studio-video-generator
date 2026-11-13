import test from 'node:test';
import assert from 'node:assert/strict';
import { flowCommand } from '../src/lib/flow-exec.js';
import { FALLBACK_VIDEO_MODELS, snapshotVideoModel } from '../src/lib/video-models.js';
import { FLOW_RPC_DEFAULTS } from '../src/lib/config.js';

function selection(mode, durationSec) {
  const model = FALLBACK_VIDEO_MODELS.find((entry) => entry.mode === mode && entry.durationSec === durationSec);
  // Synthetic current-inventory fixture; this is not evidence from live Flow.
  const snapshot = snapshotVideoModel(model.key, FALLBACK_VIDEO_MODELS, 'live', mode, durationSec);
  return { modelKey: model.key, durationSec, modelBinding: snapshot.videoModelBinding };
}

const PROJECT = '5852b0c6-e4a4-455a-8215-5513c208c29d';

function frame(rpcId, payload) {
  const row = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload), null, null, null, 'generic']]);
  return `)]}'\n\n${row.length}\n${row}\n25\n[["e",4,null,null,1]]`;
}

function install({ responses } = {}) {
  const requests = [];
  const originals = {
    window: globalThis.window,
    location: globalThis.location,
    fetch: globalThis.fetch,
  };
  globalThis.window = {
    WIZ_global_data: { SNlM0e: 'at-token', FdrFJe: 'sid', cfb2h: 'bl', S06Grb: '1234567890' },
    grecaptcha: {
      enterprise: {
        ready: (callback) => callback(),
        execute: async () => 'recaptcha-token',
      },
    },
  };
  globalThis.location = { pathname: `/project/${PROJECT}`, href: `https://flow.google.com/project/${PROJECT}` };
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith('/_/AiSandboxAngularFrontend/data/batchexecute')) {
      const query = new URLSearchParams(href.split('?')[1] || '');
      const rpcId = query.get('rpcids');
      const freq = JSON.parse(new URLSearchParams(options.body).get('f.req'));
      requests.push({ rpcId, freq });
      return { ok: true, status: 200, text: async () => frame(rpcId, responses?.[rpcId]) };
    }
    if (href.startsWith('https://flow-content.google/image/')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  return {
    requests,
    restore() {
      globalThis.window = originals.window;
      globalThis.location = originals.location;
      globalThis.fetch = originals.fetch;
    },
  };
}

const submitResponse = (mediaId) => [
  null,
  38,
  [['op-id', null, null, ['Title', [1, 2], null, null, mediaId, 'UUID', [1, 2]], PROJECT]],
  [],
];

test('text-to-video submits the captured YhhmEf shape', async (t) => {
  const mock = install({ responses: { YhhmEf: submitResponse('media-text') } });
  t.after(() => mock.restore());
  const result = await flowCommand({
    op: 'submitVideo',
    payload: { rpcFallback: FLOW_RPC_DEFAULTS,  projectId: PROJECT, mode: 'text', prompt: 'Slow push in.', ...selection('text', 4), aspectRatio: '16:9' },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.mediaId, 'media-text');
  assert.equal(mock.requests.length, 1);
  const { rpcId, freq } = mock.requests[0];
  assert.equal(rpcId, 'YhhmEf');
  assert.equal(freq[0][0][0], 'YhhmEf');
  const args = JSON.parse(freq[0][0][1]);
  assert.deepEqual(args[0][0][0], [null, null, [[['Slow push in.']]]]);
  assert.equal(args[0][0][1], selection('text', 4).modelKey);
  assert.equal(args[0][0][2], 2);
  assert.equal(args[0][0][3], null);
  assert.equal(args[0][0][4].length, 6);
  assert.match(args[0][0][4][4], /^[0-9A-F-]{36}$/);
  assert.equal(args[1][5], PROJECT);
  assert.deepEqual(args[1][10], ['recaptcha-token', 1]);
  assert.equal(args[2][1], 2);
});

test('image-to-video cites the start image and uses MZZa6b', async (t) => {
  const mock = install({ responses: { MZZa6b: submitResponse('media-image') } });
  t.after(() => mock.restore());
  const result = await flowCommand({
    op: 'submitVideo',
    payload: { rpcFallback: FLOW_RPC_DEFAULTS,  projectId: PROJECT, mode: 'image', prompt: 'Dolly in.', mediaId: 'start-image', ...selection('image', 3), aspectRatio: '16:9' },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.mediaId, 'media-image');
  const args = JSON.parse(mock.requests[0].freq[0][0][1]);
  assert.equal(mock.requests[0].rpcId, 'MZZa6b');
  assert.deepEqual(args[0][0][1], [[null, 'start-image']]);
  assert.equal(args[0][0][2], selection('image', 3).modelKey);
  assert.equal(args[0][0][3], 2);
});

test('status polling reads the captured media status slot', async (t) => {
  const mock = install({
    responses: { jwpduf: [null, 38, [['media-1', PROJECT, 'op', null, null, [[1, 2], '', null, null, null, null, null, null, [3], 1]]]] },
  });
  t.after(() => mock.restore());
  const result = await flowCommand({ op: 'checkVideo', payload: { rpcFallback: FLOW_RPC_DEFAULTS,  projectId: PROJECT, mediaId: 'media-1' } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.result, { status: 3, done: true, failed: false });
  const args = JSON.parse(mock.requests[0].freq[0][0][1]);
  assert.deepEqual(args, [null, null, [['media-1']]]);
});

test('media lookup returns the signed /video/ URL from any nesting depth', async (t) => {
  const mock = install({
    responses: {
      as29s: [null, null, [['media-1']], null, null, [[], 'thumb'], null, [['x', null, null, null, null, null, null, null, 'https://flow-content.google/video/media-1']]],
    },
  });
  t.after(() => mock.restore());
  const result = await flowCommand({ op: 'getMedia', payload: { rpcFallback: FLOW_RPC_DEFAULTS,  projectId: PROJECT, mediaId: 'media-1' } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.url, 'https://flow-content.google/video/media-1');
});

test('image generation keeps the verified ogiZ0b shape and media id', async (t) => {
  const mock = install({
    responses: {
      ogiZ0b: [[['img-media', null, 'https://flow-content.google/image/img-media']], []],
    },
  });
  t.after(() => mock.restore());
  const result = await flowCommand({
    op: 'generateImage',
    payload: { rpcFallback: FLOW_RPC_DEFAULTS,  projectId: PROJECT, prompt: 'A lighthouse.', model: 'nano-banana-2', aspectRatio: '16:9' },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.mediaId, 'img-media');
  assert.equal(mock.requests[0].rpcId, 'ogiZ0b');
  assert.ok(result.result.base64.length > 0);
});

for (const [mode, durationSec] of [['text', 8], ['image', 10]]) {
  test(`${mode} different captured duration reaches the exact RPC key`, async (t) => {
    const rpcId = mode === 'text' ? 'YhhmEf' : 'MZZa6b';
    const mock = install({ responses: { [rpcId]: submitResponse('duration-media') } });
    t.after(() => mock.restore());
    const choice = selection(mode, durationSec);
    const result = await flowCommand({ op: 'submitVideo', payload: { rpcFallback: FLOW_RPC_DEFAULTS, 
      projectId: PROJECT, mode, prompt: 'Duration fixture.', mediaId: 'start-image', ...choice, aspectRatio: '16:9',
    } });
    assert.equal(result.ok, true, result.error);
    const args = JSON.parse(mock.requests[0].freq[0][0][1]);
    assert.equal(mock.requests[0].rpcId, rpcId);
    assert.equal(args[0][0][mode === 'text' ? 1 : 2], choice.modelKey);
  });
}

for (const patch of [{ durationSec: 6 }, { modelBinding: undefined }, { modelBinding: { ...selection('text', 4).modelBinding, rpcId: 'MZZa6b' } }, { modelBinding: { ...selection('text', 4).modelBinding, inventorySource: 'fallback' } }]) {
  test(`refuses unmatched selection at the actual provider boundary: ${JSON.stringify(patch)}`, async (t) => {
    const mock = install();
    t.after(() => mock.restore());
    let tokens = 0;
    window.grecaptcha.enterprise.execute = async () => { tokens++; return 'unused'; };
    const result = await flowCommand({ op: 'submitVideo', payload: { rpcFallback: FLOW_RPC_DEFAULTS, 
      projectId: PROJECT, mode: 'text', prompt: 'Never submitted.', ...selection('text', 4), ...patch,
    } });
    assert.equal(result.ok, false);
    assert.match(result.error, /matching captured request binding/);
    assert.equal(mock.requests.length, 0);
    assert.equal(tokens, 0);
  });
}

test('visible UI length is observed without inventing request mappings or submitting', async (t) => {
  const mock = install();
  const original = globalThis.document;
  t.after(() => { mock.restore(); globalThis.document = original; });
  for (const durationSec of [3, 6, 10]) {
    globalThis.document = { body: { innerText: `Video · 360p · ${durationSec}s\ncrop_16_9\nx1` } };
    const result = await flowCommand({ op: 'listVideoModels' });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result.entries, []);
    assert.deepEqual(result.result.observedSelection, { resolution: '360p', durationSec, outputCount: 1 });
  }
  assert.equal(mock.requests.length, 0);
});

test('refuses unverified aspect ratios instead of guessing', async (t) => {
  const mock = install({ responses: { YhhmEf: submitResponse('never') } });
  t.after(() => mock.restore());
  const result = await flowCommand({
    op: 'submitVideo',
    payload: { rpcFallback: FLOW_RPC_DEFAULTS,  projectId: PROJECT, mode: 'text', prompt: 'x', ...selection('text', 4), aspectRatio: '9:16' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not verified/);
  assert.equal(mock.requests.length, 0);
});

const PREVIEW_HASH = 'a'.repeat(64);
// The Omni Flash 1.2 text key, and a model the owner's rate does not cover.
const OMNI_TEXT = FALLBACK_VIDEO_MODELS.find((model) => model.mode === 'text' && model.durationSec === 4).key;
const UNPRICED_MODEL = FALLBACK_VIDEO_MODELS.find((model) => model.durationSec === 8).key;

test('reads the captured nzlxg balance and quotes a priced preview', async (t) => {
  const mock = install({ responses: { nzlxg: [23, 3, 8, 1, null, 23, [1794287978, 827444000]] } });
  t.after(() => mock.restore());
  const result = await flowCommand({
    op: 'inspectAccount',
    payload: { rpcFallback: FLOW_RPC_DEFAULTS,  preview: { job: { jobId: 'job_1', modelKey: OMNI_TEXT, durationSec: 4, resolution: '720p' }, executionAuthorized: false, payloadSha256: PREVIEW_HASH } },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].rpcId, 'nzlxg');
  assert.deepEqual(JSON.parse(mock.requests[0].freq[0][0][1]), []);
  const { account, quote } = result.result;
  assert.equal(account.provider, 'flow');
  assert.equal(account.accountId, 'flow.1234567890');
  assert.equal(account.readiness, 'ready');
  assert.deepEqual([account.balance.value, account.balance.unit, account.balance.source], [23, 'credits', 'flow.nzlxg']);
  assert.deepEqual([quote.value, quote.unit, quote.payloadSha256], [12, 'credits', PREVIEW_HASH]);
});

test('an unpriced duration (12s) gets no quote, never a guessed or zero price', async (t) => {
  const mock = install({ responses: { nzlxg: [23, 3, 8, 1, null, 23, [1794287978, 827444000]] } });
  t.after(() => mock.restore());
  const result = await flowCommand({
    op: 'inspectAccount',
    payload: { rpcFallback: FLOW_RPC_DEFAULTS,  preview: { job: { jobId: 'job_2', modelKey: OMNI_TEXT, durationSec: 12, resolution: '720p' }, executionAuthorized: false, payloadSha256: PREVIEW_HASH } },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.quote, null);
});

test('the owner rate prices 360p at a credit a second and 720p at three', async (t) => {
  const mock = install({ responses: { nzlxg: [23, 3, 8, 1, null, 23, [1794287978, 827444000]] } });
  t.after(() => mock.restore());
  const quoteFor = async (durationSec, resolution, modelKey = OMNI_TEXT) => (await flowCommand({
    op: 'inspectAccount',
    payload: { rpcFallback: FLOW_RPC_DEFAULTS,  preview: { job: { jobId: 'job_rate', modelKey, durationSec, resolution }, executionAuthorized: false, payloadSha256: PREVIEW_HASH } },
  })).result.quote;
  assert.equal((await quoteFor(10, '720p')).value, 30);
  assert.equal((await quoteFor(3, '720p')).value, 9);
  // 360p has a known rate but no captured key, so it is refused rather than priced
  // at one number and submitted at another.
  assert.equal(await quoteFor(10, '360p'), null);
  const refused = await flowCommand({
    op: 'inspectAccount',
    payload: { rpcFallback: FLOW_RPC_DEFAULTS,  preview: { job: { jobId: 'job_360', modelKey: OMNI_TEXT, durationSec: 10, resolution: '360p' }, executionAuthorized: false, payloadSha256: PREVIEW_HASH } },
  });
  assert.equal(refused.result.reason, 'the 360p Flow key is not captured');
  // A resolution with no observed rate is unpriced, not free.
  assert.equal(await quoteFor(4, '480p'), null);
  assert.equal(await quoteFor(4, undefined), null);
  // Veo 3.1 - Lite has no measured rate of its own: the panel quoted 10 credits for one
  // 8s 720p clip, so Omni's 3/s must not be borrowed for it.
  assert.equal(await quoteFor(8, '720p', 'veo_3_1_t2v_lite'), null);
  // The rate belongs to the model: a model with no entry never borrows Omni's.
  assert.equal(await quoteFor(8, '720p', UNPRICED_MODEL), null);
  assert.equal(await quoteFor(4, '720p', 'unknown-model'), null);
});

test('readiness follows the page for an unreadable, zero and positive balance', async (t) => {
  const cases = [
    { label: 'unreadable', replies: {}, readiness: 'ready', balance: null },
    { label: 'zero', replies: { nzlxg: [0, 3, 8, 1, null, 0, [1794287978, 827444000]] }, readiness: 'not_ready', balance: 0 },
    { label: 'positive', replies: { nzlxg: [23, 3, 8, 1, null, 23, [1794287978, 827444000]] }, readiness: 'ready', balance: 23 },
  ];
  for (const item of cases) {
    const mock = install({ responses: item.replies });
    t.after(() => mock.restore());
    const result = await flowCommand({
      op: 'inspectAccount',
      payload: { rpcFallback: FLOW_RPC_DEFAULTS,  preview: { job: { jobId: 'job_r', durationSec: 4 }, executionAuthorized: false, payloadSha256: PREVIEW_HASH } },
    });
    assert.equal(result.ok, true, `${item.label}: ${result.error}`);
    assert.equal(result.result.account.readiness, item.readiness, item.label);
    assert.equal(result.result.account.balance?.value ?? null, item.balance, item.label);
  }
});

test('a signed-in page with no provider identity is refused, not guessed', async (t) => {
  const saved = globalThis.window;
  globalThis.window = { WIZ_global_data: { SNlM0e: 'at-token', FdrFJe: 'sid', cfb2h: 'bl' } };
  t.after(() => { globalThis.window = saved; });
  const result = await flowCommand({ op: 'inspectAccount', payload: { rpcFallback: FLOW_RPC_DEFAULTS, } });
  assert.equal(result.ok, false);
  assert.match(result.error, /no stable account identity/i);
});

const OMNI_LABEL = FALLBACK_VIDEO_MODELS.find((model) => model.mode === 'text' && model.durationSec === 4).label;

// A fake page shaped like the real one: the trigger reads "<summary>\n<ratio>\n<count>"
// (evidence/flow-reads/video-capture-20261112.json, state.trigger), and the selected
// model is marked in the open panel.
function composerPage({ model = 'Omni 1.2 Flash', ratio = 'crop_16_9', video = 'Video · 720p · 4s', count = 'x1', line = 'Generating will use 6 credits' } = {}) {
  const trigger = `${video}\n${ratio}\n${count}`;
  return {
    body: { innerText: `${trigger}\n${line}` },
    querySelector: (selector) => selector === 'button[aria-label="Settings trigger"]' ? { innerText: trigger } : null,
    querySelectorAll: (selector) => {
      if (selector.includes('combobox')) return [{ innerText: `${model}\narrow_drop_down` }];
      if (selector.includes('aria-checked')) return [{ innerText: `${ratio}\n${ratio === 'crop_9_16' ? '9:16' : '16:9'}` }];
      return [];
    },
  };
}

test('the page price line is the quote only when the composer matches the job', async (t) => {
  const mock = install({ responses: { nzlxg: [23, 3, 8, 1, null, 23, [1794287978, 827444000]] } });
  const savedDocument = globalThis.document;
  t.after(() => { globalThis.document = savedDocument; mock.restore(); });
  const preview = (durationSec, resolution) => ({ rpcFallback: FLOW_RPC_DEFAULTS, preview: {
    job: { jobId: 'job_page', modelKey: OMNI_TEXT, modelLabel: OMNI_LABEL, durationSec, resolution, aspectRatio: '16:9' },
    executionAuthorized: false, payloadSha256: PREVIEW_HASH } });

  // Model, ratio, resolution and length all agree: the panel's 6 beats the table's 12.
  globalThis.document = composerPage();
  const withLine = await flowCommand({ op: 'inspectAccount', payload: preview(4, '720p') });
  assert.equal(withLine.result.quote.value, 6);
  assert.equal(withLine.result.quote.source, 'flow.panel.price');
  assert.deepEqual(withLine.result.pricing.disagreement, { page: 6, table: 12 });

  // No panel open: the table answers rather than nothing.
  globalThis.document = { body: { innerText: '' } };
  const noLine = await flowCommand({ op: 'inspectAccount', payload: preview(4, '720p') });
  assert.equal(noLine.result.quote.value, 12);
  assert.equal(noLine.result.quote.source, 'flow.pricing.duration');

  // A line belonging to another resolution and length must not price this job.
  globalThis.document = composerPage({ video: 'Video · 360p · 10s', line: 'Generating will use 10 credits' });
  assert.equal((await flowCommand({ op: 'inspectAccount', payload: preview(4, '720p') })).result.quote.value, 12);

  // A different model with matching resolution and length must not be trusted.
  globalThis.document = composerPage({ model: 'Veo 3.1 - Lite' });
  assert.equal((await flowCommand({ op: 'inspectAccount', payload: preview(4, '720p') })).result.quote.value, 12);

  // A different ratio must not be trusted either.
  globalThis.document = composerPage({ ratio: 'crop_9_16' });
  assert.equal((await flowCommand({ op: 'inspectAccount', payload: preview(4, '720p') })).result.quote.value, 12);

  // One video at a time: a panel price for x2 outputs is not this job's price.
  globalThis.document = composerPage({ count: 'x2' });
  assert.equal((await flowCommand({ op: 'inspectAccount', payload: preview(4, '720p') })).result.quote.value, 12);
});

test('a missing panel still refuses an unpriced job rather than quoting zero', async (t) => {
  const mock = install({ responses: { nzlxg: [23, 3, 8, 1, null, 23, [1794287978, 827444000]] } });
  const savedDocument = globalThis.document;
  t.after(() => { globalThis.document = savedDocument; mock.restore(); });
  globalThis.document = { body: { innerText: '' } };
  const result = await flowCommand({ op: 'inspectAccount', payload: { rpcFallback: FLOW_RPC_DEFAULTS,  preview: {
    job: { jobId: 'job_nopanel', modelKey: UNPRICED_MODEL, durationSec: 8, resolution: '720p' },
    executionAuthorized: false, payloadSha256: PREVIEW_HASH } } });
  assert.equal(result.result.quote, null);
  assert.match(result.result.reason, /no observed price for model/);
});
