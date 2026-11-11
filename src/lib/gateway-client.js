// Gateway Studio worker transport. The extension makes only outbound calls, so
// no port is opened on this machine. Endpoints (contract v1):
//   GET  /api/workers/health
//   POST /api/workers/claim                    -> 204 | { job }
//   POST /api/workers/jobs/{id}/progress       -> { ok }
//   POST /api/workers/jobs/{id}/result         multipart file + mediaType
//   POST /api/workers/jobs/{id}/fail           -> { ok }

function baseUrl(settings) {
  const base = String(settings?.gatewayUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Gateway Studio URL is not set.');
  return base;
}

function authHeaders(settings, extra = {}) {
  const headers = { ...extra };
  if (settings?.gatewayToken) headers.Authorization = `Bearer ${settings.gatewayToken}`;
  return headers;
}

async function request(settings, path, { method = 'GET', json, body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = authHeaders(settings);
    let payload = body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const response = await fetch(`${baseUrl(settings)}${path}`, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = parsed?.error || parsed?.detail || text || `HTTP ${response.status}`;
      throw new Error(`Gateway ${path} failed (${response.status}): ${String(detail).slice(0, 200)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function claimGatewayJob(settings) {
  const workerId = String(settings?.gatewayWorkerId || '').trim();
  if (!workerId) throw new Error('Gateway worker id is not set.');
  const result = await request(settings, '/api/workers/claim', {
    method: 'POST',
    json: { workerId, kind: 'video' },
    timeoutMs: 35000,
  });
  if (!result) return null;
  const job = result.job && typeof result.job === 'object' ? result.job : result;
  return job?.jobId ? job : null;
}

export async function reportGatewayProgress(settings, jobId, phase, message = '') {
  if (!jobId) return null;
  return request(settings, `/api/workers/jobs/${encodeURIComponent(jobId)}/progress`, {
    method: 'POST',
    json: { phase: String(phase || ''), message: String(message || '').slice(0, 300) },
  });
}

export async function reportGatewayResult(settings, jobId, buffer, mediaType = 'video/mp4') {
  if (!jobId) return null;
  const form = new FormData();
  form.append('mediaType', mediaType);
  form.append('file', new Blob([buffer], { type: mediaType }), `${jobId}.mp4`);
  return request(settings, `/api/workers/jobs/${encodeURIComponent(jobId)}/result`, {
    method: 'POST',
    body: form,
    timeoutMs: 120000,
  });
}

export async function reportGatewayFailure(settings, jobId, error, ambiguous = false) {
  if (!jobId) return null;
  return request(settings, `/api/workers/jobs/${encodeURIComponent(jobId)}/fail`, {
    method: 'POST',
    json: { error: String(error?.message || error || 'unknown').slice(0, 500), ambiguous: ambiguous === true },
  });
}

export async function testGateway(settings) {
  const health = await request(settings, '/api/workers/health', { timeoutMs: 8000 });
  return { ok: true, ...(health || {}) };
}
