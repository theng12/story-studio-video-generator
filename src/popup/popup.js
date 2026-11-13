import { getSettings, saveSettings, getGatewayToken, saveGatewayToken } from '../lib/config.js';
import { initTheme } from '../lib/theme.js';
import { FALLBACK_VIDEO_MODELS, defaultVideoModel, modelsForMode } from '../lib/video-models.js';
import { ambiguityRetryCopy } from '../lib/video-panel.js';

const $ = (id) => document.getElementById(id);
let settings;
let gatewayToken = '';
let elapsedStartedAt = 0;
let latestLiveStatus = null;
let activeCooldownUntil = 0;
let modelInventorySource = 'fallback';
let currentModels = FALLBACK_VIDEO_MODELS;

function renderDurationState() {
  const model = currentModels.find((entry) => entry.key === $('videoModel').value);
  const durationSec = Number($('videoDurationSec').value);
  const verified = modelInventorySource === 'live' && model?.durationSec === durationSec;
  $('videoDurationSec').setAttribute('aria-invalid', String(!verified));
  $('videoDurationState').textContent = modelInventorySource !== 'live'
    ? 'New generation is unavailable: the current request mapping is unverified. Your model and length stay saved.'
    : verified
      ? `${durationSec}s per clip. This length has a current request mapping for this model.`
      : `This length is unavailable for the selected model. ${model?.durationSec ? `Only ${model.durationSec}s has a request mapping.` : 'No request length has been captured.'} Refresh models or choose a verified combination.`;
}

function renderModelInventory(inventory) {
  const mode = settings.videoMode === 'text' ? 'text' : 'image';
  const models = modelsForMode(inventory?.models, mode);
  currentModels = models;
  const options = models.map((model) => new Option(model.label, model.key));
  if (!models.some((model) => model.key === settings.videoModelKey)) {
    options.unshift(new Option(`${settings.videoModelLabel || 'Saved model'} · unavailable`, settings.videoModelKey));
  }
  $('videoModel').replaceChildren(...options);
  $('videoModel').value = settings.videoModelKey;
  $('videoDurationSec').value = settings.videoDurationSec ?? '';
  modelInventorySource = inventory?.source === 'live' ? 'live' : 'fallback';
  const observed = inventory?.observedSelection;
  $('modelInventoryState').textContent = (modelInventorySource === 'live'
    ? 'Live request mappings'
    : 'Historical selections only; live model availability is unknown.') +
    (observed ? ` Workspace shows ${observed.durationSec}s at ${observed.resolution}, x${observed.outputCount}; request mapping unverified.` : '');
  renderDurationState();
}

async function refreshModels() {
  const inventory = await chrome.runtime.sendMessage({ type: 'refreshFlowModels' });
  if (!inventory?.ok) throw new Error(inventory?.error || 'Could not refresh Flow models.');
  renderModelInventory(inventory);
}

function modelSnapshot() {
  const option = $('videoModel').selectedOptions[0];
  return {
    videoModelKey: $('videoModel').value,
    videoModelLabel: option?.textContent || '',
    videoModelSource: modelInventorySource,
    durationSec: Number($('videoDurationSec').value),
  };
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `muted ${kind}`.trim();
}

function publicMessage(value) {
  return String(value || '')
    .replace(/Flow\/Veo/gi, 'generation')
    .replace(/\bFlow\b/gi, 'the generation workspace')
    .replace(/\bVeo\b/gi, 'the video model')
    .replace(/labs\.google\/fx/gi, 'the generation workspace');
}

function isGatewayMode() {
  return settings?.mode === 'gateway';
}

let standalonePrompts = [];

function renderGatewaySettings() {
  if (!$('gatewayUrl')) return;
  $('gatewayUrl').value = settings.gatewayUrl || '';
  $('gatewayToken').value = gatewayToken || '';
  $('gatewayWorker').textContent = settings.gatewayWorkerId
    ? `Worker ${settings.gatewayWorkerId.slice(0, 22)}…`
    : 'Worker id assigned on first claim';
}

function renderWorkingMode() {
  const gateway = isGatewayMode();
  $('workingMode').value = gateway ? 'gateway' : 'standalone';
  $('standalonePane').hidden = gateway;
  $('gatewayPane').hidden = !gateway;
  // Standalone shows the Flow workspace; Gateway work carries its own project.
  document.querySelector('.workspace-panel').hidden = gateway;
  if (gateway) renderGatewaySettings();
}

