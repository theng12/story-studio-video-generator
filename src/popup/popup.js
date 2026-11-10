import { getSettings, saveSettings, getGatewayToken, saveGatewayToken } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme } from '../lib/theme.js';
import { eligibleVideoScenes } from '../lib/video-rules.js';
import { FALLBACK_VIDEO_MODELS, defaultVideoModel, modelsForMode } from '../lib/video-models.js';
import { ambiguityRetryCopy, isCurrentLoad, sceneEnqueueContext } from '../lib/video-panel.js';

const $ = (id) => document.getElementById(id);
let settings;
let gatewayToken = '';
let studio;
let projects = [];
let episodes = [];
let scenes = [];
let elapsedStartedAt = 0;
let latestLiveStatus = null;
let activeCooldownUntil = 0;
let modelInventorySource = 'fallback';
let storyLoadToken = 0;

function renderModelInventory(inventory) {
  const mode = settings.videoMode === 'text' ? 'text' : 'image';
  const models = modelsForMode(inventory?.models, mode);
  $('videoModel').replaceChildren(...models.map((model) => new Option(model.label, model.key)));
  const selected = models.find((model) => model.key === settings.videoModelKey) || defaultVideoModel(mode);
  $('videoModel').value = selected.key;
  modelInventorySource = inventory?.source === 'live' ? 'live' : 'fallback';
  $('modelInventoryState').textContent = modelInventorySource === 'live' ? 'Live from this Flow workspace' : 'Tested fallback catalog';
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

function selectedScenes() {
  return [...document.querySelectorAll('.scene input:checked')]
    .map((input) => scenes[Number(input.dataset.index)])
    .filter(Boolean);
}

function renderScenes() {
  $('scenes').replaceChildren();
  $('scenesSummary').textContent = `${scenes.length} eligible scene${scenes.length === 1 ? '' : 's'}`;

  if (!scenes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No eligible scenes found.';
    $('scenes').appendChild(empty);
  }

  scenes.forEach((scene, index) => {
    const row = document.createElement('label');
    row.className = 'scene';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.index = String(index);
    checkbox.checked = !scene.hasClip;
    checkbox.disabled = scene.hasClip;
    checkbox.addEventListener('change', updateQueueButton);

    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('div');
    title.className = 'scene-title';
    title.textContent = scene.label;
    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = scene.motionPrompt || 'No motion prompt';
    prompt.title = scene.motionPrompt || '';
    body.append(title, prompt);

    const badge = document.createElement('span');
    badge.className = `badge ${scene.hasClip ? 'done' : 'missing'}`;
    badge.textContent = scene.hasClip ? 'Has video' : 'Missing';

    row.append(checkbox, body, badge);
    $('scenes').appendChild(row);
  });

  updateQueueButton();
}

function updateQueueButton() {
  const count = selectedScenes().length;
  $('queueSelected').disabled = count === 0;
  $('queueSelected').textContent = count ? `Queue selected (${count})` : 'Queue selected';
}

function isStandaloneMode() {
  return settings?.mode === 'standalone';
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
  const standalone = isStandaloneMode();
  const gateway = isGatewayMode();
  $('workingMode').value = gateway ? 'gateway' : standalone ? 'standalone' : 'studio';
  $('companionPane').hidden = standalone || gateway;
  $('standalonePane').hidden = !standalone || gateway;
  $('gatewayPane').hidden = !gateway;
  $('studioBatchActions').hidden = standalone || gateway;
  const providerPanel = document.querySelector('.provider-settings-panel');
  const workspacePanel = document.querySelector('.workspace-panel');
  if (providerPanel) providerPanel.hidden = gateway;
  if (workspacePanel) workspacePanel.hidden = gateway;
  if (gateway) {
    renderGatewaySettings();
  } else {
    $('videoSource').disabled = standalone;
    $('videoSource').value = standalone ? 'generate' : settings.videoSource;
  }
}

function renderVideoMode() {
  const text = settings.videoMode === 'text';
  $('videoMode').value = text ? 'text' : 'image';
  $('videoSource').disabled = text || isStandaloneMode() || isGatewayMode();
  if (!text) $('videoSource').value = isStandaloneMode() ? 'generate' : settings.videoSource;
}

async function changeVideoMode() {
  const videoMode = $('videoMode').value === 'text' ? 'text' : 'image';
  const model = defaultVideoModel(videoMode);
  settings = await saveSettings({
    videoMode,
    videoModelKey: model.key,
    videoModelLabel: model.label,
    videoModelSource: 'fallback',
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
  const mode = ['studio', 'standalone', 'gateway'].includes($('workingMode').value)
    ? $('workingMode').value
    : 'studio';
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
  if (isStandaloneMode()) {
    setStatus('Standalone mode uses a local prompt and Downloads.', 'ok');
    return;
  }
  await loadProjects();
}

async function loadProjects() {
  setStatus('Loading Story Studio projects…');
  const data = await studio.listProjects();
  projects = Array.isArray(data) ? data : data.projects || [];
  $('project').replaceChildren();

  for (const project of projects) {
    const option = document.createElement('option');
    option.value = project.slug;
    option.textContent = project.name || project.slug;
    $('project').appendChild(option);
  }

  if (settings.lastProject && projects.some((project) => project.slug === settings.lastProject)) {
    $('project').value = settings.lastProject;
  }

  if (!projects.length) {
    episodes = [];
    scenes = [];
    $('episode').replaceChildren();
    renderScenes();
    setStatus('No Story Studio projects found.');
    return;
  }

  await loadEpisodes();
}

async function testStudioConnection() {
  const button = $('testConn');
  const output = $('connStatus');
  const setConnectionStatus = (text, color) => {
    output.textContent = text;
    output.style.color = color;
  };
  const testedAt = () => {
    const now = new Date();
    return `tested ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  };
  const result = (state, detail, color) => {
    setConnectionStatus(`${state} · ${testedAt()}${detail ? ` — ${detail}` : ''}`, color);
    $('openStudioSettings').classList.toggle('hidden', state !== 'Failed');
  };

  button.disabled = true;
  $('openStudioSettings').classList.add('hidden');
  setConnectionStatus('Testing…', 'var(--muted)');
  try {
    const url = settings.studioBaseUrl || '';
    const local = /localhost|127\.0\.0\.1|\[::1\]/.test(url);
    if (!local) {
      let pattern = null;
      try {
        const parsed = new URL(url);
        pattern = `${parsed.protocol}//${parsed.hostname}/*`;
      } catch {
        // The request below reports an invalid configured URL clearly.
      }
      const granted = pattern
        ? await chrome.permissions.contains({ origins: [pattern] }).catch(() => false)
        : false;
      if (!granted) {
        result('Failed', 'update extension site access for this server.', 'var(--danger)');
        return;
      }
    }
    const data = await studio.listProjects();
    const count = Array.isArray(data) ? data.length : (data?.projects || []).length;
    result('Connected', `${count} project${count === 1 ? '' : 's'}.`, 'var(--ok)');
  } catch (error) {
    const local = /localhost|127\.0\.0\.1|\[::1\]/.test(settings.studioBaseUrl || '');
    result(
      'Failed',
      `${publicMessage(error.message)}. ${local ? 'Is Story Studio running?' : 'Check the server, site access, and sign-in.'}`,
      'var(--danger)'
    );
  } finally {
    button.disabled = false;
  }
}

async function loadEpisodes() {
  const slug = $('project').value;
  if (!slug) return;
  const token = ++storyLoadToken;
  setStatus('Loading episodes…');
  const data = await studio.listEpisodes(slug);
  if (!isCurrentLoad(token, storyLoadToken, { slug, episodeCode: '' }, { slug: $('project').value, episodeCode: '' })) return;
  episodes = (Array.isArray(data) ? data : data.episodes || [])
    .map((episode) => ({
      code: episode.episode_code || episode.code,
      title: episode.title || '',
      hasPlan: Boolean(episode.status?.scene_plan),
    }))
    .filter((episode) => episode.code && episode.hasPlan);
  $('episode').replaceChildren();

  for (const episode of episodes) {
    const option = document.createElement('option');
    option.value = episode.code;
    option.textContent = `${episode.code}${episode.title ? ` — ${episode.title}` : ''}`;
    $('episode').appendChild(option);
  }

  if (settings.lastEpisode && episodes.some((episode) => episode.code === settings.lastEpisode)) {
    $('episode').value = settings.lastEpisode;
  }

  scenes = [];
  renderScenes();
  settings = await saveSettings({ lastProject: slug });
  setStatus(`${episodes.length} planned episode${episodes.length === 1 ? '' : 's'} available.`);
}

async function loadScenes() {
  const slug = $('project').value;
  const code = $('episode').value;
  if (!slug || !code) {
    setStatus('Choose a project and episode first.', 'failed');
    return;
  }

  const token = ++storyLoadToken;
  setStatus('Loading eligible video scenes…');
  const data = await studio.sceneReview(slug, code);
  if (!isCurrentLoad(token, storyLoadToken, { slug, episodeCode: code }, { slug: $('project').value, episodeCode: $('episode').value })) return;
  scenes = eligibleVideoScenes(data);

  settings = await saveSettings({ lastProject: slug, lastEpisode: code });
  renderScenes();
  setStatus(`${scenes.length} approved scene${scenes.length === 1 ? '' : 's'} ready to review.`);
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

function confirmQueue() {
  const selected = selectedScenes();
  if (!selected.length) return;
  if (!settings.flowProjectId) {
    setStatus('Select a generation workspace first.', 'failed');
    return;
  }

  const project = projects.find((candidate) => candidate.slug === $('project').value);
  const episode = episodes.find((candidate) => candidate.code === $('episode').value);
  if (!project || !episode) return setStatus('Choose a project and episode first.', 'failed');
  const context = sceneEnqueueContext(project, episode, selected);
  showConfirmation({
    title: 'Generate scene videos?',
    body:
      `${selected.length} video${selected.length === 1 ? '' : 's'} will run sequentially. ` +
      'Each request may use account credits.',
    confirmLabel: 'Use credits & queue',
    onConfirm: async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'enqueueScenes',
        payload: {
          ...context,
          projectId: settings.flowProjectId,
          ...modelSnapshot(),
          videoMode: settings.videoMode,
          videoSource: settings.videoSource,
          aspectRatio: settings.aspectRatio,
        },
      });
      if (!response?.ok) throw new Error(response?.error || 'Could not queue videos.');
      setStatus(`Queued ${response.added}${response.skipped ? `; skipped ${response.skipped}` : ''}.`, 'ok');
      await pollQueue();
    },
  });
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
    ingesting: 'Saving to Story Studio',
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
      `${phaseLabel(running.phase)} · Story Studio`;
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
    $('activeJobMeta').textContent = 'Choose scenes, then queue them.';
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
    label.textContent = item.label + (item.savedAs ? ` → ${item.savedAs}` : '');
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
  balanced: { min: 5, max: 12 },
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
  studio = new StudioClient(settings.studioBaseUrl);
  // A failed inventory refresh must not abort init: everything below wires the
  // controls, so throwing here leaves the whole side panel inert.
  await refreshModels().catch((error) => {
    renderModelInventory({ source: 'fallback', models: FALLBACK_VIDEO_MODELS });
    setStatus(publicMessage(error.message), 'failed');
  });
  $('videoSource').value = settings.videoSource;
  $('aspectRatio').value = settings.aspectRatio;
  renderWorkingMode();
  renderVideoMode();
  renderWorkspace();
  renderHumanPace();
  renderCooldownCard();
  initWhatsNew();

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openStudioSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('testConn').addEventListener('click', testStudioConnection);
  $('workingMode').addEventListener('change', () => {
    changeWorkingMode().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('videoMode').addEventListener('change', () => {
    changeVideoMode().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('project').addEventListener('change', () => {
    loadEpisodes().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('loadScenes').addEventListener('click', () => {
    loadScenes().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
  $('selectMissing').addEventListener('click', () => {
    document.querySelectorAll('.scene input:not(:disabled)').forEach((input) => {
      input.checked = true;
    });
    updateQueueButton();
  });
  $('queueSelected').addEventListener('click', confirmQueue);
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
    const snapshot = modelSnapshot();
    settings = await saveSettings(snapshot);
  });
  for (const field of ['videoSource', 'aspectRatio']) {
    $(field).addEventListener('change', async () => {
      settings = await saveSettings({ [field]: $(field).value });
    });
  }
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

  if (!isStandaloneMode() && !isGatewayMode()) {
    await loadProjects().catch((error) => setStatus(`Story Studio: ${publicMessage(error.message)}`, 'failed'));
  }
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
