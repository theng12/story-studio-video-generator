import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkerControl, observedAccount, observedQuote, workerObservation } from '../src/lib/gateway-manager.js';
import { flowCommand } from '../src/lib/flow-exec.js';
import { FLOW_RPC_DEFAULTS } from '../src/lib/config.js';

const control = { revision: 'revision-1', dispatchEnabled: false, closeRequested: true, pacing: { minSeconds: 0, maxSeconds: 0 } };
const account = () => ({ schema: 1, provider: 'flow', accountId: 'observed-opaque-1', source: 'flow.account',
  observedAt: new Date(Date.now()).toISOString(), connection: 'connected', signIn: 'signed_in', readiness: 'ready',
  balance: { value: 10, unit: 'credits', source: 'flow.balance', observedAt: new Date(Date.now()).toISOString() } });
const context = { queue: [], claim: null, paused: false, control, nextRunAt: 0, cooldownUntil: 0 };
const settings = { mode: 'gateway', humanDelayMinSec: 0, humanDelayMaxSec: 0, providerAccountProfileId: 'never-an-account' };

test('control is explicit, bounded, and preserves zero/fractional custom pacing', () => {
  assert.deepEqual(normalizeWorkerControl(control), control);
  assert.equal(normalizeWorkerControl({ ...control, pacing: { minSeconds: 1.25, maxSeconds: 2.75 } }).pacing.minSeconds, 1.25);
  for (const bad of [null, {}, { ...control, dispatchEnabled: 'false' }, { ...control, dispatchEnabled: true },
    { ...control, pacing: { minSeconds: -1, maxSeconds: 15 } }, { ...control, pacing: { minSeconds: 0, maxSeconds: 3601 } }]) {
    assert.throws(() => normalizeWorkerControl(bad));
  }
});

test('unbound state omits account, acknowledges applied pause and reports actual cooldown bound', () => {
  const until = Date.now() + 45000;
  const report = workerObservation(settings, { ...context, cooldownUntil: until });
  assert.equal(Object.hasOwn(report, 'account'), false);
  assert.equal(report.telemetry.state.signIn, 'unknown');
  assert.equal(report.telemetry.state.readiness, 'unknown');
  assert.equal(report.telemetry.state.paused, true);
  assert.equal(report.telemetry.state.controlRevision, control.revision);
  assert.equal(report.telemetry.state.nextEligibleAt, new Date(until).toISOString());
  assert.equal(report.telemetry.state.activity, 'cooling');
  assert.ok(!JSON.stringify(report).includes(settings.providerAccountProfileId));
});

test('held/active work cannot report idle or a claimable deadline on a close request', () => {
  const held = workerObservation(settings, { ...context, claim: { jobId: 'unknown' } }).telemetry.state;
  assert.equal(held.activity, 'recovering'); assert.equal(held.nextEligibleAt, null);
  assert.equal(held.paused, true); assert.equal(held.attention, true);
  assert.equal(workerObservation(settings, { ...context, queue: [{ status: 'running' }] }).telemetry.state.activity, 'generating');
});

test('provider facts require actual opaque identity and fresh zoned provenance', () => {
  assert.equal(observedAccount(null), null);
  for (const patch of [{ accountId: 'person@example.com' }, { accountId: 123 }, { provider: 123 }, { source: '' }, { observedAt: '2026-11-11T00:00:00' },
    { observedAt: new Date(Date.now() + 50000).toISOString() }, { observedAt: new Date(Date.now() - 100000).toISOString() }]) {
    assert.equal(observedAccount({ ...account(), ...patch }), null);
  }
  assert.equal(observedAccount(account()).accountId, 'observed-opaque-1');
});

test('quote is exact-payload/same-account and never supplies an unknown balance', () => {
  const observed = account();
  const preview = { payloadSha256: 'b'.repeat(64), executionAuthorized: false };
  const quote = { provider: observed.provider, accountId: observed.accountId, payloadSha256: preview.payloadSha256,
    value: 1, unit: 'credits', source: 'flow.quote', observedAt: observed.observedAt };
  assert.deepEqual(observedQuote(quote, observed, preview), quote);
  for (const patch of [{ accountId: 'other' }, { payloadSha256: 'c'.repeat(64) }, { unit: 'usd' }, { value: NaN },
    { observedAt: new Date(Date.now() - 100000).toISOString() }]) assert.equal(observedQuote({ ...quote, ...patch }, observed, preview), null);
  assert.equal(observedQuote(quote, { ...observed, balance: null }, preview), null);
  // A stale balance cannot price a job even though the price itself is known.
  const stale = { ...observed.balance, observedAt: new Date(Date.now() - 100000).toISOString() };
  assert.equal(observedQuote(quote, { ...observed, balance: stale }, preview), null);
});

test('Flow account/quote inspection is read-only and refuses a signed-out page', async () => {
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    const result = await flowCommand({ op: 'inspectAccount', payload: { rpcFallback: FLOW_RPC_DEFAULTS,  preview: { job: { jobId: 'never-execute' } } } });
    assert.equal(result.ok, false);
    assert.match(result.error, /Not signed in to Flow/);
  } finally {
    globalThis.window = saved;
  }
});
