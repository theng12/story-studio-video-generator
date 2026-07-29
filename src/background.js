import { getSettings, saveSettings, normalizeFlowProjectId } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { buildDownloadPath } from './lib/naming.js';
import { flowCommand } from './lib/flow-exec.js';

const FLOW_URL = 'https://labs.google/fx/tools/flow';
const FLOW_MATCH = 'https://labs.google/fx/*';
const QUEUE_KEY = 'videoQueue';
const PAUSED_KEY = 'videoQueuePaused';
const STATUS_KEY = 'lastVideoStatus';
const NEXT_RUN_KEY = 'nextVideoProviderRunAt';
const COOLDOWN_KEY = 'videoProviderCooldownUntil';
const ALARM = 'videoQueueTick';

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

async function writeStatus(text, kind = 'info', details = {}) {
  await chrome.storage.local.set({
    [STATUS_KEY]: { text, kind, timestamp: Date.now(), ...details },
  });
}

async function getQueue() {
  return (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function patchItem(id, patch) {
  const queue = await getQueue();
  const item = queue.find((candidate) => candidate.id === id);
  if (item) Object.assign(item, patch);
  await setQueue(queue);
  return item;
}

async function ensureFlowTab() {
  const tabs = await chrome.tabs.query({ url: FLOW_MATCH });
  const ready = tabs.find((tab) => tab.status === 'complete');
  if (ready) return ready;
  const tab = tabs[0] || (await chrome.tabs.create({ url: FLOW_URL, active: false }));
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
  if (!/^https:\/\/labs\.google\/fx\//i.test(tab?.url || '')) {
    throw new Error('Refusing to run a Flow command outside labs.google/fx.');
  }
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: flowCommand,
    args: [{ op, payload }],
  });
  if (!result?.ok) throw new Error(result?.error || `Flow ${op} failed.`);
  return result.result;
}

async function flowContext() {
  const tab = await ensureFlowTab();
  return { ok: true, ...(await runFlow(tab.id, 'getContext')) };
}

