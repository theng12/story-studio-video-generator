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

Video generation uses a compatible signed-in browser session. Available
settings, capacity, and limits depend on the session you are using. Generation
may use account credits, so review each batch before starting.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

There is no build step.

## Notes

- The extension works with a running Story Studio workspace.
- Finished videos are ingested into their Story Studio scenes.
- The queue is designed to survive closing and reopening the side panel.
- Interrupted work may require review before it can be retried.
