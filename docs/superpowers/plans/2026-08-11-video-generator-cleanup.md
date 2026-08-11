# Video Generator Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Flow-only video extension discover exact signed-session models, refuse unknown paid work, recover both image and video submissions safely, and remove obsolete settings while preserving Story Studio, standalone, and Fleet behavior.

**Architecture:** Keep the extension Flow-only and add two small pure modules: one owns exact model inventory/selection, and one owns queue eligibility/recovery rules that can be tested without Chrome. The existing MAIN-world `flowCommand` gains one read-only inventory operation, while the background worker remains the sole queue orchestrator and validates the queued model snapshot before any provider request.

**Tech Stack:** Chrome Manifest V3, browser-native JavaScript ES modules, `chrome.scripting` MAIN-world execution, Chrome storage/alarms/downloads, Node.js built-in `node:test` and `assert`.

## Global Constraints

- Google Flow is the only video provider and uses the signed Flow website session and that website account's quota or credits; do not add developer API keys, developer API billing, or a provider abstraction.
- A model is usable only when Flow exposes an exact provider-owned transport key plus a user label, or when it is in the explicit tested fallback catalog.
- Queue items snapshot the exact model key and label; unknown, removed, or malformed models fail before image generation, image upload, or paid video submission.
- Persist `submitting` before paid video submission, persist the returned media ID immediately, and never replay an unknown paid outcome without explicit duplicate-credit acceptance.
- Persist `image_submitting` before optional fresh-image generation; an interruption without a returned image media ID is ambiguous and cannot auto-retry.
- Keep the queue persistent, sequential, paced, actively deduplicated, and independent of the side panel.
- Preserve one aggregate `/episodes` request and one selected-episode Scene Review request; do not add pagination or virtualization without a measured DOM bottleneck.
- Story Studio queues only approved scenes with an image, a non-empty motion prompt, and duration at least `animate_min_seconds`; completed project clips ingest into their matching scene and standalone clips save to Downloads.
- Fleet remains opt-in signed telemetry with only `pause_after_current`, `resume_hub_pause`, and `clear_pending` queue commands.
- Add no runtime or development dependency; tests use Node's built-in runner.
- Preserve unrelated work and do not add `graphify-out` or SDD scratch artifacts to release commits.

## File Map

- Create `package.json`: declares ESM and the dependency-free `npm test` command.
- Create `src/lib/video-models.js`: fallback catalog, exact-key validation, inventory normalization, legacy selection migration, and queue snapshot resolution.
- Create `src/lib/video-rules.js`: pure Story eligibility, active deduplication, interruption classification, standalone output naming, and Fleet command allowlist.
- Modify `src/lib/config.js`: remove dead settings, migrate known legacy video model values, and persist only the exact selected model key/label/source.
- Modify `src/lib/flow-exec.js`: add the read-only inventory command and submit the exact snapshotted key without a fallback.
- Modify `src/background.js`: refresh/store inventory, validate before provider work, snapshot model metadata, checkpoint fresh-image submission, and remove dead queue fields.
- Modify `src/popup/popup.js`: render live/fallback inventory, refresh it, save exact selections, apply stale-load guards, and send exact snapshots.
- Modify `src/popup/popup.html`: remove the fake provider selector, add model provenance/refresh UI, and replace stale Fleet copy.
- Modify `src/popup/popup.css`: style the compact inventory state/action row if existing utility classes are insufficient.
- Modify `README.md`, `CHANGELOG.md`, and `manifest.json`: document signed-session behavior, Fleet, recovery, and release `1.1.0`.
- Create `test/video-models.test.js`, `test/video-rules.test.js`, and `test/release.test.js`: pure behavior, integration contracts, manifest integrity, and version checks.

---

### Task 1: Exact Flow Model Catalog And Test Harness

**Files:**
- Create: `package.json`
- Create: `src/lib/video-models.js`
- Modify: `src/lib/config.js:1-75`
- Create: `test/video-models.test.js`

**Interfaces:**
- Produces: `FALLBACK_VIDEO_MODELS: readonly { key: string, label: string }[]`.
- Produces: `normalizeVideoInventory(entries): { key: string, label: string }[]`.
- Produces: `inventoryResult(entries): { source: 'live'|'fallback', models: { key: string, label: string }[] }`.
- Produces: `resolveVideoModel(key, models): { key: string, label: string }`, throwing for malformed or absent keys.
- Produces: `migrateLegacyVideoModel(value): { key: string, label: string }` for the four known legacy values only.
- Produces: `upgradeStoredVideoSettings(raw): object`, migrating the raw stored object before defaults are merged.
- Consumes: no new interfaces.

