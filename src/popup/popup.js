import { getSettings, saveSettings } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
let settings;
let studio;
let projects = [];
let episodes = [];
let scenes = [];
let elapsedStartedAt = 0;

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

async function loadEpisodes() {
  const slug = $('project').value;
  if (!slug) return;
  setStatus('Loading episodes…');
  const data = await studio.listEpisodes(slug);
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

  setStatus('Loading eligible video scenes…');
  const data = await studio.sceneReview(slug, code);
  const minimumDuration = Number(data?.animate_min_seconds) || 0;
  scenes = (data?.scenes || [])
    .filter(
      (scene) =>
        scene.approved === true &&
        scene.image_filename != null &&
        String(scene.motion_prompt || '').trim() &&
        Number(scene.end_sec) - Number(scene.start_sec) >= minimumDuration
    )
    .map((scene) => ({
      id: scene.id,
      sceneIndex: scene.scene_index,
      label: `Scene ${scene.scene_index}`,
      motionPrompt: scene.motion_prompt,
      imagePrompt: scene.visual_prompt || '',
      durationSec: Math.max(0, Number(scene.end_sec) - Number(scene.start_sec)),
      hasClip: Boolean(scene.clip_exists && !scene.clip_stale),
    }));

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

  showConfirmation({
    title: 'Generate scene videos?',
    body:
      `${selected.length} video${selected.length === 1 ? '' : 's'} will run sequentially. ` +
      'Each request may use account credits.',
    confirmLabel: 'Use credits & queue',
    onConfirm: async () => {
      const project = projects.find((candidate) => candidate.slug === $('project').value);
      const episode = episodes.find((candidate) => candidate.code === $('episode').value);
      const response = await chrome.runtime.sendMessage({
        type: 'enqueueScenes',
        payload: {
          slug: $('project').value,
          projectName: project?.name || $('project').value,
          episodeCode: $('episode').value,
          episodeTitle: episode?.title || '',
          projectId: settings.flowProjectId,
          target: settings.saveTarget,
          videoModel: settings.videoModel,
          videoSource: settings.videoSource,
          aspectRatio: settings.aspectRatio,
          scenes: selected,
        },
      });
      if (!response?.ok) throw new Error(response?.error || 'Could not queue videos.');
      setStatus(`Queued ${response.added}${response.skipped ? `; skipped ${response.skipped}` : ''}.`, 'ok');
      await pollQueue();
    },
  });
}

function showAmbiguousRetry(item) {
  showConfirmation({
    title: 'Resubmit a request that needs review?',
    body:
      'The previous request may already have been accepted. Inspect the generation workspace first. ' +
      'Resubmitting may use credits twice.',
    confirmLabel: 'Resubmit and accept risk',
    onConfirm: async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'retryItem',
        id: item.id,
        acceptAmbiguousRisk: true,
      });
      if (!response?.ok) throw new Error(response?.error || 'Could not resubmit this video.');
      setStatus('Video resubmitted with duplicate-credit risk accepted.', 'ok');
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
  const waiting = left > 0 && Number(live?.countdownUntil) > Date.now();

  let stateClass = 'idle';
  let stateText = 'Ready';
  if (counts.ambiguous) {
    stateClass = 'review';
    stateText = 'Needs review';
  } else if (running) {
    stateClass = 'running';
    stateText = 'Generating';
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
  else if (waiting) panelClasses.push('is-waiting');
  else if (counts.ambiguous) panelClasses.push('has-review');
  else if (total && !left && counts.failed) panelClasses.push('has-failure');
  else if (total && !left) panelClasses.push('is-complete');
  $('activityPanel').className = panelClasses.join(' ');

  if (running) {
    $('activeJob').textContent = running.label;
    $('activeJobMeta').textContent =
      `${phaseLabel(running.phase)} · ${running.target === 'project' ? 'Story Studio' : 'Downloads'}`;
  } else if (counts.ambiguous) {
    $('activeJob').textContent = 'A video needs review';
    $('activeJobMeta').textContent = 'The request may already exist. Inspect the workspace before resubmitting.';
  } else if (state?.paused && left) {
    $('activeJob').textContent = 'Batch paused';
    $('activeJobMeta').textContent = `${left} video${left === 1 ? '' : 's'} waiting.`;
  } else if (nextPending) {
    $('activeJob').textContent = nextPending.label;
    $('activeJobMeta').textContent = waiting ? 'Waiting for the configured pace.' : 'Waiting to start.';
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

  $('queueControls').hidden = !total;
  $('pauseQueue').hidden = !left;
  $('pauseQueue').textContent = state?.paused ? 'Resume' : 'Pause';
  $('pauseQueue').dataset.paused = String(Boolean(state?.paused));
  $('retryFailed').hidden = counts.failed === 0;
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
}

async function pollQueue() {
  try {
    const [state, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'getQueue' }),
      chrome.storage.local.get('lastVideoStatus'),
    ]);
    renderQueue(state?.queue || [], state, stored.lastVideoStatus);
  } catch (error) {
    setStatus(`Queue status unavailable: ${publicMessage(error.message)}`, 'failed');
  }
}

function renderHumanPace() {
  $('humanDelayMinSec').value = settings.humanDelayMinSec;
  $('humanDelayMaxSec').value = settings.humanDelayMaxSec;
  const min = Number(settings.humanDelayMinSec) || 0;
  const max = Number(settings.humanDelayMaxSec) || 0;
  $('humanPaceState').textContent = max ? `${min}–${max}s` : 'Off';
  $('humanPaceState').className = `pace-state${max ? '' : ' off'}`;
}

async function savePace() {
  settings = await saveSettings({
    humanDelayMinSec: $('humanDelayMinSec').value,
    humanDelayMaxSec: $('humanDelayMaxSec').value,
  });
  renderHumanPace();
  setStatus('Human pace saved.', 'ok');
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
  studio = new StudioClient(settings.studioBaseUrl);
  $('videoModel').value = settings.videoModel;
  $('videoSource').value = settings.videoSource;
  $('aspectRatio').value = settings.aspectRatio;
  $('saveTarget').value = settings.saveTarget;
  renderWorkspace();
  renderHumanPace();
  initWhatsNew();

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
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
  $('confirmCancel').addEventListener('click', closeConfirmation);
  $('confirm').addEventListener('click', (event) => {
    if (event.target === $('confirm')) closeConfirmation();
  });
  $('openFlow').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openFlow' }));
  $('useFlow').addEventListener('click', () => {
    useCurrentWorkspace().catch((error) => setStatus(publicMessage(error.message), 'failed'));
  });
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

  for (const field of ['videoModel', 'videoSource', 'aspectRatio', 'saveTarget']) {
    $(field).addEventListener('change', async () => {
      settings = await saveSettings({ [field]: $(field).value });
    });
  }
  $('humanDelayMinSec').addEventListener('change', savePace);
  $('humanDelayMaxSec').addEventListener('change', savePace);

  await loadProjects().catch((error) => setStatus(`Story Studio: ${publicMessage(error.message)}`, 'failed'));
  await pollQueue();
  setInterval(pollQueue, 1500);
  setInterval(updateElapsed, 1000);
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => setStatus(publicMessage(error.message), 'failed'));
});