function renderVideoMode() {
  const text = settings.videoMode === 'text';
  $('videoMode').value = text ? 'text' : 'image';
}

async function changeVideoMode() {
  const videoMode = $('videoMode').value === 'text' ? 'text' : 'image';
  const model = defaultVideoModel(videoMode);
  settings = await saveSettings({
    videoMode,
    videoModelKey: model.key,
    videoModelLabel: model.label,
    videoModelSource: 'fallback',
    videoDurationSec: model.durationSec,
  });
  renderVideoMode();
  await refreshModels();
}

async function saveGatewaySettings() {
  settings = await saveSettings({
    gatewayUrl: $('gatewayUrl').value.trim(),
  });
  await saveGatewayToken($('gatewayToken').value);
  gatewayToken = await getGatewayToken();
  renderGatewaySettings();
}

async function testGatewayConnection() {
  await saveGatewaySettings();
  setStatus('Testing Gateway Studio…');
  const result = await chrome.runtime.sendMessage({ type: 'gatewayTest' });
  if (!result?.ok) throw new Error(result?.error || 'Gateway Studio is unreachable.');
  settings = await getSettings();
  renderGatewaySettings();
  setStatus('Gateway Studio connected.', 'ok');
}

async function claimGatewayNow() {
  await saveGatewaySettings();
  const result = await chrome.runtime.sendMessage({ type: 'gatewayClaimNow' });
  if (!result?.ok) throw new Error(result?.error || 'Gateway could not check for work.');
  await pollQueue();
  setStatus('Checked Gateway Studio for work.', 'ok');
}

async function changeWorkingMode() {
  const mode = ['standalone', 'gateway'].includes($('workingMode').value)
    ? $('workingMode').value
    : 'standalone';
  settings = await saveSettings({ mode });
  if (mode === 'gateway') {
    await saveGatewaySettings();
    await chrome.runtime.sendMessage({ type: 'gatewayModeChanged' });
    renderWorkingMode();
    renderVideoMode();
    setStatus('Gateway Studio mode: the extension claims jobs from your gateway.', 'ok');
    return;
  }
  await chrome.runtime.sendMessage({ type: 'gatewayModeChanged' }).catch(() => {});
  renderWorkingMode();
  renderVideoMode();
  setStatus('Standalone mode uses a local prompt and Downloads.', 'ok');
}

async function useCurrentWorkspace() {
  setStatus('Reading the current generation tab…');
  const context = await chrome.runtime.sendMessage({ type: 'flowContext' });
  if (!context?.ok || !context.projectId) {
    throw new Error(
      context?.signedIn === false
        ? 'Sign in and open a generation project first.'
        : 'Open a generation project first.'
    );
  }
  settings = await saveSettings({
    flowProjectId: context.projectId,
    flowProjectName: context.projectId,
  });
  renderWorkspace();
  await refreshModels();
  setStatus('Generation workspace selected.', 'ok');
}

function renderWorkspace() {
  $('flowProject').textContent = settings.flowProjectName || settings.flowProjectId || 'None selected';
}

function closeConfirmation() {
  $('confirm').hidden = true;
  $('confirmOk').textContent = 'Use credits & queue';
  $('confirmOk').onclick = null;
}

function showConfirmation({ title, body, confirmLabel, onConfirm }) {
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmOk').textContent = confirmLabel;
  $('confirm').hidden = false;
  $('confirmOk').onclick = async () => {
    $('confirmOk').disabled = true;
    try {
      await onConfirm();
      closeConfirmation();
    } catch (error) {
      setStatus(publicMessage(error.message), 'failed');
    } finally {
      $('confirmOk').disabled = false;
    }
  };
}

function parseStandalonePrompts(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((prompt) => prompt.trim().replace(/^(?:[-*]|\d+[.)])\s+/, ''))
    .filter(Boolean)
    .slice(0, 100);
}

function showStandaloneEditor() {
  $('standaloneEditor').hidden = false;
  $('standaloneReview').hidden = true;
}

