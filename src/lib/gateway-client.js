// Gateway Studio worker transport. The extension makes only outbound calls, so
// no port is opened on this machine. Endpoints (contract v1):
//   GET  /api/workers/health
//   POST /api/workers/claim                    -> 204 | { job }
//   POST /api/workers/jobs/{id}/progress       -> { ok }
//   POST /api/workers/jobs/{id}/result         multipart file + mediaType
//   POST /api/workers/jobs/{id}/fail           -> { ok }

// Canonical base: HTTP or HTTPS with no embedded credentials, query or fragment.
// Plain HTTP is allowed on any address, so this Mac's Gateway stays reachable over
// LAN and Tailscale as the owner approved. Rejects rather than silently rewrites.
function normalizedBase(settings) {
  const raw = String(settings?.gatewayUrl || '').trim();
  if (!raw) throw new Error('Gateway Studio URL is not set.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter the Gateway server address.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Gateway address must be HTTP or HTTPS without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

function requireToken(settings) {
  const token = String(settings?.gatewayToken || '').trim();
  if (!token) throw new Error('Gateway Studio token is not set.');
  return token;
}

function requireWorkerId(settings) {
  const workerId = String(settings?.gatewayWorkerId || '').trim();
  if (!workerId) throw new Error('Gateway worker id is not set.');
  return workerId;
}

function acknowledged(path, result) {
  if (result.ok !== true) throw new Error(`Gateway ${path} failed: not acknowledged`);
  if (result.ignored === true) throw new Error(`Gateway ${path} failed: ignored`);
  return result;
}

async function request(settings, path, { method = 'GET', json, body, timeoutMs = 20000, allowEmpty = false } = {}) {
  const url = `${normalizedBase(settings)}${path}`;
  const token = requireToken(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Authorization: `Bearer ${token}` };
    let payload = body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new Error(`Gateway ${path} failed: ${controller.signal.aborted ? 'timed out' : 'network error'}`);
    }
    if (response.status === 204) {
      if (allowEmpty) return null;
      throw new Error(`Gateway ${path} failed: unexpected empty response`);
    }
    if (!response.ok) throw new Error(`Gateway ${path} failed: HTTP ${response.status}`);
    let text;
    try {
      text = await response.text();
    } catch {
      throw new Error(`Gateway ${path} failed: network error`);
    }
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Gateway ${path} failed: malformed response`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Gateway ${path} failed: malformed response`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function testGateway(settings) {
  const path = '/api/workers/health';
  const health = await request(settings, path, { timeoutMs: 8000 });
  if (health.ok !== true) throw new Error('Gateway health check failed: not ok.');
  if (health.kind !== 'video') throw new Error('Gateway health check failed: wrong kind.');
  const workerId = typeof health.workerId === 'string' ? health.workerId.trim() : '';
  if (!workerId) throw new Error('Gateway health check failed: no worker id.');
  if (!Number.isSafeInteger(health.maxResultBytes) || health.maxResultBytes <= 0) {
    throw new Error('Gateway health check failed: invalid result limit.');
  }
  if (typeof health.leaseSeconds !== 'number' || !Number.isFinite(health.leaseSeconds) || health.leaseSeconds <= 0) {
    throw new Error('Gateway health check failed: invalid lease.');
  }
  const configured = String(settings?.gatewayWorkerId || '').trim();
  if (configured && configured !== workerId) {
    throw new Error('Gateway health check failed: worker id does not match.');
  }
  return { ok: true, workerId, kind: health.kind, maxResultBytes: health.maxResultBytes, leaseSeconds: health.leaseSeconds };
}

export async function claimGatewayJob(settings) {
  const path = '/api/workers/claim';
  const result = await request(settings, path, {
    method: 'POST',
    json: { workerId: requireWorkerId(settings), kind: 'video' },
    timeoutMs: 35000,
    allowEmpty: true,
  });
  if (result === null) return null;
  const job = result.job;
  if (!job || typeof job !== 'object' || Array.isArray(job) || typeof job.jobId !== 'string' || !job.jobId.trim()) {
    // A claimed job with no usable id may already have spent credits: throw so the caller holds it.
    throw new Error(`Gateway ${path} failed: malformed job`);
  }
  return job;
}

export async function reportGatewayProgress(settings, jobId, phase, message = '') {
  if (!jobId) return null;
  const path = `/api/workers/jobs/${encodeURIComponent(jobId)}/progress`;
  const result = await request(settings, path, {
    method: 'POST',
    json: { phase: String(phase || ''), message: String(message || '').slice(0, 300) },
  });
  return acknowledged(path, result);
}

export async function reportGatewayResult(settings, jobId, buffer, mediaType = 'video/mp4') {
  if (!jobId) return null;
  const path = `/api/workers/jobs/${encodeURIComponent(jobId)}/result`;
  const form = new FormData();
  form.append('mediaType', mediaType);
  form.append('file', new Blob([buffer], { type: mediaType }), 'result.mp4');
  const result = await request(settings, path, { method: 'POST', body: form, timeoutMs: 120000 });
  return acknowledged(path, result);
}

export async function reportGatewayFailure(settings, jobId, error, ambiguous = false) {
  if (!jobId) return null;
  const path = `/api/workers/jobs/${encodeURIComponent(jobId)}/fail`;
  const result = await request(settings, path, {
    method: 'POST',
    json: { error: String(error?.message || error || 'unknown').slice(0, 500), ambiguous: ambiguous === true },
  });
  return acknowledged(path, result);
}

export async function gatewayBinding(settings) {
  const input = [normalizedBase(settings), requireToken(settings), requireWorkerId(settings)].join('\n');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}