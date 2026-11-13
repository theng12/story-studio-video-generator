// MAIN-world recorder (document_start): remembers Flow's batchexecute exchanges so RPC ids are
// learned from the live page instead of being hard-coded. Bounded, never sends anything.
(() => {
  if (window.__relayRpcRecorder) return;
  window.__relayRpcRecorder = true;
  const log = (window.__relayRpcLog = window.__relayRpcLog || []);
  const record = (url, body) => {
    try {
      const text = String(url || '');
      if (!text.includes('batchexecute')) return;
      const params = new URLSearchParams(String(body || ''));
      const rpcid = params.get('rpcids');
      if (!rpcid) return;
      const entry = { rpcid, request: params.get('f.req') || '', response: '', at: Date.now() };
      const existing = log.find((row) => row.rpcid === rpcid && !row.response);
      if (existing) existing.request = entry.request;
      else log.push(entry);
      if (log.length > 60) log.splice(0, log.length - 60);
    } catch { /* recording is best effort */ }
  };
  const recordResponse = (url, text) => {
    try {
      const snippet = String(text || '').slice(0, 4000);
      for (let index = log.length - 1; index >= 0; index -= 1) {
        if (!log[index].response) { log[index].response = snippet; return; }
      }
    } catch { /* ignore */ }
  };
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input?.url;
    const clone = init?.body;
    const promise = originalFetch.apply(this, args);
    const response = await promise;
    try {
      record(url, clone);
      if (String(url || '').includes('batchexecute')) {
        response.clone().text().then((text) => recordResponse(url, text)).catch(() => {});
      }
    } catch { /* ignore */ }
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__relayUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      record(this.__relayUrl, body);
      this.addEventListener('load', () => { try { recordResponse(this.__relayUrl, this.responseText); } catch { /* ignore */ } });
    } catch { /* ignore */ }
    return originalSend.call(this, body);
  };
})();
