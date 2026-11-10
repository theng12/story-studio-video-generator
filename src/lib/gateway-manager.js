// Account-worker schema 1. Configured profile labels never become provider facts.
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export function normalizeWorkerControl(raw) {
  if (!raw || typeof raw.revision !== 'string' || !ID.test(raw.revision) || typeof raw.dispatchEnabled !== 'boolean' ||
      (raw.closeRequested !== undefined && typeof raw.closeRequested !== 'boolean') ||
      (raw.closeRequested && raw.dispatchEnabled)) throw new Error('Invalid Gateway worker control; dispatch remains off.');
  const pacing = raw.pacing;
  if (!pacing || ![pacing.minSeconds, pacing.maxSeconds].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 3600) ||
      pacing.maxSeconds < pacing.minSeconds) throw new Error('Gateway pacing exceeds this extension’s supported 0–3600 seconds.');
  return { revision: raw.revision, dispatchEnabled: raw.dispatchEnabled, closeRequested: raw.closeRequested === true,
    pacing: { minSeconds: pacing.minSeconds, maxSeconds: pacing.maxSeconds } };
}
function fresh(value, maxAgeSeconds) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 && time <= Date.now() && Date.now() - time <= maxAgeSeconds * 1000;
}
export function observedAccount(raw, maxAgeSeconds = 90) {
  if (!raw || raw.schema !== 1 || typeof raw.provider !== 'string' || typeof raw.accountId !== 'string' || typeof raw.source !== 'string' ||
      !SLUG.test(raw.provider) || !ID.test(raw.accountId) || !SLUG.test(raw.source) || !fresh(raw.observedAt, maxAgeSeconds)) return null;
  if (!['connected', 'disconnected', 'offline', 'error', 'unknown'].includes(raw.connection) ||
      !['signed_in', 'signed_out', 'unknown'].includes(raw.signIn) || !['ready', 'not_ready', 'unknown'].includes(raw.readiness)) return null;
  return { schema: 1, provider: raw.provider, accountId: raw.accountId, source: raw.source, observedAt: raw.observedAt,
    connection: raw.connection, signIn: raw.signIn, readiness: raw.readiness,
    balance: raw.balance ?? null, resetAt: raw.resetAt ?? null, plan: raw.plan ?? null, creditBuckets: raw.creditBuckets ?? null };
}
export function observedQuote(raw, account, preview, maxAgeSeconds = 90) {
  const balance = account?.balance;
  if (!balance || typeof balance.value !== 'number' || !Number.isFinite(balance.value) || balance.value < 0 || balance.value > Number.MAX_SAFE_INTEGER ||
      !fresh(balance.observedAt, maxAgeSeconds) || !SLUG.test(balance.source || '') || raw?.unit !== balance.unit) return null;
  if (!account || !raw || raw.provider !== account.provider || raw.accountId !== account.accountId ||
      raw.payloadSha256 !== preview.payloadSha256 || !/^[0-9a-f]{64}$/.test(raw.payloadSha256 || '') ||
      typeof raw.value !== 'number' || !Number.isFinite(raw.value) || raw.value < 0 || raw.value > Number.MAX_SAFE_INTEGER ||
      !SLUG.test(raw.unit || '') || !SLUG.test(raw.source || '') || !fresh(raw.observedAt, maxAgeSeconds)) return null;
  return { provider: raw.provider, accountId: raw.accountId, payloadSha256: raw.payloadSha256,
    value: raw.value, unit: raw.unit, source: raw.source, observedAt: raw.observedAt };
}
export function workerObservation(settings, { queue, claim, paused, control, nextRunAt, cooldownUntil }, account = null) {
  const busy = queue.some((item) => item.status === 'running');
  const held = Boolean(claim) || queue.some((item) => item.status === 'ambiguous' || (item.gatewayJobId && !item.gatewaySettled));
  const state = {
    connection: account?.connection || 'unknown', signIn: account?.signIn || 'unknown', readiness: account?.readiness || 'unknown',
    activity: busy ? 'generating' : held ? 'recovering' : cooldownUntil > Date.now() ? 'cooling' : nextRunAt > Date.now() ? 'resting' : queue.some((item) => item.status === 'pending') ? 'waiting' : 'idle',
    enabled: settings.mode === 'gateway', paused: paused || !control?.dispatchEnabled,
    attention: held, controlRevision: control?.revision || null,
    nextEligibleAt: held ? null : new Date(Math.max(Date.now(), nextRunAt || 0, cooldownUntil || 0)).toISOString(),
    pacing: { minSeconds: settings.humanDelayMinSec, maxSeconds: settings.humanDelayMaxSec },
    source: account?.source || 'extension.video', observedAt: account?.observedAt || new Date(Date.now()).toISOString(),
  };
  return { ...(account ? { account: { ...account, ...state } } : {}), telemetry: { state } };
}
