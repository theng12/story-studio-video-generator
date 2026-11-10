# Story Studio Video Generator

This Manifest V3 extension is video-only. It uses Google Flow/Veo and spends
credits. Never automatically replay a submission whose outcome is unknown.
Persist the returned media ID immediately and resume polling after interruption.

Text-to-video (`YhhmEf`) and image-to-video (`MZZa6b`) are separate Flow RPCs
with separate model keys; never use a model key across the two sources.

Gateway Studio is a third, separate mode: the extension claims jobs and runs
them through the same queue. Keep gateway items tagged with `gatewayJobId` and
do not route gateway work through the studio/standalone UI paths.

Keep the queue persistent, sequential, deduplicated, and independent of the side
panel. Preserve Story Studio clip ingestion and Downloads naming.

Before handoff, run `node --check` on every JavaScript file, parse the manifest,
confirm declared files exist, and run `git diff --check` from this repository root.
