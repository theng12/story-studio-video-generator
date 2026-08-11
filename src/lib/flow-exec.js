// One-shot Google Flow MAIN-world command.
//
// This function is passed directly to chrome.scripting.executeScript. Keep every
// dependency inside the function: Chrome serializes the function body and does
// not preserve module closures. Unlike the old window.postMessage bridge, this
// exposes no long-lived page-callable command listener and does not broadcast
// prompts, media bytes, or command results to page scripts.
export async function flowCommand(command) {
  try {
    const API = 'https://aisandbox-pa.googleapis.com/v1';
    const SITEKEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
    const IMAGE_MODELS = {
      'nano-banana-2': 'NARWHAL',
      'nano-banana-2-lite': 'HARBOR_SEAL',
      'nano-banana-pro': 'GEM_PIX_2',
      NARWHAL: 'NARWHAL',
      HARBOR_SEAL: 'HARBOR_SEAL',
      GEM_PIX_2: 'GEM_PIX_2',
    };
    const IMAGE_ASPECT = {
      '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
      '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
      '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
      '4:3': 'IMAGE_ASPECT_RATIO_FULL',
      '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_FULL',
    };
    const VIDEO_ASPECT = {
      '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
      '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
    };
    const payload = command?.payload || {};

    const uuid = () =>
      crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          });
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
    const randomSeed = () => Math.floor(Math.random() * 1_000_000);
    const sessionId = () => `;${Date.now()}`;
    const bufToBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
    const accessToken = async () => {
      const response = await fetch('/fx/api/auth/session', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Not signed in to Flow (session ${response.status}). Open labs.google/fx and sign in.`);
      }
      const json = await response.json();
      if (!json?.access_token) throw new Error('Flow session has no access_token — sign in again.');
      return json.access_token;
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
    const recaptchaContext = (token) => ({
      token,
      applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
    });
    const errorDetail = async (response) => {
      try {
        const json = await response.json();
        return json?.error?.message || String(response.status);
      } catch {
        return String(response.status);
      }
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
      const model = IMAGE_MODELS[payload.model] || 'NARWHAL';
      const aspect = IMAGE_ASPECT[payload.aspectRatio] || 'IMAGE_ASPECT_RATIO_LANDSCAPE';
      const seed = Number.isFinite(payload.seed) ? payload.seed : randomSeed();
      const maxAttempts = Math.min(10, Math.max(1, Math.round(Number(payload.recaptchaMaxAttempts) || 4)));
      let json;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const token = await mintToken('IMAGE_GENERATION');
        const clientContext = {
          recaptchaContext: recaptchaContext(token),
          projectId,
          tool: 'PINHOLE',
          sessionId: sessionId(),
        };
        const response = await fetch(
          `${API}/projects/${encodeURIComponent(projectId)}/flowMedia:batchGenerateImages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${await accessToken()}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              clientContext,
              mediaGenerationContext: { batchId: uuid() },
              useNewMedia: true,
              requests: [
                {
                  clientContext,
                  imageModelName: model,
                  imageAspectRatio: aspect,
                  structuredPrompt: { parts: [{ text: payload.prompt }] },
                  seed,
                  imageInputs: Array.isArray(payload.imageInputs) ? payload.imageInputs : [],
                },
              ],
            }),
          }
        );
        if (response.ok) {
          json = await response.json();
          break;
        }
        const detail = await errorDetail(response);
        const recaptchaFailure =
          response.status === 403 || /recaptcha|captcha|evaluation failed/i.test(detail);
        if (recaptchaFailure && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
          continue;
        }
        if (recaptchaFailure) {
          throw new Error(
            `Flow reCAPTCHA failed after ${attempt} fresh-token attempts (${response.status}): ${detail}`
          );
        }
        throw new Error(`Flow image generation failed (${response.status}): ${detail}`);
      }
      const generated = json?.media?.[0]?.image?.generatedImage;
      if (!generated?.fifeUrl) throw new Error('Flow returned no image URL.');
      const image = await downloadImage(generated.fifeUrl);
      return {
        ...image,
        mediaId: generated.mediaId || json.media[0].name,
        seed: generated.seed ?? seed,
        width: json.media[0]?.image?.dimensions?.width,
        height: json.media[0]?.image?.dimensions?.height,
      };
    };
    const uploadImage = async () => {
      const projectId = projectIdFor(payload.projectId);
      if (!projectId) throw new Error('No Flow project selected.');
      if (!payload.base64) throw new Error('uploadImage needs base64 image bytes.');
      const response = await fetch(`${API}/flow/uploadImage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientContext: { projectId, tool: 'PINHOLE' },
          imageBytes: payload.base64,
          isUserUploaded: true,
          isHidden: false,
          mimeType: payload.mime || 'image/png',
          fileName: payload.fileName || 'scene.png',
        }),
      });
      if (!response.ok) throw new Error(`Flow image upload failed (${response.status}).`);
      const json = await response.json();
      if (!json?.media?.name) throw new Error('Flow upload returned no media id.');
      return { mediaId: json.media.name };
    };
    const listVideoModels = async () => {
      const entries = [];
      const add = (key, label) => entries.push({ key: String(key || ''), label: String(label || '') });
      const nextData = window.__NEXT_DATA__ || (() => {
        try { return JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null'); }
        catch { return null; }
      })();
      const configs = nextData?.props?.pageProps?.videoModelConfigs;
      for (const config of Array.isArray(configs) ? configs : []) add(config.videoModelKey, config.displayName);
      for (const element of document.querySelectorAll('[role="option"][data-video-model-key]')) {
        add(element.getAttribute('data-video-model-key'), element.textContent);
      }
      return { entries };
    };
    const submitVideoStartImage = async () => {
      const projectId = projectIdFor(payload.projectId);
      if (!projectId) throw new Error('No Flow project selected.');
      if (!payload.mediaId) throw new Error('Video submission needs a start-image media id.');
      if (!/^[a-z0-9][a-z0-9_.-]{2,127}$/.test(String(payload.modelKey || ''))) {
        throw new Error('Video submission needs an exact Flow model key.');
      }
      const token = await mintToken('VIDEO_GENERATION');
      const clientContext = {
        projectId,
        tool: 'PINHOLE',
        sessionId: sessionId(),
        recaptchaContext: recaptchaContext(token),
      };
      const response = await fetch(`${API}/video:batchAsyncGenerateVideoStartImage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mediaGenerationContext: {
            batchId: uuid(),
            audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
          },
          clientContext,
          requests: [
            {
              aspectRatio:
                VIDEO_ASPECT[payload.aspectRatio] || 'VIDEO_ASPECT_RATIO_LANDSCAPE',
              textInput: {
                structuredPrompt: { parts: [{ text: payload.motionPrompt || '' }] },
              },
              videoModelKey: payload.modelKey,
              seed: Number.isFinite(payload.seed) ? payload.seed : randomSeed(),
              metadata: {},
              startImage: {
                mediaId: payload.mediaId,
                cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 },
              },
            },
          ],
          useV2ModelConfig: true,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Flow image-to-video submit failed (${response.status}): ${await errorDetail(response)}`
        );
      }
      const json = await response.json();
      const mediaId = json?.media?.[0]?.name;
      if (!mediaId) throw new Error('Flow video submit returned no media id.');
      return { mediaId };
    };
    const checkVideo = async () => {
      const projectId = projectIdFor(payload.projectId);
      if (!payload.mediaId) throw new Error('Video status check needs a media id.');
      const response = await fetch(`${API}/video:batchCheckAsyncVideoGenerationStatus`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ media: [{ name: payload.mediaId, projectId }] }),
      });
      if (!response.ok) throw new Error(`Flow video status check failed (${response.status}).`);
      const json = await response.json();
      const status =
        json?.media?.[0]?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || 'UNKNOWN';
      return {
        status,
        done: status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
        failed: /FAILED|ERROR|CANCELL?ED/i.test(status),
      };
    };
    const getContext = async () => {
      let signedIn = false;
      try {
        await accessToken();
        signedIn = true;
      } catch {
        // The panel needs a state result, not an exception, for signed-out tabs.
      }
      return { projectId: currentProjectId(), signedIn, url: location.href };
    };
    const createProject = async () => {
      const title =
        payload.title ||
        new Date().toLocaleString('en-US', {
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      const response = await fetch('/fx/api/trpc/project.createProject', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: { projectTitle: title, toolName: 'PINHOLE' } }),
      });
      if (!response.ok) throw new Error(`Flow createProject failed (${response.status}).`);
      const json = await response.json();
      const projectId = json?.result?.data?.json?.result?.projectId;
      if (!projectId) throw new Error('Flow createProject returned no projectId.');
      return { projectId, title };
    };

    const handlers = {
      generateImage,
      uploadImage,
      listVideoModels,
      submitVideoStartImage,
      checkVideo,
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
