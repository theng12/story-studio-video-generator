import { getSettings, saveSettings } from './config.js';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function resolve(preference) {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return media().matches ? 'dark' : 'light';
}

function apply(preference) {
  document.documentElement.setAttribute('data-theme', resolve(preference));
}

let mediaQuery = null;
let mediaHandler = null;

export function setTheme(preference) {
  apply(preference);
  if (mediaQuery && mediaHandler) mediaQuery.removeEventListener('change', mediaHandler);
  mediaQuery = null;
  mediaHandler = null;
  if (preference === 'system') {
    mediaQuery = media();
    mediaHandler = () => apply('system');
    mediaQuery.addEventListener('change', mediaHandler);
  }
}

export async function initTheme() {
  const settings = await getSettings();
  setTheme(settings.theme || 'system');
  return settings.theme || 'system';
}

export async function saveTheme(preference) {
  await saveSettings({ theme: preference });
  setTheme(preference);
}