function reviewStandalonePrompts() {
  const prompts = parseStandalonePrompts($('standalonePrompt').value);
  if (!prompts.length) return setStatus('Add at least one video prompt first.', 'failed');
  standalonePrompts = prompts;
  $('standaloneReviewCount').textContent = `${prompts.length} prompt${prompts.length === 1 ? '' : 's'}`;
  $('standaloneReviewList').replaceChildren(
    ...prompts.map((prompt, index) => {
      const item = document.createElement('li');
      item.textContent = `${index + 1}. ${prompt}`;
      item.title = prompt;
      return item;
    })
  );
  $('standaloneEditor').hidden = true;
  $('standaloneReview').hidden = false;
  setStatus(`Review ${prompts.length} video prompt${prompts.length === 1 ? '' : 's'} before queueing.`, 'ok');
}

function confirmStandalone() {
  if (!standalonePrompts.length) return setStatus('Review the prompts before queueing.', 'failed');
  if (!settings.flowProjectId) return setStatus('Select a generation workspace first.', 'failed');
  showConfirmation({
    title: `Generate ${standalonePrompts.length} standalone video${standalonePrompts.length === 1 ? '' : 's'}?`,
    body: 'These local prompts will run sequentially. Completed files save to Downloads and may use account credits.',
    confirmLabel: 'Use credits & queue',
    onConfirm: async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'enqueueStandalone',
        payload: {
          prompts: standalonePrompts,
          projectId: settings.flowProjectId,
          ...modelSnapshot(),
          videoMode: settings.videoMode,
          aspectRatio: settings.aspectRatio,
        },
      });
      if (!response?.ok) throw new Error(response?.error || 'Could not queue this video.');
      setStatus(response.added ? `Queued ${response.added} standalone video${response.added === 1 ? '' : 's'}.` : 'Matching standalone videos are already queued.', 'ok');
      $('standalonePrompt').value = '';
      standalonePrompts = [];
      showStandaloneEditor();
      await pollQueue();
    },
  });
}

function showAmbiguousRetry(item) {
  const copy = ambiguityRetryCopy(item);
  showConfirmation({
    title: copy.title,
    body: copy.body,
    confirmLabel: copy.confirmLabel,
    onConfirm: async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'retryItem',
        id: item.id,
        acceptAmbiguousRisk: true,
      });
      if (!response?.ok) throw new Error(response?.error || 'Could not retry this request.');
      setStatus(copy.status, 'ok');
      await pollQueue();
    },
  });
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  if (minutes) return `${minutes}m${seconds ? ` ${seconds}s` : ''}`;
  return `${seconds}s`;
}

function updateElapsed() {
  if (!elapsedStartedAt) {
    $('activityElapsed').hidden = true;
    return;
  }
  $('activityElapsed').hidden = false;
  $('activityElapsed').textContent = formatElapsed(Date.now() - elapsedStartedAt);
}

function phaseLabel(phase) {
  return {
    queued: 'Waiting to start',
    preparing: 'Preparing input',
    prepared: 'Ready to submit',
    submitting: 'Submitting request',
    polling: 'Generating video',
    downloading: 'Saving video',
    done: 'Saved',
  }[phase] || 'Processing';
}

