import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimGatewayJob,
  gatewayBinding,
  reportGatewayFailure,
  reportGatewayProgress,
  reportGatewayResult,
  testGateway,
} from '../src/lib/gateway-client.js';

const TOKEN = 'ekw_toke_secret';
const SETTINGS = { gatewayUrl: 'http://127.0.0.1:8787', gatewayToken: TOKEN, gatewayWorkerId: 'worker_1' };
const HEALTH = { ok: true, workerId: 'worker_1', kind: 'video', maxResultBytes: 268435456, leaseSeconds: 600 };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// The transport is tested against a stubbed fetch: no socket, no Gateway, no browser.
async function withFetch(reply, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof reply === 'function' ? reply(url, init) : reply;
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('health returns the authenticated worker over the configured URL', async () => {
  await withFetch(jsonResponse(HEALTH), async (calls) => {
    assert.deepEqual(await testGateway(SETTINGS), HEALTH);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/workers/health');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.cache, 'no-store');
  });
});

test('health rejects a contract this worker cannot trust', async () => {
  const broken = [
    { ...HEALTH, ok: false },
    { ...HEALTH, ok: 'true' },
    { ...HEALTH, kind: 'audio' },
    { ...HEALTH, workerId: '' },
    { ...HEALTH, workerId: '   ' },
    { ...HEALTH, maxResultBytes: 0 },
    { ...HEALTH, maxResultBytes: -1 },
    { ...HEALTH, maxResultBytes: 1.5 },
    { ...HEALTH, maxResultBytes: Number.MAX_SAFE_INTEGER + 10 },
    { ...HEALTH, maxResultBytes: '268435456' },
    { ...HEALTH, leaseSeconds: 0 },
    { ...HEALTH, leaseSeconds: '600' },
    { ...HEALTH, leaseSeconds: Number.NaN },
  ];
  for (const health of broken) {
    await withFetch(jsonResponse(health), async () => {
      await assert.rejects(() => testGateway(SETTINGS), /health check failed/);
    });
  }
});

test('health only accepts the worker id this extension already uses', async () => {
  await withFetch(jsonResponse({ ...HEALTH, workerId: 'worker_2' }), async () => {
    await assert.rejects(() => testGateway(SETTINGS), /does not match/);
  });
  await withFetch(jsonResponse({ ...HEALTH, workerId: 'worker_new' }), async () => {
    const health = await testGateway({ ...SETTINGS, gatewayWorkerId: '' });
    assert.equal(health.workerId, 'worker_new');
  });
});

test('a successful response that is not a valid object fails', async () => {
  const replies = [
    () => new Response('not json', { status: 200 }),
    () => new Response('', { status: 200 }),
    () => jsonResponse([HEALTH]),
    () => new Response(null, { status: 204 }),
  ];
  for (const reply of replies) {
    await withFetch(reply, async () => {
      await assert.rejects(() => testGateway(SETTINGS), /health|empty|malformed/);
    });
  }
});

test('the URL is canonical and needs a token; LAN and Tailscale stay allowed', async () => {
  await withFetch(() => jsonResponse(HEALTH), async (calls) => {
    await testGateway({ ...SETTINGS, gatewayUrl: 'http://127.0.0.1:8787/prefix/' });
    assert.equal(calls[0].url, 'http://127.0.0.1:8787/prefix/api/workers/health');
    await testGateway({ ...SETTINGS, gatewayUrl: 'http://LOCALHOST:8787/' });
    assert.equal(calls[1].url, 'http://localhost:8787/api/workers/health');
    await testGateway({ ...SETTINGS, gatewayUrl: 'http://192.168.1.20:8787' });
    assert.equal(calls[2].url, 'http://192.168.1.20:8787/api/workers/health');
    await testGateway({ ...SETTINGS, gatewayUrl: 'http://100.64.0.1:8787' });
    assert.equal(calls[3].url, 'http://100.64.0.1:8787/api/workers/health');
    await testGateway({ ...SETTINGS, gatewayUrl: 'https://gateway.example.com' });
    assert.equal(calls[4].url, 'https://gateway.example.com/api/workers/health');
  });
  await withFetch(() => jsonResponse(HEALTH), async (calls) => {
    const rejected = [
      'http://user:pass@127.0.0.1:8787',
      'http://127.0.0.1:8787/?x=1',
      'http://127.0.0.1:8787#frag',
      'ftp://127.0.0.1:8787',
      'not a url',
      '',
    ];
    for (const gatewayUrl of rejected) {
      await assert.rejects(() => testGateway({ ...SETTINGS, gatewayUrl }), /Gateway/);
    }
    await assert.rejects(() => testGateway({ ...SETTINGS, gatewayToken: '  ' }), /token is not set/);
    assert.equal(calls.length, 0);
  });
});

test('claim accepts 204 and a job, and throws for any other receipt', async () => {
  await withFetch(new Response(null, { status: 204 }), async (calls) => {
    assert.equal(await claimGatewayJob(SETTINGS), null);
    assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/workers/claim');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { workerId: 'worker_1', kind: 'video' });
  });
  await withFetch(jsonResponse({ job: { jobId: 'job_1', kind: 'video' } }), async () => {
    assert.deepEqual(await claimGatewayJob(SETTINGS), { jobId: 'job_1', kind: 'video' });
  });
  // A claimed job may already have spent credits: an unusable receipt must throw, never be dropped.
  for (const body of ['not json', '', '{}', '{"job":null}', '{"job":{}}', '{"job":{"jobId":" "}}', '{"jobId":"job_1"}', '[]']) {
    await withFetch(new Response(body, { status: 200 }), async () => {
      await assert.rejects(() => claimGatewayJob(SETTINGS), /malformed/);
    });
  }
  await assert.rejects(() => claimGatewayJob({ ...SETTINGS, gatewayWorkerId: '' }), /worker id is not set/);
});

test('progress, result and fail need ok true and not ignored', async () => {
  await withFetch(() => jsonResponse({ ok: true }), async (calls) => {
    assert.deepEqual(await reportGatewayProgress(SETTINGS, 'job_1', 'queued', 'Gateway · job_1'), { ok: true });
    assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/workers/jobs/job_1/progress');
    assert.deepEqual(JSON.parse(calls[0].init.body), { phase: 'queued', message: 'Gateway · job_1' });
    assert.deepEqual(await reportGatewayFailure(SETTINGS, 'job_1', 'boom', false), { ok: true });
    assert.deepEqual(JSON.parse(calls[1].init.body), { error: 'boom', ambiguous: false });
    assert.deepEqual(await reportGatewayResult(SETTINGS, 'job_1', new Uint8Array([1, 2, 3]), 'video/mp4'), { ok: true });
    assert.equal(calls[2].init.body instanceof FormData, true);
    assert.equal(calls[2].init.body.get('mediaType'), 'video/mp4');
    assert.equal(calls[2].init.headers['Content-Type'], undefined);
  });
  const unacked = [
    () => jsonResponse({ ok: true, ignored: true }),
    () => jsonResponse({ ok: false, code: 'JOB_NOT_FOUND' }),
    () => jsonResponse({}),
    () => new Response('not json', { status: 200 }),
    () => new Response('', { status: 200 }),
    () => new Response(null, { status: 204 }),
  ];
  for (const reply of unacked) {
    await withFetch(reply, async () => {
      await assert.rejects(() => reportGatewayProgress(SETTINGS, 'job_1', 'queued'), /failed/);
      await assert.rejects(() => reportGatewayResult(SETTINGS, 'job_1', new Uint8Array([1])), /failed/);
      await assert.rejects(() => reportGatewayFailure(SETTINGS, 'job_1', 'boom', true), /failed/);
    });
  }
});

test('a held or settled fail is still an acknowledgement', async () => {
  await withFetch(() => jsonResponse({ ok: true, held: true }), async () => {
    assert.deepEqual(await reportGatewayFailure(SETTINGS, 'job_1', 'boom', true), { ok: true, held: true });
  });
});

test('errors never echo a body, a token or a credential-bearing URL', async () => {
  const leaks = ['detail-secret', TOKEN, '127.0.0.1'];
  await withFetch(new Response('{"detail":"detail-secret"}', { status: 401 }), async () => {
    for (const call of [
      () => testGateway(SETTINGS),
      () => claimGatewayJob(SETTINGS),
      () => reportGatewayProgress(SETTINGS, 'job_1', 'queued'),
      () => reportGatewayResult(SETTINGS, 'job_1', new Uint8Array([1])),
      () => reportGatewayFailure(SETTINGS, 'job_1', 'boom'),
    ]) {
      const error = await call().then(() => null, (caught) => caught);
      assert.ok(error, 'expected a failure');
      for (const secret of leaks) assert.ok(!error.message.includes(secret), error.message);
      assert.match(error.message, /HTTP 401/);
    }
  });
  await withFetch(() => {
    throw new TypeError(`fetch failed for http://user:pass@127.0.0.1/?t=${TOKEN}`);
  }, async () => {
    const error = await testGateway(SETTINGS).then(() => null, (caught) => caught);
    assert.match(error.message, /network error/);
    for (const secret of [...leaks, 'PASSWORD_7k2m9x']) assert.ok(!error.message.includes(secret), error.message);
  });
});

test('binding is a SHA-256 of the canonical URL, token and worker id', async () => {
  const remote = { gatewayUrl: 'https://Gateway.Example.com:443/base/', gatewayToken: TOKEN, gatewayWorkerId: 'worker_1' };
  const first = await gatewayBinding(remote);
  assert.match(first, /^[0-9a-f]{64}$/);
  for (const secret of [remote.gatewayUrl, TOKEN, remote.gatewayWorkerId]) {
    assert.ok(!first.includes(secret));
  }
  // Canonical host case, default port and trailing slashes normalize to one value.
  assert.equal(first, await gatewayBinding({ ...remote, gatewayUrl: 'https://gateway.example.com/base' }));
  assert.equal(await gatewayBinding(SETTINGS), await gatewayBinding({ ...SETTINGS, gatewayUrl: 'http://127.0.0.1:8787/' }));
  // A different host, port or path is a different Gateway, even over plain LAN HTTP.
  assert.notEqual(first, await gatewayBinding({ ...remote, gatewayUrl: 'https://gateway.example.com/other' }));
  assert.notEqual(await gatewayBinding(SETTINGS), await gatewayBinding({ ...SETTINGS, gatewayUrl: 'http://192.168.1.20:8787' }));
  assert.notEqual(first, await gatewayBinding({ ...remote, gatewayToken: `${TOKEN}x` }));
  assert.notEqual(first, await gatewayBinding({ ...remote, gatewayWorkerId: 'worker_2' }));
  await assert.rejects(() => gatewayBinding({ ...remote, gatewayUrl: 'https://gateway.example.com/base?x=1' }), /Gateway/);
  await assert.rejects(() => gatewayBinding({ ...remote, gatewayUrl: 'https://gateway.example.com/base#f' }), /Gateway/);
  await assert.rejects(() => gatewayBinding({ ...remote, gatewayUrl: 'http://user:pass@gateway.example.com/base' }), /Gateway/);
  await assert.rejects(() => gatewayBinding({ ...SETTINGS, gatewayWorkerId: '' }), /worker id is not set/);
  await assert.rejects(() => gatewayBinding({ ...SETTINGS, gatewayToken: '' }), /token is not set/);
});