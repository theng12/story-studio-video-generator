import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimMarkerIsStale,
  createGatewayWorkerId,
  gatewayJobToItem,
  isGatewayJobQueued,
  normalizeGatewayJob,
} from '../src/lib/gateway-worker.js';

const JOB = {
  jobId: 'job_1',
  kind: 'video',
  videoMode: 'text',
  prompt: 'Slow push in.',
  modelKey: 'model_text',
  modelLabel: 'Omni Flash - 8 seconds',
  durationSec: 8,
  aspectRatio: '16:9',
  flowProjectId: '5852b0c6-e4a4-455a-8215-5513c208c29d',
};

test('maps a gateway job to an ordinary queue item', () => {
  const item = gatewayJobToItem(JOB, { imageModel: 'nano-banana-2' });
  assert.equal(item.gatewayJobId, 'job_1');
  assert.equal(item.target, 'gateway');
  assert.equal(item.videoMode, 'text');
  assert.equal(item.videoModelKey, 'model_text');
  assert.equal(item.videoModelLabel, 'Omni Flash - 8 seconds');
  assert.equal(item.projectId, JOB.flowProjectId);
  assert.equal(item.videoSource, null);
  assert.equal(item.status, 'pending');
  assert.equal(item.motionPrompt, 'Slow push in.');
});

test('image jobs keep the reference image semantic', () => {
  const withRef = gatewayJobToItem(
    { ...JOB, videoMode: 'image', referenceImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] },
    {}
  );
  assert.equal(withRef.videoSource, 'existing');
  assert.throws(() => gatewayJobToItem({ ...JOB, videoMode: 'image' }, {}), /exactly one reference/);
  assert.throws(() => gatewayJobToItem({ ...JOB, videoMode: 'image', referenceImages: [{ dataBase64: 'a' }, { dataBase64: 'b' }] }, {}), /exactly one reference/);
  assert.throws(() => gatewayJobToItem({ ...JOB, referenceImages: [{ dataBase64: 'a' }] }, {}), /does not accept/);
});

test('rejects malformed jobs before they reach the queue', () => {
  assert.throws(() => normalizeGatewayJob({}), /no id/);
  assert.throws(() => normalizeGatewayJob({ jobId: 'x', kind: 'audio', prompt: 'p', modelKey: 'm' }), /not supported/);
  assert.throws(() => normalizeGatewayJob({ jobId: 'x', prompt: '', modelKey: 'm' }), /no prompt/);
  assert.throws(() => normalizeGatewayJob({ jobId: 'x', prompt: 'p', modelKey: '' }), /no model key/);
  assert.throws(() => gatewayJobToItem({ ...JOB, flowProjectId: '' }, {}), /Flow project id/);
  assert.throws(() => normalizeGatewayJob({ ...JOB, videoMode: 'unknown' }), /source/);
  assert.throws(() => normalizeGatewayJob({ ...JOB, aspectRatio: 'square' }), /aspect/);
  assert.throws(() => normalizeGatewayJob({ ...JOB, durationSec: null }), /duration/);
});

test('a 9:16 claim is refused before it can reach the queue', () => {
  // Flow's 9:16 value has never been observed, so accepting it would only claim
  // work that cannot submit.
  assert.throws(() => normalizeGatewayJob({ ...JOB, aspectRatio: '9:16' }), /only 16:9 is captured/);
  assert.throws(() => gatewayJobToItem({ ...JOB, aspectRatio: '9:16' }, {}), /only 16:9 is captured/);
});

test('deduplicates a claimed job that is already queued', () => {
  const item = gatewayJobToItem(JOB, {});
  assert.equal(isGatewayJobQueued([item], 'job_1'), true);
  assert.equal(isGatewayJobQueued([item], 'job_2'), false);
});

test('unknown controls and scene duration survive as detached inert metadata', () => {
  const job = { ...JOB, futureControl: { choices: ['future-value'] }, sceneDurationSec: 12,
    status: 'done', videoMediaId: 'untrusted-media' };
  const item = gatewayJobToItem(job, {});
  assert.equal(item.durationSec, 8);
  assert.deepEqual(item.unmappedFields, { futureControl: { choices: ['future-value'] },
    sceneDurationSec: 12, status: 'done', videoMediaId: 'untrusted-media' });
  assert.equal(item.status, 'pending');
  assert.equal(item.videoMediaId, undefined);
  job.futureControl.choices.push('later-mutation');
  assert.deepEqual(item.unmappedFields.futureControl.choices, ['future-value']);
  const reloaded = JSON.parse(JSON.stringify(item));
  assert.equal(reloaded.unmappedFields.sceneDurationSec, 12);
  assert.deepEqual(reloaded.unmappedFields.futureControl.choices, ['future-value']);
});

test('worker ids are stable, prefixed values', () => {
  assert.match(createGatewayWorkerId(), /^worker_/);
});

test('an unsettled claim marker expires on Gateway\'s lease, never on a person', () => {
  const now = 1_800_000_000_000;
  const lease = 600;
  // Inside the advertised lease this is still a real hold, so a second claim is refused.
  assert.equal(claimMarkerIsStale({ at: now - 60_000 }, lease, now), false);
  // The boundary itself: at exactly the lease Gateway's reaper has not yet let the job go.
  assert.equal(claimMarkerIsStale({ at: now - lease * 1000 }, lease, now), false);
  // Past the lease plus the 30 s settle window, Gateway has already let the job go.
  assert.equal(claimMarkerIsStale({ at: now - (lease + 31) * 1000 }, lease, now), true);
  assert.equal(claimMarkerIsStale({ at: now - (lease + 29) * 1000 }, lease, now), false);
  // A lease Gateway did not state — the health call failed — is never expired on a guess.
  assert.equal(claimMarkerIsStale({ at: now - 10 * 24 * 3600_000 }, undefined, now), false);
  assert.equal(claimMarkerIsStale({ at: now - 10 * 24 * 3600_000 }, null, now), false);
  assert.equal(claimMarkerIsStale({ at: now - 10 * 24 * 3600_000 }, NaN, now), false);
  // No marker, or no usable time in it: nothing is judged stale here (the caller stamps `at`).
  assert.equal(claimMarkerIsStale(null, lease, now), false);
  assert.equal(claimMarkerIsStale({ claimId: 'legacy' }, lease, now), false);
});