function renderQueue(queue, state, live) {
  const total = queue.length;
  const counts = {
    pending: queue.filter((item) => item.status === 'pending').length,
    running: queue.filter((item) => item.status === 'running').length,
    done: queue.filter((item) => item.status === 'done').length,
    failed: queue.filter((item) => item.status === 'failed').length,
    ambiguous: queue.filter((item) => item.status === 'ambiguous').length,
  };
  const left = counts.pending + counts.running;
  const finished = counts.done + counts.failed + counts.ambiguous;
  const running = queue.find((item) => item.status === 'running');
  const nextPending = queue.find((item) => item.status === 'pending');
  const cooldownUntil = Number(state?.cooldownUntil) ||
    (live?.countdownReason === 'cooldown' ? Number(live.countdownUntil) : 0);
  activeCooldownUntil = cooldownUntil;
  const cooling = left > 0 && cooldownUntil > Date.now();
  const waiting = !cooling && left > 0 && Number(live?.countdownUntil) > Date.now();

  let stateClass = 'idle';
  let stateText = 'Ready';
  if (counts.ambiguous) {
    stateClass = 'review';
    stateText = 'Needs review';
  } else if (running) {
    stateClass = 'running';
    stateText = 'Generating';
  } else if (cooling) {
    stateClass = 'cooldown';
    stateText = 'Cooldown';
  } else if (waiting) {
    stateClass = 'waiting';
    stateText = 'Waiting';
  } else if (state?.paused && left) {
    stateClass = 'paused';
    stateText = 'Paused';
  } else if (counts.pending) {
    stateClass = 'queued';
    stateText = 'Queued';
  } else if (total) {
    stateClass = 'done';
    stateText = counts.failed ? 'Finished with issues' : 'Finished';
  }

  $('genStatusBar').className = `genstatus ${stateClass}`;
  $('gsStateText').textContent = stateText;
  $('gsCounts').hidden = !total;
  $('gsDone').textContent = `${counts.done} done`;
  $('gsFailed').textContent = `${counts.failed + counts.ambiguous} issue${counts.failed + counts.ambiguous === 1 ? '' : 's'}`;
  $('gsLeft').textContent = `${left} left`;

  const panelClasses = ['activity-panel'];
  if (running) panelClasses.push('is-running');
  else if (waiting || cooling) panelClasses.push('is-waiting');
  else if (counts.ambiguous) panelClasses.push('has-review');
  else if (total && !left && counts.failed) panelClasses.push('has-failure');
  else if (total && !left) panelClasses.push('is-complete');
  $('activityPanel').className = panelClasses.join(' ');

  if (running) {
    $('activeJob').textContent = running.label;
    $('activeJobMeta').textContent =
      `${phaseLabel(running.phase)} · ${running.gatewayJobId ? 'Gateway Studio' : 'Standalone'}`;
  } else if (counts.ambiguous) {
    $('activeJob').textContent = 'A video needs review';
    $('activeJobMeta').textContent = 'The request may already exist. Inspect the workspace before resubmitting.';
  } else if (state?.paused && left) {
    $('activeJob').textContent = 'Batch paused';
    $('activeJobMeta').textContent = `${left} video${left === 1 ? '' : 's'} waiting.`;
  } else if (nextPending) {
    $('activeJob').textContent = nextPending.label;
    $('activeJobMeta').textContent = cooling
      ? `Cooldown ends in ${formatDuration(cooldownUntil - Date.now())}.`
      : waiting ? 'Waiting for the configured pace.' : 'Waiting to start.';
  } else if (total) {
    $('activeJob').textContent = counts.failed ? 'Batch completed with issues' : 'Batch complete';
    $('activeJobMeta').textContent =
      `${counts.done} saved · ${counts.failed} failed · ${counts.ambiguous} need review`;
  } else {
    $('activeJob').textContent = 'Ready to generate video';
    $('activeJobMeta').textContent = 'Add prompts, then queue them.';
  }

  const progress = total ? Math.round(((finished + counts.running * .45) / total) * 100) : 0;
  $('activityProgressFill').style.width = `${progress}%`;
  $('activityProgressText').textContent = `${progress}%`;

  elapsedStartedAt = Number(running?.startedAt) || 0;
  updateElapsed();

  $('pauseQueue').hidden = !left;
  $('pauseQueue').textContent = state?.paused || cooling ? 'Resume' : 'Pause';
  $('pauseQueue').dataset.paused = String(Boolean(state?.paused || cooling));
  $('retryFailed').disabled = counts.failed === 0;
  $('clearQueue').disabled = counts.pending === 0;
  $('queueDetail').hidden = !total;
  $('queueList').hidden = !total;
  $('queueInfo').textContent = `${total} video${total === 1 ? '' : 's'}`;

  $('queueList').replaceChildren();
  queue.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = `qrow q-${item.status}`;

    const number = document.createElement('span');
    number.className = 'qindex';
    number.textContent = String(index + 1);

    const label = document.createElement('span');
    label.className = 'qlabel';
    label.textContent = item.label + (item.durationSec ? ` · ${item.durationSec}s` : '') + (item.savedAs ? ` → ${item.savedAs}` : '');
    label.title = item.error ? publicMessage(item.error) : phaseLabel(item.phase);

    const status = document.createElement('span');
    status.className = `qstate ${item.status}`;
    status.textContent = {
      pending: 'Pending',
      running: phaseLabel(item.phase),
      done: 'Done',
      failed: 'Failed',
      ambiguous: 'Needs review',
    }[item.status] || item.status;

    const actions = document.createElement('span');
    actions.className = 'qactions';
    if (item.status === 'failed' || item.status === 'ambiguous') {
      const retry = document.createElement('button');
      retry.className = 'qretry';
      retry.textContent = '↻';
      retry.title = item.status === 'ambiguous' ? 'Review and resubmit' : 'Retry video';
      retry.setAttribute('aria-label', retry.title);
      retry.addEventListener('click', async () => {
        if (item.status === 'ambiguous') {
          showAmbiguousRetry(item);
          return;
        }
        const response = await chrome.runtime.sendMessage({ type: 'retryItem', id: item.id });
        if (!response?.ok) {
          setStatus(publicMessage(response?.error || 'Could not retry this video.'), 'failed');
          return;
        }
        await pollQueue();
      });
      actions.appendChild(retry);
    }

    row.append(number, label, status, actions);
    $('queueList').appendChild(row);
  });

  renderCooldownState(cooldownUntil);
  renderAppliedSettings();
}

