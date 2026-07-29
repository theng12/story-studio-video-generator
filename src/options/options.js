import {
  DEFAULTS,
  getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme, setTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'theme',
  'studioBaseUrl',
];

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
      FIELDS.map((field) => [field, typeof $(field).value === 'string' ? $(field).value.trim() : $(field).value])
    );
    await Promise.all([
      saveSettings(patch),
      saveCredentials({
        username: $('studioUsername').value.trim(),
        password: $('studioPassword').value,
      }),
    ]);
    showStatus('✓ Saved', 'ok');
  } catch (error) {
    showStatus(`Couldn’t save: ${error.message}`, 'failed');
  }
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
    showStatus('✓ Signed in', 'ok');
  } catch (error) {
    showStatus(`Sign-in failed: ${error.message}`, 'failed');
  }
}

async function load() {
  await initTheme();
  const [settings, credentials] = await Promise.all([getSettings(), getCredentials()]);
  for (const field of FIELDS) {
    $(field).value = settings[field] ?? DEFAULTS[field] ?? '';
  }
  $('studioUsername').value = credentials.username || '';
  $('studioPassword').value = credentials.password || '';

  $('theme').addEventListener('change', () => setTheme($('theme').value));
  $('save').addEventListener('click', save);
  $('login').addEventListener('click', signIn);
  $('grantAccess').addEventListener('click', grantAccess);
  $('testConnection').addEventListener('click', testConnection);
  $('studioBaseUrl').addEventListener('input', refreshGrantStatus);
  refreshGrantStatus();

  for (const id of [...FIELDS, 'studioUsername', 'studioPassword']) {
    const element = $(id);
    element.addEventListener(element.tagName === 'SELECT' ? 'change' : 'input', scheduleSave);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load().catch((error) => showStatus(error.message, 'failed'));
});
