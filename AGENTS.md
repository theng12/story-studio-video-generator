# Story Studio Video Generator

This Manifest V3 extension is video-only. It uses Google Flow/Veo and spends credits. Never
automatically replay a submission whose outcome is unknown. Persist the returned media ID immediately
and resume polling after interruption.

Text-to-video (`YhhmEf`) and image-to-video (`MZZa6b`) are separate Flow RPCs with separate model
keys; never use a model key across the two sources.

Gateway Studio is a third, separate mode: the extension claims jobs and runs them through the same
queue. Keep gateway items tagged with `gatewayJobId` and do not route gateway work through the
studio/standalone UI paths.

Keep the queue persistent, sequential, deduplicated, and independent of the side panel. Preserve
Story Studio clip ingestion and Downloads naming.

## Owner decisions that bind

- **Price (2026-11-12).** A rate belongs to a model, never to video in general: Omni Flash 1.2 costs
  3 credits per second at 720p and 1 at 360p, for 3–10s only. A model with no rate gets no quote
  rather than borrowing another's. Flow's `Generating will use N credits` line is the primary price
  when the composer matches the job's model, ratio, resolution and length with a single output; the
  table is the fallback; on disagreement the page wins and the difference is reported.
- **Money is never guessed and never shown as zero.** An unobserved duration, an uncaptured
  resolution key, an unmapped ratio or an unknown model refuses the claim and names the missing half.
- **One video per job.** x2/x3/x4 waste credits, so the count is always one and a panel price for any
  other count never describes our work.

## Future extension and release checklist (owner, 2026-11-10)

- All three generator extensions must discover and list newly appearing models dynamically. An
  observed listing, a verified request schema, control support and a successful generation are four
  distinct evidence states; a listing proves none of the others.
- Recheck new controls and durations at each release. Carry supported controls through Story and
  Gateway; keep scene duration separate from selected/generated clip length, including on reload.
- Keep unknown request fields as inert metadata; never flatten them into queue execution state, drop
  them or default them. Refuse unsupported control mappings before submission.
- Obtain the exact Story/Gateway counterpart contract for discovery identity, observation freshness,
  control values, scene/clip duration, immutable job binding, unknown-field round-trip and refusal
  states. Do not invent that wire schema here.
- Verify each executable model/source/duration/control combination against its actual sanitized
  provider request. UI menus, quotes, labels, public bundles and historical fallback source are
  observations only; zero current captures means no current transport is proven. Keep unknown paid
  outcomes held; retained media must never be regenerated for delivery retry.
- Keep account identity and observed credits scoped to one verified account/profile, never one
  balance per extension. Configured labels are not readiness or credit evidence. Follow account-worker
  schema 1: report unbound telemetry without account identity until observed; never execute
  quoteRequired previews. Quoted claims carry same-request observed account facts and generation
  rechecks its reservation/account. Echo control revisions only after dispatch/pacing readback; keep
  OFF/cooldown/unknown holds across restart. Closing safety belongs to Gateway; never kill a browser
  or release a hold because closeRequested is set.
- Verify 5–15s default pacing, custom/zero overrides, MV3 restart deadlines, fresh-image-to-video
  gaps, eligibility before claims, cooldown holds and unknown-paid-outcome refusal with offline
  fixtures.
- Record offline checks separately from live browser/provider evidence. Stack owns that work; a
  source checkpoint does not authorize it.

Before handoff, run `node --check` on every JavaScript file, parse the manifest, confirm declared
files exist, and run `git diff --check` from this repository root.
