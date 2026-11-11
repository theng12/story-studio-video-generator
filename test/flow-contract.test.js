import test from 'node:test';
import assert from 'node:assert/strict';
import { flowCommand } from '../src/lib/flow-exec.js';

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
    WIZ_global_data: { SNlM0e: 'at-token', FdrFJe: 'sid', cfb2h: 'bl' },
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
    payload: { projectId: PROJECT, mode: 'text', prompt: 'Slow push in.', modelKey: 'veo_t2v', aspectRatio: '16:9' },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.mediaId, 'media-text');
  assert.equal(mock.requests.length, 1);
  const { rpcId, freq } = mock.requests[0];
  assert.equal(rpcId, 'YhhmEf');
  assert.equal(freq[0][0][0], 'YhhmEf');
  const args = JSON.parse(freq[0][0][1]);
  assert.deepEqual(args[0][0][0], [null, null, [[['Slow push in.']]]]);
  assert.equal(args[0][0][1], 'veo_t2v');
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
    payload: { projectId: PROJECT, mode: 'image', prompt: 'Dolly in.', mediaId: 'start-image', modelKey: 'veo_i2v', aspectRatio: '16:9' },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.mediaId, 'media-image');
  const args = JSON.parse(mock.requests[0].freq[0][0][1]);
  assert.equal(mock.requests[0].rpcId, 'MZZa6b');
  assert.deepEqual(args[0][0][1], [[null, 'start-image']]);
  assert.equal(args[0][0][2], 'veo_i2v');
  assert.equal(args[0][0][3], 2);
});

test('status polling reads the captured media status slot', async (t) => {
  const mock = install({
    responses: { jwpduf: [null, 38, [['media-1', PROJECT, 'op', null, null, [[1, 2], '', null, null, null, null, null, null, [3], 1]]]] },
  });
  t.after(() => mock.restore());
  const result = await flowCommand({ op: 'checkVideo', payload: { projectId: PROJECT, mediaId: 'media-1' } });
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
  const result = await flowCommand({ op: 'getMedia', payload: { projectId: PROJECT, mediaId: 'media-1' } });
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
    payload: { projectId: PROJECT, prompt: 'A lighthouse.', model: 'nano-banana-2', aspectRatio: '16:9' },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.mediaId, 'img-media');
  assert.equal(mock.requests[0].rpcId, 'ogiZ0b');
  assert.ok(result.result.base64.length > 0);
});

test('refuses unverified aspect ratios instead of guessing', async (t) => {
  const mock = install({ responses: { YhhmEf: submitResponse('never') } });
  t.after(() => mock.restore());
  const result = await flowCommand({
    op: 'submitVideo',
    payload: { projectId: PROJECT, mode: 'text', prompt: 'x', modelKey: 'veo_t2v', aspectRatio: '9:16' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not verified/);
  assert.equal(mock.requests.length, 0);
});
