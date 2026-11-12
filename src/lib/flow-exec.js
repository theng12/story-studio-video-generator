// One-shot Google Flow MAIN-world command.
//
// Historical positional contract retained from the prior implementation.
// It is not current video transport evidence; new video calls require a live
// inventory binding. The prior same-origin, cookie-authenticated POST uses
// /_/AiSandboxAngularFrontend/data/batchexecute carrying one RPC id, a
// positional-array payload in f.req, and the page's anti-forgery token.
// Text-to-video and image-to-video are separate RPCs with separate model keys.
//
// Keep every dependency inside the function: Chrome serializes the function
// body and does not preserve module closures. Unlike the old window.postMessage
// bridge, this exposes no long-lived page-callable command listener and does not
// broadcast prompts, media bytes, or command results to page scripts.
export async function flowCommand(command) {
  try {
    const SITEKEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
    const RPC = {
      generateImage: 'ogiZ0b',
      uploadImage: 'maseQ',
      textToVideo: 'YhhmEf',
      imageToVideo: 'MZZa6b',
      checkVideo: 'jwpduf',
      getMedia: 'as29s',
      credits: 'nzlxg',
    };
    const IMAGE_MODELS = {
      'nano-banana-2': 'NARWHAL',
      'nano-banana-2-lite': 'HARBOR_SEAL',
      'nano-banana-pro': 'GEM_PIX_2',
      NARWHAL: 'NARWHAL',
      HARBOR_SEAL: 'HARBOR_SEAL',
      GEM_PIX_2: 'GEM_PIX_2',
    };
    // Only 16:9 has been captured on the current app; refuse other shapes
    // rather than guess an enum value.
    const IMAGE_ASPECT = { '16:9': 3 };
    const VIDEO_ASPECT = { '16:9': 2 };
    // Video completion state inside the polled media object.
    const VIDEO_STATUS_GENERATING = 2;
    const VIDEO_STATUS_DONE = 3;
    const EXACT_MODEL = /^[a-z0-9][a-z0-9_.-]{2,127}$/;
    const payload = command?.payload || {};

    const uuid = () =>
      crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          });
    const upperUuid = () => uuid().toUpperCase();
    const normalizeProjectId = (value) => {
      const raw = String(value || '').trim();
      const match = raw.match(
        /(?:\/project\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
      );
      return match ? match[1].toLowerCase() : raw;
    };
    const currentProjectId = () => {
      const match = location.pathname.match(/\/project\/([0-9a-f-]{36})/i);
      return match ? match[1] : '';
    };
    const projectIdFor = (value) => normalizeProjectId(value || currentProjectId());
    const randomSeed = () => Math.floor(Math.random() * 1_000_000_000);
    const bufToBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
    // The page's anti-forgery + session values. They exist only on a signed-in
    // app page, which is exactly the "are we signed in" signal.
    const wiz = () => {
      const data = window.WIZ_global_data || {};
      if (!data.SNlM0e) throw new Error('Not signed in to Flow, or this is not the Flow app page. Open a Flow project and sign in.');
      return { at: data.SNlM0e, sid: data.FdrFJe || '', bl: data.cfb2h || '' };
    };
    const mintToken = async (action) => {
      const enterprise = window.grecaptcha?.enterprise;
      if (!enterprise?.execute) throw new Error('grecaptcha not loaded yet — reload the Flow tab.');
      return new Promise((resolve, reject) => {
        try {
          enterprise.ready(() => enterprise.execute(SITEKEY, { action }).then(resolve, reject));
        } catch (error) {
          reject(error);
        }
      });
    };
    const clientContext = (projectId, token) =>
      [null, 22, null, null, null, projectId, null, null, null, null, [token, 1]];
    const textInput = (prompt) => [null, null, [[[String(prompt)]]]];
    // Parse a batchexecute body: ")]}'" then length-prefixed JSON chunks; the
    // answer is the ["wrb.fr", rpcId, <json string>] row.
    const parseRpc = (text, rpcId) => {
      const rows = [];
      for (const line of String(text).replace(/^\)\]\}'/, '').split('\n')) {
        if (!line.startsWith('[')) continue;
        try { rows.push(...JSON.parse(line)); } catch { /* length prefix or partial */ }
      }
      const row = rows.find((entry) => Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === rpcId);
      if (!row) throw new Error(`Flow returned no ${rpcId} result.`);
      if (typeof row[2] !== 'string') {
        const code = Array.isArray(row[5]) ? row[5][0] : null;
        throw Object.assign(new Error(`Flow rejected ${rpcId}${code != null ? ` (error ${code})` : ''}.`), { flowErrorCode: code });
      }
      return JSON.parse(row[2]);
    };
    const rpc = async (rpcId, args, projectId) => {
      const { at, sid, bl } = wiz();
      const query = new URLSearchParams({
        rpcids: rpcId,
        'source-path': projectId ? `/project/${projectId}` : '/',
        bl,
        'f.sid': sid,
        hl: 'en',
        _reqid: String(Math.floor(Math.random() * 900000) + 100000),
        rt: 'c',
      });
      const body = new URLSearchParams({
        'f.req': JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]),
        at,
      });
      const response = await fetch(`/_/AiSandboxAngularFrontend/data/batchexecute?${query}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Same-Domain': '1', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
      });
      const text = await response.text();
      if (!response.ok) throw Object.assign(new Error(`Flow ${rpcId} failed (${response.status}).`), { status: response.status });
      return parseRpc(text, rpcId);
    };
    const findImageUrl = (value) => {
      if (typeof value === 'string') return value.startsWith('https://flow-content.google/image/') ? value : null;
      if (!Array.isArray(value)) return null;
      for (const entry of value) {
        const found = findImageUrl(entry);
        if (found) return found;
      }
      return null;
    };
    const downloadImage = async (value) => {
      const url = new URL(String(value || ''));
      if (
        url.protocol !== 'https:' ||
        !(url.hostname === 'flow-content.google' || url.hostname.endsWith('.flow-content.google'))
      ) {
        throw new Error('Flow returned an untrusted image URL.');
      }
      const response = await fetch(url.href, { credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error(`Asset download failed (${response.status}).`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) throw new Error('Flow returned a non-image asset.');
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) throw new Error('Downloaded asset was empty.');
      if (buffer.byteLength > 50 * 1024 * 1024) throw new Error('Downloaded image exceeded 50 MB.');
      return { base64: bufToBase64(buffer), mime: contentType || 'image/png' };
    };

    const generateImage = async () => {
      const projectId = projectIdFor(payload.projectId);
      if (!projectId) throw new Error('No Flow project selected.');
      if (!String(payload.prompt || '').trim()) throw new Error('Empty image prompt.');
      const modelId = IMAGE_MODELS[payload.model] || payload.model;
      if (!modelId) throw new Error('Flow image model is malformed.');
      const aspect = IMAGE_ASPECT[payload.aspectRatio || '16:9'];
      if (!aspect) throw new Error(`Flow image aspect ratio ${payload.aspectRatio} is not mapped yet — use 16:9.`);
      const seed = Number.isFinite(payload.seed) ? payload.seed : randomSeed();
      const maxAttempts = Math.min(10, Math.max(1, Math.round(Number(payload.recaptchaMaxAttempts) || 4)));
      wiz();
      let result;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const token = await mintToken('IMAGE_GENERATION');
        const context = clientContext(projectId, token);
        const request = [
          null,
          [[
            null,
            null,
            null,
            seed,
            aspect,
            modelId,
            null,
            context,
            [[[payload.prompt]]],
            null,
            null,
            null,
            upperUuid(),
            upperUuid(),
          ]],
          1,
          context,
          [upperUuid()],
        ];
        try {
          result = await rpc(RPC.generateImage, request, projectId);
          break;
        } catch (error) {
          const detail = String(error?.message || error);
          const recaptchaFailure =
            error?.status === 403 || /recaptcha|captcha|evaluation failed/i.test(detail);
          if (recaptchaFailure && attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
            continue;
          }
          if (recaptchaFailure) {
            throw new Error(`Flow reCAPTCHA failed after ${attempt} fresh-token attempts: ${detail}`);
          }
          throw new Error(`Flow image generation failed: ${detail}`);
        }
      }
      const media = result?.[0]?.[0];
      const imageUrl = findImageUrl(media);
      if (!imageUrl) throw new Error('Flow returned no image URL.');
      const image = await downloadImage(imageUrl);
      const dims = Array.isArray(media?.[8]) ? media[8] : [];
      return {
        ...image,
        mediaId: typeof media?.[0] === 'string' ? media[0] : undefined,
        seed,
        width: dims[0],
        height: dims[1],
      };
    };

    const uploadImage = async () => {
      const projectId = projectIdFor(payload.projectId);
      if (!projectId) throw new Error('No Flow project selected.');
      if (!payload.base64) throw new Error('uploadImage needs base64 image bytes.');
      const token = await mintToken('UPLOAD_IMAGE');
      const result = await rpc(RPC.uploadImage, [
        clientContext(projectId, token),
        String(payload.base64),
        payload.mime || 'image/png',
        1,
        null,
        null,
        null,
        null,
        payload.fileName || 'scene.png',
        null,
        upperUuid(),
        upperUuid(),
      ], projectId);
      const mediaId = result?.[0]?.[0];
      if (typeof mediaId !== 'string' || !mediaId) throw new Error('Flow upload returned no media id.');
      return { mediaId };
    };

    const submitVideo = async () => {
      const projectId = projectIdFor(payload.projectId);
      if (!projectId) throw new Error('No Flow project selected.');
      const mode = payload.mode === 'text' ? 'text' : 'image';
      const modelKey = String(payload.modelKey || '').trim();
      if (!EXACT_MODEL.test(modelKey)) throw new Error('Video submission needs an exact Flow model key.');
      const binding = payload.modelBinding;
      if (!Number.isSafeInteger(payload.durationSec) || payload.durationSec <= 0 ||
          !binding || binding.inventorySource !== 'live' || binding.modelKey !== modelKey || binding.mode !== mode ||
          binding.durationSec !== payload.durationSec ||
          binding.rpcId !== (mode === 'text' ? RPC.textToVideo : RPC.imageToVideo)) {
        throw new Error('Video model and duration have no matching captured request binding; nothing was submitted.');
      }
      const aspect = VIDEO_ASPECT[payload.aspectRatio || '16:9'];
      if (!aspect) {
        throw new Error(`Flow video aspect ratio ${payload.aspectRatio} is not verified on the current app yet — use 16:9.`);
      }
      if (!String(payload.prompt || '').trim()) throw new Error('Empty video prompt.');
      if (mode === 'image' && !payload.mediaId) throw new Error('Image-to-video needs a start-image media id.');
      const token = await mintToken('VIDEO_GENERATION');
      const context = clientContext(projectId, token);
      const requestIds = [null, null, null, null, upperUuid(), upperUuid()];
      const request = mode === 'text'
        ? [textInput(payload.prompt), modelKey, aspect, null, requestIds]
        : [textInput(payload.prompt), [[null, payload.mediaId]], modelKey, aspect, null, requestIds];
      const result = await rpc(
        mode === 'text' ? RPC.textToVideo : RPC.imageToVideo,
        [[request], context, [upperUuid(), 2]],
        projectId
      );
      const mediaId = result?.[2]?.[0]?.[3]?.[4] || result?.[2]?.[1]?.[0]?.[0];
      if (typeof mediaId !== 'string' || !mediaId) throw new Error('Flow video submit returned no media id.');
      return { mediaId };
    };

    const checkVideo = async () => {
      if (!payload.mediaId) throw new Error('Video status check needs a media id.');
      const result = await rpc(
        RPC.checkVideo,
        [null, null, [[payload.mediaId]]],
        projectIdFor(payload.projectId)
      );
      const status = result?.[2]?.[0]?.[5]?.[8]?.[0];
      if (typeof status !== 'number') throw new Error('Flow returned no video status.');
      return {
        status,
        done: status === VIDEO_STATUS_DONE,
        failed: status !== VIDEO_STATUS_GENERATING && status !== VIDEO_STATUS_DONE,
      };
    };

    const findVideoUrl = (value) => {
      if (typeof value === 'string') return value.startsWith('https://flow-content.google/video/') ? value : null;
      if (!Array.isArray(value)) return null;
      for (const entry of value) {
        const found = findVideoUrl(entry);
        if (found) return found;
      }
      return null;
    };
    const getMedia = async () => {
      if (!payload.mediaId) throw new Error('Media lookup needs a media id.');
      const result = await rpc(RPC.getMedia, [payload.mediaId], projectIdFor(payload.projectId));
      // The media object layout shifts between image and video; search for the
      // signed /video/ URL instead of trusting a fixed index.
      const url = findVideoUrl(result);
      if (!url) throw new Error('Flow returned no verified video URL.');
      return { url };
    };

    const listVideoModels = async () => {
      // The current app has no page-side model manifest. Return no entries so
      // the worker uses its tested catalog; still report sign-in and project.
      let signedIn = false;
      try {
        wiz();
        signedIn = true;
      } catch {
        // The panel needs a state result, not an exception, for signed-out tabs.
      }
      // A visible workspace summary is an observation, not a backend binding.
      // Never turn UI labels or slider positions into provider keys.
      const text = typeof document === 'undefined' ? '' : document.body?.innerText || '';
      const summaries = [...text.matchAll(/Video\s*·\s*(\d+p)\s*·\s*(\d+)s\s+[^\n]*\s*x(\d+)\b/g)];
      const summary = summaries.length === 1 ? summaries[0] : null;
      const observedSelection = summary ? {
        resolution: summary[1], durationSec: Number(summary[2]), outputCount: Number(summary[3]),
      } : null;
      return { entries: [], signedIn, projectId: currentProjectId(), observedSelection };
    };

    const getContext = async () => {
      let signedIn = false;
      try {
        wiz();
        signedIn = true;
      } catch {
        // The panel needs a state result, not an exception, for signed-out tabs.
      }
      return { projectId: currentProjectId(), signedIn, url: location.href };
    };

    // Captured 2026-11-09 as `rpcids=nzlxg` with args `[]`:
    // [credits, 3, 8, 1, null, credits, [asOfSeconds, asOfNanos]]. Index 0 is the
    // balance; the trailing pair is a server snapshot time, not a reset date.
    const getCredits = async () => {
      const result = await rpc(RPC.credits, [], currentProjectId());
      const value = result?.[0];
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Flow returned no credit balance.');
      return { value, unit: 'credits', source: 'flow.nzlxg', observedAt: new Date().toISOString() };
    };
    // Observed live per clip: 4s text = 12, 3s image = 9. 6s/10s come from Flow's
    // own UI at 720p. Any other length has no observed price, so it gets no quote.
    const VIDEO_CREDIT_COST = Object.freeze({ 3: 9, 4: 12, 6: 18, 10: 30 });
    // Opaque page-provided identity only — never a cookie, email, session id or
    // profile label. A session is not an account, so there is no fallback.
    const providerAccountId = () => {
      const data = window.WIZ_global_data || {};
      const raw = ['S06Grb', 'S09Zad', 'oPEP7c'].map((key) => data[key]).find((value) => typeof value === 'string' && value);
      const stable = String(raw || '').replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 100);
      return stable ? `flow.${stable}` : '';
    };
    // Read-only: reports the provider account, its credit balance and, when a
    // preview is supplied, the observed price for that job. It never generates.
    const inspectAccount = async () => {
      wiz();
      const accountId = providerAccountId();
      if (!accountId) throw new Error('Flow exposed no stable account identity.');
      const observedAt = new Date().toISOString();
      let balance = null;
      try {
        balance = await getCredits();
      } catch {
        // Unknown stays unknown; it is never reported as zero.
      }
      const account = {
        schema: 1, provider: 'flow', accountId, source: 'extension.video', observedAt,
        connection: 'connected', signIn: 'signed_in',
        readiness: !balance ? 'unknown' : balance.value > 0 ? 'ready' : 'not_ready',
        balance, resetAt: null, plan: null, creditBuckets: null,
      };
      const preview = payload.preview;
      const value = preview?.job ? VIDEO_CREDIT_COST[preview.job.durationSec] : undefined;
      const quote = balance && Number.isSafeInteger(value) && /^[0-9a-f]{64}$/.test(String(preview.payloadSha256 || ''))
        ? { provider: 'flow', accountId, payloadSha256: preview.payloadSha256, value, unit: 'credits',
            source: 'flow.pricing.duration', observedAt }
        : null;
      return { account, quote };
    };

    // ponytail: the current app's create-project RPC has not been captured yet.
    const createProject = async () => {
      throw new Error('Creating Flow projects is not supported on the current Flow yet — create one in Flow and pick it in the panel.');
    };

    const handlers = {
      generateImage,
      uploadImage,
      submitVideo,
      checkVideo,
      getMedia,
      listVideoModels,
      inspectAccount,
      getCredits,
      getContext,
      createProject,
    };
    const handler = handlers[command?.op];
    if (!handler) throw new Error(`Unknown Flow operation: ${command?.op || ''}`);
    return { ok: true, result: await handler() };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
