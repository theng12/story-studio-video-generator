# Story Studio Video Generator

A Chrome extension for turning Story Studio scenes into organized video files.

## What It Does

- Works with eligible scenes from a connected Story Studio project.
- Lets you choose an episode, select scenes, and configure the available video
  settings for a batch.
- Supports two video sources: **text prompt → video** and **start image → video**
  (an existing scene image or a freshly generated one).
- Runs selected work through a persistent queue with progress, pause, retry, and
  recovery controls.
- Saves finished videos to the connected project workspace.

## Workflow

1. Open the side panel and connect a Story Studio project.
2. Select an episode, then choose the scenes and settings for the batch.
3. Queue the selected work and monitor its status in the active batch view.
4. Let the extension save each completed video to the project workspace.

## Gateway Studio mode

A third, separate mode next to Story Studio and Standalone. Instead of the
panel queueing work, the extension claims generation jobs from Gateway Studio,
runs them through the same persistent queue, and uploads the finished clip back.
The other two modes are unchanged.

1. Set the mode to **Gateway Studio** and enter the gateway URL and worker token.
2. Connection checks learn the worker identity from the authenticated Gateway health response. The worker checks for jobs every 30 seconds (or press **Claim now**) while idle, unpaused, and with an open Flow workspace.
3. Gateway jobs stay bound to the connection that claimed them. Changing the URL, token, or mode holds retained work until that connection is restored. Clear pending preserves Gateway-owned rows.
4. Finished video bytes are retained in IndexedDB until Gateway explicitly accepts the result. A failed delivery can be retried without opening Flow or generating again. A known submitted video ID resumes polling; an uncertain paid submission stays held and must be resolved in Gateway.
5. Gateway image-to-video requires exactly one supplied reference and preserves it until settlement; it never generates a paid replacement image. Unknown source, aspect, duration, or live model availability refuses the job.

These are source recovery safeguards, not live acceptance evidence. Real Chrome/provider checks and Gateway catalogue alignment are required before release.

Worker contract v1 (the extension only makes outbound calls):

| Method | Path |
|---|---|
| GET | `/api/workers/health` |
| POST | `/api/workers/claim` → `204` or `{ job }` |
| POST | `/api/workers/jobs/{id}/progress` |
| POST | `/api/workers/jobs/{id}/result` (multipart file) |
| POST | `/api/workers/jobs/{id}/fail` |

For local verification without the real gateway, run the mock in the parent
`chrome-extensions` folder:

```bash
FLOW_PROJECT_ID=<flow-project-uuid> node _capture/mock-gateway.mjs
```

## Availability

Video generation uses the signed Flow website session and that website account's
quota or credits. There is no developer API key, developer billing account, or
separate API route. The panel shows live inventory or the tested fallback catalog based on whether Flow exposes an exact provider key. Unknown or changed models fail before image or video work.

The Flow address is a Settings field. If Google moves Flow again, paste the new
address and grant site access there — no code change is needed.

The current Flow app is driven through its own signed `batchexecute` endpoint.
The tested catalog carries the captured Omni 1.2 Flash and Omni Flash models for
both video sources; the length is part of the model key, so another duration is a
different captured key.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

There is no build step.

## Notes

- The extension works with a running Story Studio workspace.
- Finished videos are ingested into their Story Studio scenes.
- The queue is designed to survive closing and reopening the side panel.
- Interrupted fresh-image or paid-video work requires explicit review before it
  can be regenerated or resubmitted. Known submitted media IDs resume polling
  and download/ingest without a duplicate request.
- Fleet telemetry is opt-in and signed. With queue-control consent it can only
  pause after the current item, resume its own pause, or clear pending work.
