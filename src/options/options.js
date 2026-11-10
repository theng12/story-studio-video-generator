import {
  DEFAULTS,
  getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
  getFleetCredentials,
  saveFleetCredentials,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme, setTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'theme',
  'studioBaseUrl',
  'flowWorkspaceUrl',
  'providerAccountProfileId',
  'humanDelayMinSec',
  'humanDelayMaxSec',
  'fleetEnabled',
  'fleetHubUrl',
  'fleetMachineName',
  'fleetTelemetryConsent',
  'fleetQueueControlConsent',
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
      FIELDS.map((field) => {
        const element = $(field);
        return [field, element.type === 'checkbox' ? element.checked : element.value.trim()];
      })
    );
    await Promise.all([
      saveSettings(patch),
      saveCredentials({
        username: $('studioUsername').value.trim(),
        password: $('studioPassword').value,
      }),
      saveFleetCredentials({ pairingSecret: $('fleetPairingSecret').value }),
    ]);
    chrome.runtime.sendMessage({ type: 'fleetSettingsChanged' }).catch(() => {});
    showStatus('✓ Saved', 'ok');
  } catch (error) {
    showStatus(`Couldn’t save: ${error.message}`, 'failed');
  }
}

async function refreshFleetGrantStatus() {
  const status = $('fleetGrantStatus');
  const button = $('fleetGrantAccess');
  const url = $('fleetHubUrl').value.trim();
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

async function grantFleetAccess() {
  const status = $('fleetGrantStatus');
  const pattern = originPattern($('fleetHubUrl').value.trim());
  if (!pattern) {
    status.textContent = 'Enter a valid Fleet Hub URL first.';
    status.style.color = 'var(--danger)';
    return;
  }
  if (isLocalUrl($('fleetHubUrl').value.trim())) return refreshFleetGrantStatus();
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    status.textContent = granted ? '✓ Site access granted.' : 'Site access request was declined.';
    status.style.color = granted ? 'var(--ok)' : 'var(--danger)';
  } catch (error) {
    status.textContent = `Couldn’t grant site access: ${error.message}`;
    status.style.color = 'var(--danger)';
  }
}

async function testFleetConnection() {
  const status = $('fleetTestStatus');
  status.textContent = 'Testing signed Fleet Hub connection…';
  status.style.color = 'var(--muted)';
  await save();
  try {
    const result = await chrome.runtime.sendMessage({ type: 'fleetTest' });
    if (!result?.ok) throw new Error(result?.skipped || result?.error || 'Fleet Hub test failed.');
    status.textContent = '✓ Fleet Hub authenticated. No queue command was run.';
    status.style.color = 'var(--ok)';
    await renderFleetHealth();
  } catch (error) {
    status.textContent = `Couldn’t connect: ${error.message}`;
    status.style.color = 'var(--danger)';
  }
}

function generateFleetSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  $('fleetPairingSecret').value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  scheduleSave();
}

async function renderFleetHealth() {
  const health = (await chrome.storage.local.get('lastVideoFleetStatus')).lastVideoFleetStatus;
  const target = $('fleetHealthStatus');
  if (!health?.timestamp) {
    target.textContent = 'Fleet health: not connected yet.';
    target.style.color = 'var(--muted)';
    return;
  }
  const when = new Date(health.timestamp).toLocaleString();
  if (health.ok) {
    target.textContent = `Fleet health: authenticated ${when}.`;
    target.style.color = 'var(--ok)';
  } else {
    target.textContent = `Fleet health: ${health.error || 'connection failed'} (${when}).`;
    target.style.color = 'var(--danger)';
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

async function refreshFlowGrant() {
  const status = $('flowGrantStatus');
  const url = $('flowWorkspaceUrl').value.trim();
  const pattern = originPattern(url);
  if (!pattern) {
    status.textContent = 'Enter a full https:// address.';
    status.style.color = 'var(--danger)';
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  status.textContent = granted ? '✓ Site access granted.' : 'Site access not granted yet.';
  status.style.color = granted ? 'var(--ok)' : 'var(--warning)';
}

async function grantFlow() {
  const status = $('flowGrantStatus');
  const pattern = originPattern($('flowWorkspaceUrl').value.trim());
  if (!pattern) return refreshFlowGrant();
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
  const [settings, credentials, fleetCredentials] = await Promise.all([
    getSettings(),
    getCredentials(),
    getFleetCredentials(),
  ]);
  for (const field of FIELDS) {
    const element = $(field);
    if (element.type === 'checkbox') element.checked = settings[field] === true;
    else element.value = settings[field] ?? DEFAULTS[field] ?? '';
  }
  $('studioUsername').value = credentials.username || '';
  $('studioPassword').value = credentials.password || '';
  $('fleetPairingSecret').value = fleetCredentials.pairingSecret || '';

  $('theme').addEventListener('change', () => setTheme($('theme').value));
  $('save').addEventListener('click', save);
  $('login').addEventListener('click', signIn);
  $('grantAccess').addEventListener('click', grantAccess);
  $('testConnection').addEventListener('click', testConnection);
  $('fleetGrantAccess').addEventListener('click', grantFleetAccess);
  $('fleetTestConnection').addEventListener('click', testFleetConnection);
  $('generateFleetSecret').addEventListener('click', generateFleetSecret);
  $('studioBaseUrl').addEventListener('input', refreshGrantStatus);
  $('flowWorkspaceUrl').addEventListener('input', refreshFlowGrant);
  $('grantFlow').addEventListener('click', grantFlow);
  $('fleetHubUrl').addEventListener('input', refreshFleetGrantStatus);
  refreshGrantStatus();
  refreshFlowGrant();
  refreshFleetGrantStatus();
  renderFleetHealth();

  for (const id of [...FIELDS, 'studioUsername', 'studioPassword', 'fleetPairingSecret']) {
    const element = $(id);
    element.addEventListener(element.tagName === 'SELECT' ? 'change' : 'input', scheduleSave);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load().catch((error) => showStatus(error.message, 'failed'));
});
