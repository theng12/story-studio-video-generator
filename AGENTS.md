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

## Future extension and release checklist (owner, 2026-11-10)

- All three generator extensions must discover and list newly appearing models
  dynamically. Preserve observed listing separately from verified request schema,
  supported controls and successful generation; listing alone proves none of them.
- Recheck newly appearing controls and extra durations at each normal release.
  Carry supported controls through Story and Gateway; at minimum preserve scene
  duration separately from selected/generated clip length, including on reload.
- Keep unknown request fields as inert metadata; never flatten them into queue
  execution state, silently drop them or substitute a default. Refuse unsupported
  control mappings before provider submission until counterpart semantics agree.
- Obtain the exact Story/Gateway counterpart contract for discovery identity,
  observation freshness, control values, scene/clip duration semantics, immutable
  job binding, unknown-field round-trip and explicit unsupported/refusal states.
  Do not invent that wire schema in this extension.
- Verify each executable model/source/duration/control combination against its
  actual sanitized provider request. UI menus, quotes, labels, public bundles and
  historical fallback source are observations only. Zero current video request
  captures means no current video transport is proven. Keep unknown paid outcomes
  held; retained media/results must never be regenerated for delivery retry.
- Keep image/video account identity and observed credits scoped to one verified
  account/profile, never one balance per extension. Configured labels are not
  readiness or credit evidence. Follow Gateway account-worker schema 1: report
  unbound telemetry without account identity until actually observed; never execute
  quoteRequired previews. Quoted claims carry same-request observed account facts,
  and actual generation rechecks its reservation/account. Echo control revisions
  only after persisted dispatch/pacing readback; keep OFF/cooldown/unknown holds
  across restart. Closing safety belongs to Gateway; never kill a browser or
  release a hold because closeRequested is set.
- Verify default inter-generation 5–15s pacing, saved custom/zero overrides, MV3
  restart deadlines, fresh-image-to-video gaps, eligibility before claims, manual
  cooldown holds and unknown-paid-outcome refusal with offline platform fixtures.
- Record offline checks separately from live browser/provider evidence. Stack
  owns that browser/provider work; a source checkpoint does not authorize it.

Before handoff, run `node --check` on every JavaScript file, parse the manifest,
confirm declared files exist, and run `git diff --check` from this repository root.
