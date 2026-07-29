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
  'flowProjectId',
  'videoModel',
  'videoSource',
  'aspectRatio',
  'saveTarget',
  'downloadSubdir',
  'filenameTemplate',
  'humanDelayMinSec',
  'humanDelayMaxSec',
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

  for (const id of [...FIELDS, 'studioUsername', 'studioPassword']) {
    const element = $(id);
    element.addEventListener(element.tagName === 'SELECT' ? 'change' : 'input', scheduleSave);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load().catch((error) => showStatus(error.message, 'failed'));
});
