// Filename + download-path construction for generated scene clips.
// chrome.downloads may write only within the browser Downloads directory.

function sanitizeSegment(s) {
  return String(s ?? '')
    .replace(/[\/\\:*?"<>|]/g, '-') // path-illegal -> dash
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function applyTokens(template, tokens) {
  return template.replace(/\{(\w+)\}/g, (_, key) => sanitizeSegment(tokens[key] ?? ''));
}

// Build the Downloads-relative path (no leading slash, forward slashes only).
// e.g. "StoryStudioVideos/abiding-faith/EP0110/EP0110_scene_000001.mp4"
export function buildDownloadPath(settings, tokens, ext = 'png') {
  const dir = applyTokens(settings.downloadSubdir || '', tokens)
    .split('/')
    .map(sanitizeSegment)
    .filter(Boolean)
    .join('/');
  let name = applyTokens(settings.filenameTemplate || '{episodeCode}_{sceneId}', tokens);
  name = sanitizeSegment(name) || 'scene';
  const file = `${name}.${ext}`;
  return dir ? `${dir}/${file}` : file;
}

export { sanitizeSegment, applyTokens };
