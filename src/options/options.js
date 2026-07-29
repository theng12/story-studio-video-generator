import {
  getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';

const $ = (id) => document.getElementById(id);
const fields = [
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

async function load() {
  const [settings, credentials] = await Promise.all([getSettings(), getCredentials()]);
  for (const field of fields) $(field).value = settings[field] ?? '';
  $('studioUsername').value = credentials.username || '';
  $('studioPassword').value = credentials.password || '';
}

async function save() {
  const patch = Object.fromEntries(fields.map((field) => [field, $(field).value]));
  await saveSettings(patch);
  $('status').textContent = 'Saved.';
}

$('save').onclick = () => save().catch((error) => ($('status').textContent = error.message));
$('login').onclick = async () => {
  try {
    const credentials = {
      username: $('studioUsername').value,
      password: $('studioPassword').value,
    };
    await saveCredentials(credentials);
    await new StudioClient($('studioBaseUrl').value).login(credentials.username, credentials.password);
    $('status').textContent = 'Signed in.';
  } catch (error) {
    $('status').textContent = `Sign-in failed: ${error.message}`;
  }
};

load();
