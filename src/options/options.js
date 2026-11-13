import {
  DEFAULTS,
  getSettings,
  saveSettings,
  getGatewayToken,
  saveGatewayToken,
} from '../lib/config.js';
import { initTheme, setTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'theme',
  'mode',
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
      saveGatewayToken($('gatewayToken').value),
    ]);
    await chrome.runtime.sendMessage({ type: 'gatewayModeChanged' }).catch(() => {});
    showStatus('✓ Saved', 'ok');
  } catch (error) {
    showStatus(`Couldn’t save: ${error.message}`, 'failed');
  }
}

function refreshMode() {
  $('gatewaySection').hidden = $('mode').value !== 'gateway';
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

async function load() {
  await initTheme();
  const [settings, gatewayToken] = await Promise.all([
    getSettings(),
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
  $('gatewayToken').value = gatewayToken || '';

  $('theme').addEventListener('change', () => setTheme($('theme').value));
  $('save').addEventListener('click', save);
  $('mode').addEventListener('change', () => {
    refreshMode();
    if ($('mode').value !== 'gateway') requestFlowAccess();
  });
  refreshMode();

  for (const id of FIELDS) {
    const element = $(id);
    element.addEventListener(element.tagName === 'SELECT' ? 'change' : 'input', scheduleSave);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load().catch((error) => showStatus(error.message, 'failed'));
});
