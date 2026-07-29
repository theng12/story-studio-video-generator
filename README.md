# Story Studio Video Generator

Video-only companion to Story Studio Bulk Asset. It reads approved Story Studio
scene motion prompts, submits image-to-video jobs through the signed-in Google
Flow web session, persists the returned media ID, polls completion, and saves
the MP4 to Story Studio's `11 Video Assets` folder or Downloads.

Video generation spends Flow/Veo credits. Every new batch requires explicit
confirmation and runs strictly sequentially. If the extension stops while a paid
submission is in flight and no media ID was returned, the job is quarantined as
ambiguous instead of being replayed automatically.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this folder.
3. Sign in to `labs.google/fx`, open a Flow project, and select **Use current tab**.
4. Configure the Story Studio server URL in Settings.
5. Load an episode, select eligible scenes, and confirm the paid batch.

There is no build step.
