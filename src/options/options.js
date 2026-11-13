import {
  DEFAULTS,
  getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
  getGatewayToken,
  saveGatewayToken,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme, setTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'theme',
  'mode',
  'studioBaseUrl',
  'gatewayUrl',
  'gatewayWorkerId',
];

// Advanced fallback ids; discovery on the live page wins, these only fill a miss.
const RPC_FIELDS = {
  rpcIdGenerateImage: 'generateImage', rpcIdUploadImage: 'uploadImage',
  rpcIdTextToVideo: 'textToVideo', rpcIdImageToVideo: 'imageToVideo',
  rpcIdCheckVideo: 'checkVideo', rpcIdGetMedia: 'getMedia', rpcIdCredits: 'credits',
};

let autoSaveTimer = null;
let savedTimer = null;

function showStatus(message, kind = '') {
  const status = $('status');
  status.textContent = message;
  status.className = `muted small ${kind}`.trim();
  clearTimeout(savedTimer);
  if (kind === 'ok') {
    savedTimer = setTimeout(() => {
      status.textContent = '';
    }, 2500);
  }
}

async function save() {
  try {
    const patch = Object.fromEntries(
      FIELDS.map((field) => {
        const element = $(field);
        return [field, element.type === 'checkbox' ? element.checked : element.value.trim()];
      })
    );
    const rpcIds = { ...(await getSettings()).rpcIds };
    for (const [id, name] of Object.entries(RPC_FIELDS)) {
      const value = ($(id)?.value || '').trim();
      if (value) rpcIds[name] = value;
    }
    patch.rpcIds = rpcIds;
    await Promise.all([
      saveSettings(patch),
      saveCredentials({
        username: $('studioUsername').value.trim(),
        password: $('studioPassword').value,
      }),
      saveGatewayToken($('gatewayToken').value),
    ]);
    await chrome.runtime.sendMessage({ type: 'gatewayModeChanged' }).catch(() => {});
    showStatus('✓ Saved', 'ok');
  } catch (error) {
    showStatus(`Couldn’t save: ${error.message}`, 'failed');
  }
}

function refreshMode() {
  const gateway = $('mode').value === 'gateway';
  $('studioSection').hidden = gateway;
  $('gatewaySection').hidden = !gateway;
}

// Flow lives at a fixed address, and its origin permission is already declared.
// A moved Flow deployment is a code change, not a settings field.
async function requestFlowAccess() {
  const origins = ['https://flow.google.com/*'];
  if (await chrome.permissions.contains({ origins }).catch(() => false)) return;
  await chrome.permissions.request({ origins }).catch(() => {});
}

function scheduleSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(save, 400);
}

function originPattern(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

async function refreshGrantStatus() {
  const status = $('grantStatus');
  const button = $('grantAccess');
  const url = $('studioBaseUrl').value.trim();
  const pattern = originPattern(url);
  if (!pattern) {
    status.textContent = '';
    button.disabled = false;
    return;
  }
  if (isLocalUrl(url)) {
    status.textContent = 'Local — no site access grant needed.';
    status.style.color = 'var(--muted)';
    button.disabled = true;
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  status.textContent = granted ? '✓ Site access granted.' : 'Site access not granted yet.';
  status.style.color = granted ? 'var(--ok)' : 'var(--warning)';
  button.disabled = false;
}

async function grantAccess() {
  const status = $('grantStatus');
  const url = $('studioBaseUrl').value.trim();
  const pattern = originPattern(url);
  if (!pattern) {
    status.textContent = 'Enter a valid Server URL first.';
    status.style.color = 'var(--danger)';
    return;
  }
  if (isLocalUrl(url)) return refreshGrantStatus();
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    status.textContent = granted ? '✓ Site access granted.' : 'Site access request was declined.';
    status.style.color = granted ? 'var(--ok)' : 'var(--danger)';
  } catch (error) {
    status.textContent = `Couldn’t grant site access: ${error.message}`;
    status.style.color = 'var(--danger)';
  }
}

async function testConnection() {
  const status = $('testStatus');
  const url = $('studioBaseUrl').value.trim();
  status.textContent = 'Testing connection…';
  status.style.color = 'var(--muted)';
  if (!url) {
    status.textContent = 'Enter a Server URL first.';
    status.style.color = 'var(--danger)';
    return;
  }
  if (!isLocalUrl(url)) {
    const pattern = originPattern(url);
    const granted = pattern && await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
    if (!granted) {
      status.textContent = 'Grant site access first, then test again.';
      status.style.color = 'var(--warning)';
      return;
    }
  }
  try {
    const projects = await new StudioClient(url).listProjects();
    const count = Array.isArray(projects) ? projects.length : (projects?.projects || []).length;
    status.textContent = `✓ Connected — ${count} project${count === 1 ? '' : 's'} found.`;
    status.style.color = 'var(--ok)';
  } catch (error) {
    status.textContent = `Couldn’t connect: ${error.message}. ${isLocalUrl(url) ? 'Is Story Studio running?' : 'Check the server, site access, and sign-in.'}`;
    status.style.color = 'var(--danger)';
  }
}

async function signIn() {
  const status = $('loginStatus');
  status.textContent = 'Signing in…';
  status.style.color = 'var(--muted)';
  try {
    const credentials = {
      username: $('studioUsername').value.trim(),
      password: $('studioPassword').value,
    };
    await saveCredentials(credentials);
    await new StudioClient($('studioBaseUrl').value.trim()).login(
      credentials.username,
      credentials.password
    );
    status.textContent = '✓ Signed in — this browser session is ready.';
    status.style.color = 'var(--ok)';
  } catch (error) {
    status.textContent = `Sign-in failed: ${error.message}`;
    status.style.color = 'var(--danger)';
  }
}

async function load() {
  await initTheme();
  const [settings, credentials, gatewayToken] = await Promise.all([
    getSettings(),
    getCredentials(),
    getGatewayToken(),
  ]);
  for (const field of FIELDS) {
    const element = $(field);
    if (element.type === 'checkbox') element.checked = settings[field] === true;
    else element.value = settings[field] ?? DEFAULTS[field] ?? '';
  }
  for (const [id, name] of Object.entries(RPC_FIELDS)) {
    if ($(id)) $(id).value = settings.rpcIds?.[name] || '';
  }
  $('studioUsername').value = credentials.username || '';
  $('studioPassword').value = credentials.password || '';
  $('gatewayToken').value = gatewayToken || '';

  $('theme').addEventListener('change', () => setTheme($('theme').value));
  $('save').addEventListener('click', save);
  $('login').addEventListener('click', signIn);
  $('grantAccess').addEventListener('click', grantAccess);
  $('testConnection').addEventListener('click', testConnection);
  $('studioBaseUrl').addEventListener('input', refreshGrantStatus);
  $('mode').addEventListener('change', () => {
    refreshMode();
    if ($('mode').value !== 'gateway') requestFlowAccess();
  });
  refreshGrantStatus();
  refreshMode();

  for (const id of [...FIELDS, 'studioUsername', 'studioPassword']) {
    const element = $(id);
    element.addEventListener(element.tagName === 'SELECT' ? 'change' : 'input', scheduleSave);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load().catch((error) => showStatus(error.message, 'failed'));
});
