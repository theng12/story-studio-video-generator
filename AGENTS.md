# Story Studio Video Generator

This Manifest V3 extension is video-only. It uses Google Flow/Veo and spends
credits. Never automatically replay a submission whose outcome is unknown.
Persist the returned media ID immediately and resume polling after interruption.

Keep the queue persistent, sequential, deduplicated, and independent of the side
panel. Preserve Story Studio clip ingestion and Downloads naming.

Before handoff, run `node --check` on every JavaScript file, parse the manifest,
confirm declared files exist, and run `git diff --check` from the parent repo.