async function createFlowProject() {
  const tab = await ensureFlowTab();
  const created = await runFlow(tab.id, 'createProject');
  await saveSettings({
    flowProjectId: created.projectId,
    flowProjectName: created.title || '',
  });
  await chrome.tabs.update(tab.id, {
    url: `${FLOW_URL}/project/${created.projectId}`,
    autoDiscardable: false,
  });
  return { ok: true, ...created };
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function downloadVideo(mediaId) {
  const endpoint =
    `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect` +
    `?name=${encodeURIComponent(mediaId)}&mediaUrlType=MEDIA_URL_TYPE_FULL_MEDIA`;
  const response = await fetch(endpoint, { credentials: 'include' });
  if (!response.ok) throw new Error(`Video download failed (${response.status}).`);
  const mediaUrl = new URL(response.url);
  if (
    mediaUrl.protocol !== 'https:' ||
    !(mediaUrl.hostname === 'flow-content.google' ||
      mediaUrl.hostname.endsWith('.flow-content.google'))
  ) {
    throw new Error('Flow returned an untrusted video URL.');
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('video/')) throw new Error('Flow returned a non-video asset.');
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error('Downloaded video was empty.');
  if (buffer.byteLength > 256 * 1024 * 1024) throw new Error('Downloaded video exceeded 256 MB.');
  return buffer;
}

async function waitForPacing(settings, item) {
  for (;;) {
    const nextRunAt = Number((await chrome.storage.local.get(NEXT_RUN_KEY))[NEXT_RUN_KEY]) || 0;
    const remaining = nextRunAt - Date.now();
    if (remaining <= 0) return;
    await writeStatus(`Waiting before ${item.label}…`, 'info', { countdownUntil: nextRunAt });
    await sleep(Math.min(remaining, 10000));
  }
}

async function setNextRun(settings) {
  const minimum = Math.max(0, Number(settings.humanDelayMinSec) || 0);
  const maximum = Math.max(minimum, Number(settings.humanDelayMaxSec) || 0);
  const seconds = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
  await chrome.storage.local.set({ [NEXT_RUN_KEY]: Date.now() + seconds * 1000 });
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
    await chrome.storage.local.remove(COOLDOWN_KEY);
    return false;
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
  const studio = new StudioClient(settings.studioBaseUrl);

  if (!item.startMediaId) {
    await patchItem(item.id, { phase: 'preparing' });
    if (item.videoSource === 'generate') {
      await writeStatus(`${item.label}: generating a start image…`, 'running');
      const generated = await runFlow(tab.id, 'generateImage', {
        projectId,
        prompt: item.imagePrompt || item.motionPrompt,
        model: item.imageModel || settings.imageModel,
        aspectRatio: item.aspectRatio,
        recaptchaMaxAttempts: 4,
      });
      item.startMediaId = generated.mediaId;
    } else {
      await writeStatus(`${item.label}: uploading the scene image…`, 'running');
      const image = await studio.sceneImageBase64(item.slug, item.episodeCode, item.sceneId);
      const uploaded = await runFlow(tab.id, 'uploadImage', {
        projectId,
        base64: image.base64,
        mime: image.mime,
        fileName: `${item.sceneId}.png`,
      });
      item.startMediaId = uploaded.mediaId;
    }
    await patchItem(item.id, { startMediaId: item.startMediaId });
  }

  if (!item.videoMediaId) {
    // Persist BEFORE the paid request. If the worker dies before receiving the
    // media id, startup quarantines this item instead of charging again.
    await patchItem(item.id, { phase: 'submitting', submissionStartedAt: Date.now() });
    await writeStatus(`${item.label}: submitting paid video generation…`, 'running');
    const submitted = await runFlow(tab.id, 'submitVideoStartImage', {
      projectId,
      mediaId: item.startMediaId,
      motionPrompt: item.motionPrompt,
      model: item.videoModel,
      aspectRatio: item.aspectRatio,
      durationSec: item.durationSec,
    });
    item.videoMediaId = submitted.mediaId;
    await patchItem(item.id, {
      videoMediaId: submitted.mediaId,
      workflowId: submitted.workflowId,
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
    if (status.failed) throw new Error(`Flow video generation ${status.status}.`);
    if (Date.now() > deadline) throw new Error(`Video timed out (${status.status}).`);
    await writeStatus(
      `${item.label}: ${String(status.status)
        .replace('MEDIA_GENERATION_STATUS_', '')
        .toLowerCase()}…`,
      'running'
    );
    await sleep(10000);
  }

  await patchItem(item.id, { phase: 'downloading' });
  const mp4 = await downloadVideo(item.videoMediaId);
  if (item.target === 'project') {
    await studio.uploadClip(item.slug, item.episodeCode, item.sceneId, mp4);
    return `${item.sceneId}.mp4`;
  }
  const filename = item.downloadPath.replace(/\.(mp4|webm)$/i, '') + '.mp4';
  await chrome.downloads.download({
    url: `data:video/mp4;base64,${bufferToBase64(mp4)}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return filename;
}

function itemKey(item) {
  return `${item.slug}::${item.episodeCode}::${item.sceneId}`;
}

async function enqueueScenes(payload) {
  const settings = await getSettings();
  const projectId = normalizeFlowProjectId(payload.projectId || settings.flowProjectId);
  if (!projectId) throw new Error('Select a Flow project before queuing videos.');
  const queue = await getQueue();
  const active = new Set(
    queue
      .filter((item) => ['pending', 'running'].includes(item.status))
      .map(itemKey)
  );
  let added = 0;
  let skipped = 0;
  for (const scene of payload.scenes || []) {
    const item = {
      id: `${Date.now()}_${sequence++}`,
      status: 'pending',
      phase: 'queued',
      queuedAt: Date.now(),
      slug: payload.slug,
      projectName: payload.projectName || payload.slug,
      episodeCode: payload.episodeCode,
      episodeTitle: payload.episodeTitle || '',
      sceneId: scene.id,
      label: `${payload.episodeCode} · ${scene.label || scene.id}`,
      motionPrompt: scene.motionPrompt || '',
      imagePrompt: scene.imagePrompt || '',
      durationSec: scene.durationSec,
      projectId,
      videoProvider: payload.videoProvider || settings.videoProvider,
      videoModel: payload.videoModel || settings.videoModel,
      videoSource: payload.videoSource || settings.videoSource,
      imageModel: settings.imageModel,
      aspectRatio: payload.aspectRatio || settings.aspectRatio,
      target: payload.target || settings.saveTarget,
      downloadPath: buildDownloadPath(
        settings,
        {
          project: payload.projectName || payload.slug,
          episodeCode: payload.episodeCode,
          episodeTitle: payload.episodeTitle || '',
          sceneId: scene.id,
          sceneIndex: scene.sceneIndex ?? scene.id,
        },
        'mp4'
      ),
    };
    if (active.has(itemKey(item))) {
      skipped++;
      continue;
    }
    queue.push(item);
    active.add(itemKey(item));
    added++;
  }
  await setQueue(queue);
  if (added) {
    await chrome.storage.local.remove(PAUSED_KEY);
    createAlarm();
    processQueue();
  }
  return { ok: true, added, skipped };
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      if (await isPaused()) break;
      const queue = await getQueue();
      const pending = queue.find((item) => item.status === 'pending');
      if (!pending) break;
      const settings = await getSettings();
      if (await holdForCooldown(settings, pending)) break;
      await waitForPacing(settings, pending);
      if (await isPaused()) break;
      const current = await patchItem(pending.id, {
        status: 'running',
        startedAt: pending.startedAt || Date.now(),
      });
      if (!current) continue;
      let providerAttempted = false;
      try {
        const tab = await ensureFlowTab();
        providerAttempted = true;
        const savedAs = await generateAndSave(current, settings, tab);
        await patchItem(current.id, {
          status: 'done',
          phase: 'done',
          savedAs,
          finishedAt: Date.now(),
          error: undefined,
        });
      } catch (error) {
        const latest = (await getQueue()).find((item) => item.id === current.id) || current;
        const ambiguous =
          latest.phase === 'submitting' && !latest.videoMediaId;
        if (ambiguous) {
          await patchItem(current.id, {
            status: 'ambiguous',
            error:
              'The paid request may have reached Flow, but no media ID was returned. Inspect the Flow project before choosing to resubmit.',
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
        if (providerAttempted) await setNextRun(settings);
      }
    }
    const queue = await getQueue();
    if (!queue.some((item) => ['pending', 'running'].includes(item.status))) clearAlarm();
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
  if (item.status === 'ambiguous' && !acceptAmbiguousRisk) {
    return { ok: false, ambiguous: true, error: 'Explicit duplicate-charge acceptance is required.' };
  }
  if (item.status === 'ambiguous') {
    delete item.videoMediaId;
    delete item.workflowId;
    item.phase = 'prepared';
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
  await setQueue(queue.filter((item) => item.status !== 'pending'));
  return { ok: true };
}

async function recoverInterruptedJobs() {
  const queue = await getQueue();
  let changed = false;
  for (const item of queue) {
    if (item.status !== 'running') continue;
    changed = true;
    if (item.phase === 'submitting' && !item.videoMediaId) {
      item.status = 'ambiguous';
      item.error =
        'The extension stopped during paid submission. Inspect Flow before explicitly resubmitting.';
    } else {
      item.status = 'pending';
    }
  }
  if (changed) await setQueue(queue);
  if (queue.some((item) => item.status === 'pending')) {
    createAlarm();
    processQueue();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const reply = (promise) =>
    promise
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  switch (message?.type) {
    case 'getQueue':
      reply(
        Promise.all([getQueue(), isPaused(), chrome.storage.local.get(COOLDOWN_KEY)]).then(([queue, paused, stored]) => ({
          ok: true,
          queue,
          paused,
          cooldownUntil: Number(stored[COOLDOWN_KEY]) || 0,
        }))
      );
      return true;
    case 'enqueueScenes':
      reply(enqueueScenes(message.payload));
      return true;
    case 'pauseQueue':
      reply(chrome.storage.local.set({ [PAUSED_KEY]: true }).then(() => ({ ok: true })));
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
    default:
      return false;
  }
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === ALARM) processQueue();
});

try {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch {
  // Older Chrome versions do not support sidePanel.
}

recoverInterruptedJobs();
