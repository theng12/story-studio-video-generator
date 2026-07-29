import { getSettings, saveSettings } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';

const $ = (id) => document.getElementById(id);
let settings;
let studio;
let projects = [];
let episodes = [];
let scenes = [];

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

function selectedScenes() {
  return [...document.querySelectorAll('.scene input:checked')].map((input) => scenes[Number(input.dataset.index)]);
}

function renderScenes() {
  $('scenes').innerHTML = '';
  scenes.forEach((scene, index) => {
    const row = document.createElement('label');
    row.className = 'scene';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.index = String(index);
    checkbox.checked = !scene.hasClip;
    checkbox.disabled = scene.hasClip;
    checkbox.onchange = updateQueueButton;
    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('strong');
    title.textContent = scene.label;
    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = scene.motionPrompt || 'No motion prompt';
    body.append(title, prompt);
    const badge = document.createElement('span');
    badge.className = `badge ${scene.hasClip ? 'done' : ''}`;
    badge.textContent = scene.hasClip ? 'has clip' : 'missing';
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
  $('project').innerHTML = '';
  for (const project of projects) {
    const option = document.createElement('option');
    option.value = project.slug;
    option.textContent = project.name || project.slug;
    $('project').appendChild(option);
  }
  if (settings.lastProject && projects.some((project) => project.slug === settings.lastProject)) {
    $('project').value = settings.lastProject;
  }
  await loadEpisodes();
}

async function loadEpisodes() {
  const slug = $('project').value;
  if (!slug) return;
  const data = await studio.listEpisodes(slug);
  episodes = (Array.isArray(data) ? data : data.episodes || [])
    .map((episode) => ({
      code: episode.episode_code || episode.code,
      title: episode.title || '',
      hasPlan: Boolean(episode.status?.scene_plan),
    }))
    .filter((episode) => episode.code && episode.hasPlan);
  $('episode').innerHTML = '';
  for (const episode of episodes) {
    const option = document.createElement('option');
    option.value = episode.code;
    option.textContent = `${episode.code}${episode.title ? ` — ${episode.title}` : ''}`;
    $('episode').appendChild(option);
  }
  if (settings.lastEpisode && episodes.some((episode) => episode.code === settings.lastEpisode)) {
    $('episode').value = settings.lastEpisode;
  }
  settings = await saveSettings({ lastProject: slug });
  setStatus(`${episodes.length} scene-plan episode${episodes.length === 1 ? '' : 's'} available.`);
}

async function loadScenes() {
  const slug = $('project').value;
  const code = $('episode').value;
  if (!slug || !code) return;
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
  setStatus(`${scenes.length} approved scene${scenes.length === 1 ? '' : 's'} eligible for video.`);
}

async function useCurrentFlow() {
  setStatus('Reading the current Flow tab…');
  const context = await chrome.runtime.sendMessage({ type: 'flowContext' });
  if (!context?.ok || !context.projectId) {
    throw new Error(context?.signedIn === false ? 'Sign in and open a Flow project first.' : 'Open a Flow project first.');
  }
  settings = await saveSettings({
    flowProjectId: context.projectId,
    flowProjectName: context.projectId,
  });
  renderFlowProject();
  setStatus('Flow project selected.');
}

function renderFlowProject() {
  $('flowProject').textContent = settings.flowProjectName || settings.flowProjectId || 'None selected';
}

function confirmQueue() {
  const selected = selectedScenes();
  if (!selected.length) return;
  if (!settings.flowProjectId) {
    setStatus('Select a Flow project first.', 'failed');
    return;
  }
  $('confirmTitle').textContent = 'Generate paid scene videos?';
  $('confirmBody').textContent =
    `${selected.length} clip${selected.length === 1 ? '' : 's'} will be submitted sequentially to ` +
    `${settings.videoModel}. Flow/Veo credits will be spent.`;
  $('confirm').classList.remove('hidden');
  $('confirmOk').onclick = async () => {
    $('confirm').classList.add('hidden');
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
    setStatus(`Queued ${response.added}${response.skipped ? `; skipped ${response.skipped}` : ''}.`);
    pollQueue();
  };
}

function showAmbiguousRetry(item) {
  $('confirmTitle').textContent = 'Resubmit an ambiguous paid request?';
  $('confirmBody').textContent =
    'Flow may already have accepted this request. Inspect the Flow project first. Resubmitting can spend credits twice.';
  $('confirmOk').textContent = 'Resubmit and accept risk';
  $('confirm').classList.remove('hidden');
  $('confirmOk').onclick = async () => {
    $('confirm').classList.add('hidden');
    $('confirmOk').textContent = 'Spend credits & queue';
    await chrome.runtime.sendMessage({
      type: 'retryItem',
      id: item.id,
      acceptAmbiguousRisk: true,
    });
    pollQueue();
  };
}

async function pollQueue() {
  const [state, stored] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'getQueue' }),
    chrome.storage.local.get('lastVideoStatus'),
  ]);
  const queue = state?.queue || [];
  $('pauseQueue').textContent = state?.paused ? 'Resume' : 'Pause';
  $('pauseQueue').dataset.paused = String(Boolean(state?.paused));
  const live = stored.lastVideoStatus;
  if (live) setStatus(live.text, live.kind);
  $('queue').innerHTML = '';
  for (const item of queue) {
    const row = document.createElement('div');
    row.className = 'qitem';
    const body = document.createElement('div');
    body.className = 'body';
    const title = document.createElement('strong');
    title.textContent = item.label + (item.savedAs ? ` → ${item.savedAs}` : '');
    const detail = document.createElement('div');
    detail.className = 'prompt';
    detail.textContent = item.error || `${item.videoModel} · ${item.phase}`;
    body.append(title, detail);
    const badge = document.createElement('span');
    badge.className = `badge ${item.status}`;
    badge.textContent = item.status;
    row.append(body, badge);
    if (['failed', 'ambiguous'].includes(item.status)) {
      const retry = document.createElement('button');
      retry.className = 'secondary';
      retry.textContent = 'Retry';
      retry.onclick = async () => {
        if (item.status === 'ambiguous') return showAmbiguousRetry(item);
        await chrome.runtime.sendMessage({ type: 'retryItem', id: item.id });
        pollQueue();
      };
      row.appendChild(retry);
    }
    $('queue').appendChild(row);
  }
}