async function pollQueue() {
  try {
    const [state, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'getQueue' }),
      chrome.storage.local.get('lastVideoStatus'),
    ]);
    latestLiveStatus = stored.lastVideoStatus || null;
    renderQueue(state?.queue || [], state, latestLiveStatus);
  } catch (error) {
    setStatus(`Queue status unavailable: ${publicMessage(error.message)}`, 'failed');
  }
}

const HUMAN_PACE_PRESETS = {
  off: { min: 0, max: 0 },
  quick: { min: 2, max: 5 },
  balanced: { min: 5, max: 15 },
  cautious: { min: 15, max: 40 },
};
const COOLDOWN_PRESETS = [15, 30, 60, 240, 1440];

function paceValues() {
  const first = Math.max(0, Number(settings?.humanDelayMinSec) || 0);
  const second = Math.max(0, Number(settings?.humanDelayMaxSec) || 0);
  return { min: Math.min(first, second), max: Math.max(first, second) };
}

function pacePresetKey(min, max) {
  return Object.entries(HUMAN_PACE_PRESETS).find(
    ([, value]) => value.min === min && value.max === max
  )?.[0] || 'custom';
}

function renderHumanPace() {
  const { min, max } = paceValues();
  const key = pacePresetKey(min, max);
  const label = max === 0 ? 'No delay' : min === max ? `${min}s` : `${min}–${max}s`;
  $('humanPacePreset').value = key;
  $('humanPaceCustom').hidden = key !== 'custom';
  $('humanDelayMinSec').value = min;
  $('humanDelayMaxSec').value = max;
  $('humanPaceState').textContent = label;
  $('humanPaceState').className = `pace-state${max ? '' : ' off'}`;
  $('humanPaceSummary').textContent = label;
  renderAppliedSettings();
}

async function savePace(values = null) {
  settings = await saveSettings(values || {
    humanDelayMinSec: $('humanDelayMinSec').value,
    humanDelayMaxSec: $('humanDelayMaxSec').value,
  });
  renderHumanPace();
  setStatus('Human pace saved.', 'ok');
}

async function onPacePreset() {
  const key = $('humanPacePreset').value;
  if (key === 'custom') {
    $('humanPaceCustom').hidden = false;
    $('humanDelayMinSec').focus();
    return;
  }
  await savePace({
    humanDelayMinSec: HUMAN_PACE_PRESETS[key].min,
    humanDelayMaxSec: HUMAN_PACE_PRESETS[key].max,
  });
}