- [ ] **Step 1: Add the dependency-free test command and failing model tests**

```json
{
  "name": "story-studio-video-generator",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

```js
// test/video-models.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_VIDEO_MODELS,
  inventoryResult,
  migrateLegacyVideoModel,
  normalizeVideoInventory,
  resolveVideoModel,
  upgradeStoredVideoSettings,
} from '../src/lib/video-models.js';

test('normalizes only exact provider keys paired with distinct labels', () => {
  assert.deepEqual(
    normalizeVideoInventory([
      { key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' },
      { key: 'veo_4_i2v_fast', label: 'Duplicate' },
      { key: 'Made Up Model', label: 'Made Up Model' },
      { key: 'veo_4_i2v_quality', label: '' },
    ]),
    [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }]
  );
});

test('uses live inventory when trustworthy entries exist and fallback otherwise', () => {
  assert.deepEqual(inventoryResult([{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }]), {
    source: 'live',
    models: [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }],
  });
  assert.deepEqual(inventoryResult([]), { source: 'fallback', models: FALLBACK_VIDEO_MODELS });
});

test('resolves exact selections and refuses unknown or malformed keys', () => {
  const models = [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }];
  assert.deepEqual(resolveVideoModel('veo_4_i2v_fast', models), models[0]);
  assert.throws(() => resolveVideoModel('Veo 4 Fast', models), /exact Flow model/);
  assert.throws(() => resolveVideoModel('veo_3_1_i2v_fast', models), /not available/);
});

test('migrates only the four previously shipped model choices', () => {
  assert.deepEqual(migrateLegacyVideoModel('veo-3.1-fast'), {
    key: 'veo_3_1_i2v_fast',
    label: 'Veo 3.1 Fast',
  });
  assert.throws(() => migrateLegacyVideoModel('future-display-name'), /legacy video model/);
});

test('upgrades raw stored settings before defaults can hide the legacy field', () => {
  assert.deepEqual(upgradeStoredVideoSettings({ videoModel: 'veo-3.1-fast', theme: 'dark' }), {
    videoModelKey: 'veo_3_1_i2v_fast',
    videoModelLabel: 'Veo 3.1 Fast',
    videoModelSource: 'fallback',
    theme: 'dark',
  });
  assert.deepEqual(upgradeStoredVideoSettings({ videoModel: 'unknown-old-value' }), {});
});
```

- [ ] **Step 2: Run the focused test and confirm the module is missing**

Run: `npm test -- --test-name-pattern='normalizes|uses live|resolves exact|migrates only|upgrades raw'`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/video-models.js`.

- [ ] **Step 3: Implement the smallest exact model module**

