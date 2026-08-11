# Story Studio Video Generator

A Chrome extension for turning Story Studio scenes into organized video files.

## What It Does

- Works with eligible scenes from a connected Story Studio project.
- Lets you choose an episode, select scenes, and configure the available video
  settings for a batch.
- Runs selected work through a persistent queue with progress, pause, retry, and
  recovery controls.
- Saves finished videos to the connected project workspace.

## Workflow

1. Open the side panel and connect a Story Studio project.
2. Select an episode, then choose the scenes and settings for the batch.
3. Queue the selected work and monitor its status in the active batch view.
4. Let the extension save each completed video to the project workspace.

## Availability

Video generation uses the signed Flow website session and that website account's
quota or credits. There is no developer API key, developer billing account, or
separate API route. The panel shows live inventory or the tested fallback catalog based on whether Flow exposes an exact provider key. Unknown or changed models fail before image or video work.

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