function cooldownMinutesLabel(minutes) {
  if (minutes % 60 === 0) return `${minutes / 60} hr`;
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function cooldownSettings() {
  return settings.providerCooldown || { autoResume: false, minutes: 15 };
}

function renderCooldownCard() {
  const cooldown = cooldownSettings();
  const preset = COOLDOWN_PRESETS.includes(cooldown.minutes) ? String(cooldown.minutes) : 'custom';
  $('cooldownAutoResume').checked = cooldown.autoResume;
  $('cooldownOpts').hidden = !cooldown.autoResume;
  $('cooldownPreset').value = preset;
  $('cooldownCustom').hidden = !cooldown.autoResume || preset !== 'custom';
  $('cooldownMinutes').value = String(cooldown.minutes);
  renderCooldownState();
  renderAppliedSettings();
}

function renderCooldownState(cooldownUntil = 0) {
  const cooldown = cooldownSettings();
  const activeUntil = Number(cooldownUntil) ||
    (latestLiveStatus?.countdownReason === 'cooldown' ? Number(latestLiveStatus.countdownUntil) : 0);
  const active = activeUntil > Date.now();
  const label = !cooldown.autoResume
    ? 'Manual'
    : active ? `On cooldown · ${formatDuration(activeUntil - Date.now())}` : `Auto-resume · ${cooldownMinutesLabel(cooldown.minutes)}`;
  $('cooldownState').textContent = label;
  $('cooldownState').className = `pace-state${cooldown.autoResume ? '' : ' off'}`;
}

function renderAppliedSettings() {
  const { min, max } = paceValues();
  const pace = max === 0 ? 'off' : min === max ? `${min}s` : `${min}–${max}s`;
  const cooldown = cooldownSettings();
  const liveUntil = Number(activeCooldownUntil) ||
    (latestLiveStatus?.countdownReason === 'cooldown' ? Number(latestLiveStatus.countdownUntil) : 0);
  const cooldownText = !cooldown.autoResume
    ? 'manual'
    : liveUntil > Date.now()
      ? `on cooldown · ${formatDuration(liveUntil - Date.now())}`
      : `auto-resume ${cooldownMinutesLabel(cooldown.minutes)}`;
  const line = $('appliedSettings');
  line.replaceChildren();
  const pacing = document.createElement('span');
  pacing.textContent = `⚙ Pacing ${pace}`;
  const providerCooldown = document.createElement('span');
  providerCooldown.textContent = `Provider cooldown: ${cooldownText}`;
  line.append(pacing, providerCooldown);
}

async function saveCooldown(patch) {
  settings = await saveSettings({
    providerCooldown: { ...cooldownSettings(), ...patch },
  });
  renderCooldownCard();
  setStatus('Provider cooldown saved.', 'ok');
}

async function onCooldownPreset() {
  const value = $('cooldownPreset').value;
  if (value === 'custom') {
    $('cooldownCustom').hidden = false;
    $('cooldownMinutes').focus();
    return;
  }
  await saveCooldown({ minutes: Number(value) });
}

async function saveCooldownCustom() {
  await saveCooldown({
    minutes: Math.max(1, Math.min(1440, Math.round(Number($('cooldownMinutes').value) || 15))),
  });
}

function renderChangelog(markdown) {
  const fragment = document.createDocumentFragment();
  for (const rawLine of String(markdown || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line === '# Changelog') continue;
    if (line.startsWith('## ')) {
      const heading = document.createElement('h3');
      heading.className = 'cl-ver';
      heading.textContent = line.slice(3);
      fragment.appendChild(heading);
    } else if (line.startsWith('- ')) {
      const item = document.createElement('div');
      item.className = 'cl-item';
      item.textContent = `• ${line.slice(2)}`;
      fragment.appendChild(item);
    } else {
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      fragment.appendChild(paragraph);
    }
  }
  $('whatsNewBody').replaceChildren(fragment);
}

async function initWhatsNew() {
  let markdown = '';
  try {
    const response = await fetch(chrome.runtime.getURL('CHANGELOG.md'));
    if (response.ok) markdown = await response.text();
  } catch {
    // The panel remains usable if release notes are unavailable.
  }
  renderChangelog(markdown || 'Recent usability and reliability updates.');
  $('whatsNew').addEventListener('click', () => {
    $('whatsNewModal').hidden = false;
  });
  $('whatsNewClose').addEventListener('click', () => {
    $('whatsNewModal').hidden = true;
  });
  $('whatsNewModal').addEventListener('click', (event) => {
    if (event.target === $('whatsNewModal')) $('whatsNewModal').hidden = true;
  });
}

async function init() {
  await initTheme();
  const manifest = chrome.runtime.getManifest();
  $('extensionVersion').textContent = `v${manifest.version}`;

  settings = await getSettings();
  gatewayToken = await getGatewayToken();
  // A failed inventory refresh must not abort init: everything below wires the
  // controls, so throwing here leaves the whole side panel inert.
  await refreshModels().catch((error) => {
    renderModelInventory({ source: 'fallback', models: FALLBACK_VIDEO_MODELS });
    setStatus(publicMessage(error.message), 'failed');
  });
  $('aspectRatio').value = settings.aspectRatio;
  renderWorkingMode();
  renderVideoMode();
  renderWorkspace();
  renderHumanPace();
  renderCooldownCard();
  initWhatsNew();

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('workingMode').addEventListener('change', () => {
    changeWorkingMode().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('videoMode').addEventListener('change', () => {
    changeVideoMode().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('reviewStandalone').addEventListener('click', reviewStandalonePrompts);
  $('editStandalone').addEventListener('click', showStandaloneEditor);
  $('queueStandalone').addEventListener('click', confirmStandalone);
  $('standalonePrompt').addEventListener('input', () => {
    if (standalonePrompts.length) showStandaloneEditor();
  });
  $('confirmCancel').addEventListener('click', closeConfirmation);
  $('confirm').addEventListener('click', (event) => {
    if (event.target === $('confirm')) closeConfirmation();
  });
  $('openFlow').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openFlow' }));
  $('gatewayConnect')?.addEventListener('click', () => {
    testGatewayConnection().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('gatewayClaim')?.addEventListener('click', () => {
    claimGatewayNow().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  for (const id of ['gatewayUrl', 'gatewayToken']) {
    $(id)?.addEventListener('change', () => {
      saveGatewaySettings().catch((error) => setStatus(publicMessage(error.message), 'failed'));
    });
  }
  $('useFlow').addEventListener('click', () => {
    useCurrentWorkspace().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('refreshModels').addEventListener('click', () => refreshModels().catch((error) => setStatus(publicMessage(error.message), 'failed')));
  $('newFlow').addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'newFlowProject' });
    if (!result?.ok) {
      setStatus(publicMessage(result?.error || 'Could not create a generation project.'), 'failed');
      return;
    }
    settings = await getSettings();
    renderWorkspace();
    setStatus('New generation workspace created.', 'ok');
  });
  $('pauseQueue').addEventListener('click', async () => {
    const paused = $('pauseQueue').dataset.paused === 'true';
    await chrome.runtime.sendMessage({ type: paused ? 'resumeQueue' : 'pauseQueue' });
    await pollQueue();
  });
  $('retryFailed').addEventListener('click', async () => {
    const state = await chrome.runtime.sendMessage({ type: 'getQueue' });
    for (const item of state?.queue || []) {
      if (item.status === 'failed') {
        await chrome.runtime.sendMessage({ type: 'retryItem', id: item.id });
      }
    }
    await pollQueue();
  });
  $('clearQueue').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearQueue' });
    await pollQueue();
  });

  $('videoModel').addEventListener('change', async () => {
    const model = currentModels.find((entry) => entry.key === $('videoModel').value);
    $('videoDurationSec').value = model?.durationSec ?? '';
    const snapshot = modelSnapshot();
    settings = await saveSettings({
      videoModelKey: snapshot.videoModelKey,
      videoModelLabel: snapshot.videoModelLabel,
      videoModelSource: snapshot.videoModelSource,
      videoDurationSec: snapshot.durationSec,
    });
    renderDurationState();
  });
  $('videoDurationSec').addEventListener('input', renderDurationState);
  $('videoDurationSec').addEventListener('change', async () => {
    settings = await saveSettings({ videoDurationSec: Number($('videoDurationSec').value) });
    renderDurationState();
  });
  $('aspectRatio').addEventListener('change', async () => {
    settings = await saveSettings({ aspectRatio: $('aspectRatio').value });
  });
  $('humanPacePreset').addEventListener('change', () => {
    onPacePreset().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('humanDelayMinSec').addEventListener('change', () => {
    savePace().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('humanDelayMaxSec').addEventListener('change', () => {
    savePace().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('cooldownAutoResume').addEventListener('change', () => {
    saveCooldown({ autoResume: $('cooldownAutoResume').checked }).catch((error) =>
      setStatus(publicMessage(error.message), 'failed')
    );
  });
  $('cooldownPreset').addEventListener('change', () => {
    onCooldownPreset().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('cooldownMinutes').addEventListener('change', () => {
    saveCooldownCustom().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });

  await pollQueue();
  setInterval(pollQueue, 1500);
  setInterval(() => {
    updateElapsed();
    renderCooldownState();
    renderAppliedSettings();
  }, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => setStatus(publicMessage(error.message), 'failed'));
});