```js
// src/lib/video-models.js
export const FALLBACK_VIDEO_MODELS = Object.freeze([
  { key: 'abra_i2v_4s', label: 'Omni Flash - 4 seconds' },
  { key: 'abra_i2v_6s', label: 'Omni Flash - 6 seconds' },
  { key: 'abra_i2v_8s', label: 'Omni Flash - 8 seconds' },
  { key: 'abra_i2v_10s', label: 'Omni Flash - 10 seconds' },
  { key: 'veo_3_1_i2v_lite', label: 'Veo 3.1 Lite' },
  { key: 'veo_3_1_i2v_fast', label: 'Veo 3.1 Fast' },
  { key: 'veo_3_1_i2v_quality', label: 'Veo 3.1 Quality' },
]);

const EXACT_KEY = /^[a-z0-9][a-z0-9_.-]{2,127}$/;
const LEGACY = Object.freeze({
  'omni-flash': { key: 'abra_i2v_4s', label: 'Omni Flash - 4 seconds' },
  'veo-3.1-lite': { key: 'veo_3_1_i2v_lite', label: 'Veo 3.1 Lite' },
  'veo-3.1-fast': { key: 'veo_3_1_i2v_fast', label: 'Veo 3.1 Fast' },
  'veo-3.1-quality': { key: 'veo_3_1_i2v_quality', label: 'Veo 3.1 Quality' },
});

export function normalizeVideoInventory(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const key = String(entry?.key || '').trim();
    const label = String(entry?.label || '').trim();
    if (!EXACT_KEY.test(key) || !label || label === key || seen.has(key)) return [];
    seen.add(key);
    return [{ key, label }];
  });
}

export function inventoryResult(entries) {
  const models = normalizeVideoInventory(entries);
  return models.length ? { source: 'live', models } : { source: 'fallback', models: FALLBACK_VIDEO_MODELS };
}

export function resolveVideoModel(key, models) {
  const exact = String(key || '').trim();
  if (!EXACT_KEY.test(exact)) throw new Error('Select an exact Flow model before queueing.');
  const match = normalizeVideoInventory(models).find((model) => model.key === exact);
  if (!match) throw new Error('The selected Flow model is not available in the current inventory. Refresh models and choose again.');
  return match;
}

export function migrateLegacyVideoModel(value) {
  const match = LEGACY[String(value || '')];
  if (!match) throw new Error('Unknown legacy video model. Refresh Flow models and choose again.');
  return { ...match };
}

export function upgradeStoredVideoSettings(raw) {
  const stored = { ...(raw || {}) };
  const legacyValue = stored.videoModel;
  delete stored.videoModel;
  delete stored.videoProvider;
  delete stored.saveTarget;
  if (stored.videoModelKey || !legacyValue) return stored;
  try {
    const model = migrateLegacyVideoModel(legacyValue);
    return { ...stored, videoModelKey: model.key, videoModelLabel: model.label, videoModelSource: 'fallback' };
  } catch {
    return stored;
  }
}
```

Update `DEFAULTS` to use `videoModelKey: 'veo_3_1_i2v_fast'`, `videoModelLabel: 'Veo 3.1 Fast'`, and `videoModelSource: 'fallback'`. Remove `videoProvider` and `saveTarget`. In `getSettings`, call `upgradeStoredVideoSettings(stored[STORAGE_KEY])` before merging `DEFAULTS`; save the normalized upgraded object once when it differs from raw storage. Validate only the shape of the stored selection here; availability is checked against the refreshed inventory at enqueue/execution time.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`

Expected: PASS with 5 tests and no dependencies installed.

- [ ] **Step 5: Commit the model foundation**

```bash
git add package.json src/lib/video-models.js src/lib/config.js test/video-models.test.js
git commit -m "feat: add exact Flow video model catalog"
```

---

### Task 2: Signed Flow Inventory, Panel Refresh, And Queue Snapshots

**Files:**
- Modify: `src/lib/flow-exec.js:8-347`
- Modify: `src/background.js:363-419,508-705,836-906`
- Modify: `src/popup/popup.js:257-340,373-391,804-887`
- Modify: `src/popup/popup.html:74-118`
- Modify: `src/popup/popup.css`
- Modify: `test/video-models.test.js`

**Interfaces:**
- Consumes: `inventoryResult(entries)` and `resolveVideoModel(key, models)` from Task 1.
- Produces: Flow operation `listVideoModels` returning `{ entries: { key: string, label: string }[] }` without a generation request.
- Produces: runtime message `refreshFlowModels` returning `{ ok: true, source: 'live'|'fallback', models, refreshedAt }`.
- Produces: queue fields `videoModelKey`, `videoModelLabel`, and `videoModelSource`; no `videoProvider` or legacy `videoModel` field.
- Produces: `snapshotVideoModel(key, models, source): { videoModelKey, videoModelLabel, videoModelSource }`, used by both enqueue paths.

- [ ] **Step 1: Add failing inventory and snapshot contract tests**

Append tests that read `src/lib/flow-exec.js`, `src/background.js`, and `src/popup/popup.html` as text and assert:

```js
import { readFile } from 'node:fs/promises';
import { snapshotVideoModel } from '../src/lib/video-models.js';