async function init() {
  const manifest = chrome.runtime.getManifest();
  $('version').textContent = `v${manifest.version}`;
  settings = await getSettings();
  studio = new StudioClient(settings.studioBaseUrl);
  $('videoModel').value = settings.videoModel;
  $('videoSource').value = settings.videoSource;
  $('aspectRatio').value = settings.aspectRatio;
  $('saveTarget').value = settings.saveTarget;
  renderFlowProject();

  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('project').onchange = loadEpisodes;
  $('loadScenes').onclick = () => loadScenes().catch((error) => setStatus(error.message, 'failed'));
  $('selectMissing').onclick = () => {
    document.querySelectorAll('.scene input:not(:disabled)').forEach((input) => {
      input.checked = true;
    });
    updateQueueButton();
  };
  $('queueSelected').onclick = confirmQueue;
  $('confirmCancel').onclick = () => {
    $('confirm').classList.add('hidden');
    $('confirmOk').textContent = 'Spend credits & queue';
  };
  $('openFlow').onclick = () => chrome.runtime.sendMessage({ type: 'openFlow' });
  $('useFlow').onclick = () => useCurrentFlow().catch((error) => setStatus(error.message, 'failed'));
  $('newFlow').onclick = async () => {
    const result = await chrome.runtime.sendMessage({ type: 'newFlowProject' });
    if (!result?.ok) return setStatus(result?.error || 'Could not create Flow project.', 'failed');
    settings = await getSettings();
    renderFlowProject();
  };
  $('pauseQueue').onclick = async () => {
    const paused = $('pauseQueue').dataset.paused === 'true';
    await chrome.runtime.sendMessage({ type: paused ? 'resumeQueue' : 'pauseQueue' });
    pollQueue();
  };
  $('clearQueue').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearQueue' });
    pollQueue();
  };
  for (const field of ['videoModel', 'videoSource', 'aspectRatio', 'saveTarget']) {
    $(field).onchange = async () => {
      settings = await saveSettings({ [field]: $(field).value });
    };
  }

  await loadProjects().catch((error) => setStatus(`Story Studio: ${error.message}`, 'failed'));
  await pollQueue();
  setInterval(pollQueue, 1500);
}

init();
