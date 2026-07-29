function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export class StudioClient {
  constructor(baseUrl) {
    this.base = String(baseUrl || '').replace(/\/+$/, '');
  }

  async json(path, options = {}) {
    const response = await fetch(`${this.base}/api${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        detail = body?.detail || detail;
      } catch {
        // Preserve the HTTP status for non-JSON failures.
      }
      throw new Error(detail);
    }
    return response.json();
  }

  whoami() {
    return this.json('/auth/me');
  }

  login(username, password) {
    return this.json('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }

  listProjects() {
    return this.json('/projects');
  }

  listEpisodes(slug) {
    return this.json(`/projects/${encodeURIComponent(slug)}/episodes`);
  }

  sceneReview(slug, code) {
    return this.json(
      `/projects/${encodeURIComponent(slug)}/scene-review/${encodeURIComponent(code)}`
    );
  }

  async sceneImageBase64(slug, code, sceneId) {
    const response = await fetch(
      `${this.base}/api/projects/${encodeURIComponent(slug)}/scene-review/${encodeURIComponent(
        code
      )}/image/${encodeURIComponent(sceneId)}`,
      { credentials: 'include' }
    );
    if (!response.ok) throw new Error(`Scene image not found (${response.status}).`);
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength) throw new Error('Scene image is empty on disk.');
    return {
      base64: bufferToBase64(buffer),
      mime: response.headers.get('content-type') || 'image/png',
    };
  }

  async uploadClip(slug, code, sceneId, mp4) {
    const response = await fetch(
      `${this.base}/api/projects/${encodeURIComponent(slug)}/scene-review/${encodeURIComponent(
        code
      )}/upload-clip/${encodeURIComponent(sceneId)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'video/mp4' },
        body: mp4,
      }
    );
    if (!response.ok) {
      let detail = String(response.status);
      try {
        const body = await response.json();
        detail = body?.detail || detail;
      } catch {
        // Preserve the status for non-JSON failures.
      }
      throw new Error(`Story Studio rejected the clip: ${detail}`);
    }
    return response.json();
  }
}