test('Flow exposes one read-only video inventory operation and no model fallback at submission', async () => {
  const source = await readFile(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');
  assert.match(source, /listVideoModels/);
  assert.match(source, /videoModelKey:\s*payload\.modelKey/);
  assert.doesNotMatch(source, /I2V_MODELS\[.*\]\s*\|\|/);
  assert.doesNotMatch(source, /transportKey/);
  assert.doesNotMatch(source, /script\[type=.*application\/json/);
});

test('queue snapshots exact model metadata and removes provider state', async () => {
  const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /videoModelKey:\s*model\.key/);
  assert.match(source, /videoModelLabel:\s*model\.label/);
  assert.doesNotMatch(source, /videoProvider:/);
});

test('snapshotVideoModel returns executable exact queue metadata and refuses stale selections', () => {
  const models = [{ key: 'veo_4_i2v_fast', label: 'Veo 4 Fast' }];
  assert.deepEqual(snapshotVideoModel('veo_4_i2v_fast', models, 'live'), {
    videoModelKey: 'veo_4_i2v_fast',
    videoModelLabel: 'Veo 4 Fast',
    videoModelSource: 'live',
  });
  assert.throws(() => snapshotVideoModel('removed_key', models, 'live'), /not available/);
});

test('panel identifies live or fallback inventory and has an explicit refresh action', async () => {
  const html = await readFile(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  assert.match(html, /id="modelInventoryState"/);
  assert.match(html, /id="refreshModels"/);
  assert.doesNotMatch(html, /id="videoProvider"/);
});
```

- [ ] **Step 2: Run the focused contracts and observe all three failures**

Run: `npm test -- --test-name-pattern='read-only video inventory|queue snapshots|snapshotVideoModel|panel identifies'`

Expected: FAIL because the inventory operation/UI and executable snapshot helper do not exist and legacy provider fields remain.

- [ ] **Step 3: Add the read-only MAIN-world inventory handler**

Inside `flowCommand`, add a `listVideoModels` handler that only inspects Flow's identified `videoModelConfigs` record and visible model options carrying `data-video-model-key`. It must never recursively accept a generic `transportKey`, scan arbitrary JSON scripts, or derive a key from label text:

```js
const listVideoModels = async () => {
  const entries = [];
  const add = (key, label) => entries.push({ key: String(key || ''), label: String(label || '') });
  const nextData = window.__NEXT_DATA__ || (() => {
    try { return JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null'); }
    catch { return null; }
  })();
  const configs = nextData?.props?.pageProps?.videoModelConfigs;
  for (const config of Array.isArray(configs) ? configs : []) {
    add(config.videoModelKey, config.displayName);
  }
  for (const element of document.querySelectorAll('[role="option"][data-video-model-key]')) {
    add(element.getAttribute('data-video-model-key'), element.textContent);
  }
  return { entries };
};
```

Add `listVideoModels` to `handlers`. Delete `I2V_MODELS` and `i2vModelKey`. In `submitVideoStartImage`, validate `payload.modelKey` with the same conservative ASCII transport-key shape and send `videoModelKey: payload.modelKey` exactly. Remove `workflowId` and `remainingCredits` from submit/check results. Add a source contract proving `transportKey` and generic `script[type="application/json"]` discovery are absent; if neither identified source is present, the command returns an empty list and the tested fallback is used.

- [ ] **Step 4: Wire inventory storage, fail-closed validation, and exact queue snapshots**

In `background.js`, add `FLOW_MODEL_INVENTORY_KEY = 'flowVideoModelInventory'` and:

```js
async function refreshFlowModels(tab) {
  const activeTab = tab || await ensureFlowTab();
  const discovered = await runFlow(activeTab.id, 'listVideoModels');
  const inventory = { ...inventoryResult(discovered.entries), refreshedAt: Date.now() };
  await chrome.storage.local.set({ [FLOW_MODEL_INVENTORY_KEY]: inventory });
  return { ok: true, ...inventory };
}

async function requireCurrentModel(modelKey, tab) {
  const inventory = await refreshFlowModels(tab);
  return { ...resolveVideoModel(modelKey, inventory.models), source: inventory.source };
}
```

Add this executable snapshot helper to `src/lib/video-models.js` and use it in both background enqueue paths:

```js
export function snapshotVideoModel(key, models, source) {
  const model = resolveVideoModel(key, models);
  return {
    videoModelKey: model.key,
    videoModelLabel: model.label,
    videoModelSource: source === 'live' ? 'live' : 'fallback',
  };
}
```

At both enqueue entry points, refresh inventory before reading/mutating the queue and call `snapshotVideoModel(payload.videoModelKey, inventory.models, inventory.source)`; spread its exact fields into each item. In `generateAndSave`, skip inventory validation entirely when `item.videoMediaId` already exists so recovery can poll/download/ingest the known result. Otherwise call `requireCurrentModel(item.videoModelKey, tab)` before any image generation/upload request, require its label to equal `item.videoModelLabel`, and fail if it changed or disappeared; the same validated snapshot is then used for a new video submission. Pass `modelKey: item.videoModelKey` to `submitVideoStartImage`.

Add the `refreshFlowModels` runtime message. Keep `flowContext` and project creation unchanged.

- [ ] **Step 5: Render exact dynamic choices and provenance in the panel**

Remove the Provider select. Make `videoModel` initially empty, add `modelInventoryState` with `aria-live="polite"`, and add a `refreshModels` button. Implement `renderModelInventory(inventory)` by replacing options from `inventory.models`, selecting `settings.videoModelKey` only when present, and displaying `Live from this Flow workspace` or `Tested fallback catalog`. Refresh on panel initialization, on `Use current tab`, and on the explicit button; save `videoModelKey`, the selected option text as `videoModelLabel`, and the current source. Pass those three exact values to both enqueue messages.

- [ ] **Step 6: Run tests and syntax checks**

Run: `npm test && find src -name '*.js' -print0 | xargs -0 -n1 node --check`

Expected: PASS; source contracts confirm no silent unknown-to-Fast fallback and no provider selector.

- [ ] **Step 7: Commit signed inventory and snapshots**

```bash
git add src/lib/video-models.js src/lib/flow-exec.js src/background.js src/popup/popup.js src/popup/popup.html src/popup/popup.css test/video-models.test.js
git commit -m "feat: discover exact Flow video models"
```

---

### Task 3: Fresh-Image And Paid-Video Recovery Boundaries

**Files:**
- Create: `src/lib/video-rules.js`
- Modify: `src/background.js:495-590,707-833`
- Modify: `src/popup/popup.js:401-459,560-607`
- Create: `test/video-rules.test.js`

**Interfaces:**
- Produces: `classifyInterruptedItem(item): { status: 'pending'|'ambiguous', phase: string, ambiguityKind?: 'image'|'video', error?: string }`.
- Produces: `activeItemKey(item): string` and `hasActiveDuplicate(queue, item): boolean`.
- Produces: `migrateStoredQueue(queue): { queue: object[], changed: boolean }`, preserving known media IDs and removing obsolete fields.
- Consumes: exact queue model fields from Task 2.

- [ ] **Step 1: Write failing recovery and active-deduplication tests**

```js
// test/video-rules.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInterruptedItem, hasActiveDuplicate, migrateStoredQueue } from '../src/lib/video-rules.js';

test('quarantines interrupted fresh-image submission without a media id', () => {
  assert.deepEqual(classifyInterruptedItem({ phase: 'image_submitting' }), {
    status: 'ambiguous',
    phase: 'image_submitting',
    ambiguityKind: 'image',
    error: 'Fresh-image generation may have reached Flow. Inspect the Flow project before explicitly regenerating it.',
  });
});

test('resumes safely after a saved image or known video media id', () => {
  assert.deepEqual(classifyInterruptedItem({ phase: 'image_submitting', startMediaId: 'img/1' }), {
    status: 'pending', phase: 'prepared',
  });
  assert.deepEqual(classifyInterruptedItem({ phase: 'submitting', videoMediaId: 'video/1' }), {
    status: 'pending', phase: 'polling',
  });
});

test('quarantines unknown paid video submission and requeues non-paid phases', () => {
  assert.equal(classifyInterruptedItem({ phase: 'submitting' }).ambiguityKind, 'video');
  assert.deepEqual(classifyInterruptedItem({ phase: 'submitting', startMediaId: 'img/1' }), {
    status: 'ambiguous',
    phase: 'submitting',
    ambiguityKind: 'video',
    error: 'Paid video submission may have reached Flow. Inspect the Flow project before explicitly resubmitting it.',
  });
  assert.deepEqual(classifyInterruptedItem({ phase: 'downloading' }), {
    status: 'pending', phase: 'downloading',
  });
});

test('migrates persistent legacy queue items without replaying uncertain work', () => {
  const { queue } = migrateStoredQueue([
    { id: 'known', status: 'running', phase: 'submitting', videoMediaId: 'video/1', videoModel: 'unknown', workflowId: 'dead' },
    { id: 'uncertain', status: 'running', phase: 'submitting', videoModel: 'veo-3.1-fast' },
    { id: 'legacy', status: 'pending', phase: 'queued', videoModel: 'veo-3.1-fast', videoProvider: 'workspace' },
    { id: 'unknown', status: 'pending', phase: 'queued', videoModel: 'unmapped' },
  ]);
  assert.equal(queue[0].videoMediaId, 'video/1');
  assert.equal(queue[0].workflowId, undefined);
  assert.equal(queue[0].videoModel, undefined);
  assert.equal(queue[1].status, 'ambiguous');
  assert.equal(queue[2].videoModelKey, 'veo_3_1_i2v_fast');
  assert.equal(queue[2].videoProvider, undefined);
  assert.equal(queue[3].status, 'failed');
});

test('deduplicates only active equivalent work including generation settings', () => {
  const item = { slug: 'p', episodeCode: 'E1', sceneId: 's1', videoModelKey: 'veo_x', aspectRatio: '16:9', videoSource: 'existing' };
  assert.equal(hasActiveDuplicate([{ ...item, status: 'pending' }], item), true);
  assert.equal(hasActiveDuplicate([{ ...item, status: 'done' }], item), false);
  assert.equal(hasActiveDuplicate([{ ...item, status: 'running', videoModelKey: 'veo_y' }], item), false);
});
```

- [ ] **Step 2: Run the focused recovery tests and verify the module is missing**

Run: `npm test -- --test-name-pattern='quarantines|resumes safely|deduplicates only|migrates persistent'`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/video-rules.js`.

- [ ] **Step 3: Implement pure interruption and deduplication rules**

Implement `activeItemKey` from normalized `slug`, `episodeCode`, `sceneId`, `videoModelKey`, `aspectRatio`, `videoSource`, `imageModel`, and normalized prompts. `hasActiveDuplicate` checks only `pending` and `running`. Implement `classifyInterruptedItem` in this strict order: a known `videoMediaId` returns pending/polling; `phase === 'submitting'` without it returns ambiguous/video even when `startMediaId` exists; a known `startMediaId` returns pending/prepared unless the phase is already polling/downloading/ingesting; `image_submitting` without it returns ambiguous/image; all other phases return pending with their existing phase or `queued`.

Implement `migrateStoredQueue` as a copy-on-write pass. Remove `videoProvider`, `videoModel`, `workflowId`, and `remainingCredits` from every returned item after first reading any legacy model value needed for migration. Never require or alter media IDs to poll an item with `videoMediaId`. For pre-submit items, map only the four known legacy `videoModel` values to exact key/label/source snapshots; mark an unknown legacy model failed with an actionable refresh-and-requeue message. Classify legacy `submitting` items without `videoMediaId` as ambiguous before any other migration. `getQueue` performs only read, migration, and one conditional persistence write; it must not call recovery. The existing one-time startup `recoverInterruptedJobs()` awaits `getQueue()` and then applies interruption recovery exactly once.

- [ ] **Step 4: Persist image submission before the provider request and consume the pure rules**

Immediately before `runFlow(..., 'generateImage', ...)`, persist:

```js
await patchItem(item.id, {
  phase: 'image_submitting',
  imageSubmissionStartedAt: Date.now(),
});
```

Immediately after a successful response, persist `{ startMediaId, phase: 'prepared' }` in one patch. Existing scene-image uploads may use `preparing` because they do not spend generation credits. Update catch/recovery handling to use `classifyInterruptedItem`; persist `ambiguityKind`, pause the queue, and present kind-specific review text. An explicit ambiguous-image retry deletes `startMediaId` and `imageSubmissionStartedAt`, returns to `queued`, and requires `acceptAmbiguousRisk`; ambiguous-video retry preserves `startMediaId`, deletes only video submission fields, and returns to `prepared`. Update popup phase/retry copy to distinguish image regeneration from paid video resubmission. Replace local key comparisons with `hasActiveDuplicate`.

- [ ] **Step 5: Run focused and full tests**

Run: `npm test && node --check src/background.js && node --check src/lib/video-rules.js`

Expected: PASS; an interrupted `image_submitting` job cannot become pending automatically, while known IDs resume without new generation/submission.

- [ ] **Step 6: Commit recovery safeguards**

```bash
git add src/lib/video-rules.js src/background.js src/popup/popup.js test/video-rules.test.js
git commit -m "fix: quarantine interrupted Flow image generation"
```

---

### Task 4: Story Studio, Standalone, Fleet, And Dead-State Cleanup

**Files:**
- Modify: `src/lib/video-rules.js`
- Modify: `src/popup/popup.js:192-255,460-607`
- Modify: `src/popup/popup.html:196-204`
- Modify: `src/background.js:88-339,594-705`
- Modify: `src/lib/config.js:42-75`
- Modify: `README.md`
- Modify: `test/video-rules.test.js`

**Interfaces:**
- Produces: `eligibleVideoScenes(review): { id, sceneIndex, label, motionPrompt, imagePrompt, durationSec, hasClip }[]`.
- Produces: `standaloneDownloadPath(sceneId): string`.
- Produces: `FLEET_QUEUE_ACTIONS: readonly string[]` and `isAllowedFleetQueueAction(action): boolean`.
- Consumes: queue/model/recovery rules from Tasks 1-3.

- [ ] **Step 1: Add failing Story, standalone, Fleet, and dead-field tests**

```js
import {
  FLEET_QUEUE_ACTIONS,
  eligibleVideoScenes,
  isAllowedFleetQueueAction,
  standaloneDownloadPath,
} from '../src/lib/video-rules.js';
import { readFile } from 'node:fs/promises';

test('selects only Story Studio scenes eligible for video', () => {
  const review = { animate_min_seconds: 4, scenes: [
    { id: 'ok', scene_index: 1, approved: true, image_filename: '1.png', motion_prompt: 'pan', start_sec: 0, end_sec: 4 },
    { id: 'short', scene_index: 2, approved: true, image_filename: '2.png', motion_prompt: 'pan', start_sec: 0, end_sec: 3 },
    { id: 'blank', scene_index: 3, approved: true, image_filename: '3.png', motion_prompt: ' ', start_sec: 0, end_sec: 5 },
  ] };
  assert.deepEqual(eligibleVideoScenes(review).map((scene) => scene.id), ['ok']);
});

test('uses a stable standalone Downloads path', () => {
  assert.equal(standaloneDownloadPath('standalone_abc_01'), 'StoryStudioVideos/Standalone/standalone_abc_01.mp4');
});

test('allows only consent-scoped Fleet queue commands', () => {
  assert.deepEqual(FLEET_QUEUE_ACTIONS, ['pause_after_current', 'resume_hub_pause', 'clear_pending']);
  assert.equal(isAllowedFleetQueueAction('change_model'), false);
});

test('removes proven-dead video state', async () => {
  const sources = await Promise.all(['../src/lib/config.js', '../src/lib/flow-exec.js', '../src/background.js'].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const source of sources) {
    assert.doesNotMatch(source, /\bvideoProvider\b/);
    assert.doesNotMatch(source, /\bsaveTarget\b/);
    assert.doesNotMatch(source, /\bworkflowId\b/);
    assert.doesNotMatch(source, /\bremainingCredits\b/);
  }
});
```

- [ ] **Step 2: Run focused tests and observe missing exports/dead fields**

Run: `npm test -- --test-name-pattern='Story Studio scenes|Downloads path|Fleet queue|proven-dead'`

Expected: FAIL because helpers are missing and obsolete fields remain.

- [ ] **Step 3: Move only the reusable policy into `video-rules.js`**

Implement the exact current eligibility predicate, mapping, standalone path, and frozen Fleet allowlist. Replace the popup's inline scene filter/map with `eligibleVideoScenes(data)`. Keep `listEpisodes` as one aggregate request and `sceneReview` as the selected episode's only detail request. Add a monotonically increasing load token around project/episode async renders so a stale response cannot replace a newer selection; do not add pagination.

- [ ] **Step 4: Remove dead state and correct Fleet surfaces**

Remove `videoProvider`, `saveTarget`, `workflowId`, and `remainingCredits` from defaults, normalization, queue creation, provider results, retries, and rendering. Replace the side-panel Fleet summary with `Opt-in` and copy that states: `Signed Fleet telemetry can report sanitized queue status. With queue-control consent, Fleet can pause after the current item, resume its own pause, or clear pending work.` Use `FLEET_QUEUE_ACTIONS` in heartbeat capabilities and reject all other actions before mutation. Update README with the same current behavior and signed-session boundary.

- [ ] **Step 5: Run all tests and static checks**

Run: `npm test && find src -name '*.js' -print0 | xargs -0 -n1 node --check`

Expected: PASS; Story and standalone outputs remain intact, Fleet limits are explicit, and dead state has zero source matches.

- [ ] **Step 6: Commit maintained product paths**

```bash
git add src/lib/video-rules.js src/lib/config.js src/background.js src/popup/popup.js src/popup/popup.html README.md test/video-rules.test.js
git commit -m "refactor: clean video generator product paths"
```

---

### Task 5: Release Contracts, Full Verification, And Live Flow Smoke Test

**Files:**
- Modify: `manifest.json:1-35`
- Modify: `CHANGELOG.md:1-8`
- Modify: `README.md`
- Create: `test/release.test.js`

**Interfaces:**
- Consumes: all production interfaces from Tasks 1-4.
- Produces: release version `1.1.0` with declared-file and documentation contracts.

- [ ] **Step 1: Add failing manifest, version, and release-surface tests**

```js
// test/release.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('manifest is valid, versioned 1.1.0, and every declared file exists', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.1.0');
  const paths = [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_page, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  await Promise.all([...new Set(paths)].map((path) => access(resolve(root, path))));
});

test('release notes describe signed Flow inventory and ambiguity recovery', async () => {
  const [readme, changelog] = await Promise.all([
    readFile(resolve(root, 'README.md'), 'utf8'),
    readFile(resolve(root, 'CHANGELOG.md'), 'utf8'),
  ]);
  assert.match(readme, /signed Flow website session/i);
  assert.match(readme, /live.*fallback/i);
  assert.match(changelog, /## 1\.1\.0/);
  assert.match(changelog, /fresh-image.*review/i);
});
```

- [ ] **Step 2: Run release tests and confirm the old version fails**

Run: `npm test -- --test-name-pattern='manifest is valid|release notes describe'`

Expected: FAIL because manifest/changelog still report `1.0.25` and README lacks the new contracts.

- [ ] **Step 3: Complete release metadata and documentation**

Set `manifest.json` to `1.1.0`. Add a top changelog entry covering live/fallback exact model inventory, fail-closed model snapshots, fresh-image and paid-video ambiguity recovery, dead-setting removal, tested Story/standalone behavior, and active Fleet copy. README must state that no developer API key/billing route exists, website quota/credits are used, live models auto-appear only with an exact provider key, fallback provenance is shown, and ambiguous work needs explicit review.

- [ ] **Step 4: Run the complete automated release gate**

Run:

```bash
npm test
find . -path './node_modules' -prune -o -name '*.js' -print0 | xargs -0 -n1 node --check
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('manifest.json')); const p=[m.background.service_worker,m.side_panel.default_path,m.options_page,...Object.values(m.icons),...Object.values(m.action.default_icon)]; for(const f of new Set(p)){if(!fs.existsSync(f)) throw Error('Missing '+f)}"
git diff --check
```

Expected: all tests pass, every JavaScript file parses, every declared file exists, and Git reports no whitespace errors.

- [ ] **Step 5: Reload the unpacked extension and verify real signed Flow behavior**

In Chrome, reload this repository from `chrome://extensions`, open a signed `https://labs.google/fx/.../project/<uuid>` workspace, open the side panel, and press `Refresh models`. Record whether the panel reports `Live from this Flow workspace` or `Tested fallback catalog`, and confirm each displayed model has a non-empty exact key in the background response. Queue one approved Story scene when available, otherwise one standalone prompt. Verify the queue records `image_submitting` before fresh-image generation when used, `submitting` before video generation, a `videoMediaId` before polling, then downloads an MP4 or ingests it into the matching Story scene. Do not replay an ambiguous request during the smoke test.

- [ ] **Step 6: Review the final diff and commit the release**

Run: `git status --short && git diff --stat && git diff --check`

Expected: only intended source, tests, docs, and metadata are changed.

```bash
git add manifest.json CHANGELOG.md README.md test/release.test.js
git commit -m "release: video generator 1.1.0"
```

- [ ] **Step 7: Push and verify the remote checkpoint**

Run: `git push origin main && git status --short --branch`

Expected: push succeeds and `main` is aligned with `origin/main` with no uncommitted release changes.
