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
The fallback catalog preserves historical Omni 1.2 Flash and Omni Flash model and
length references from the prior implementation. These are not evidence of the
current video transport or live availability. Every mode refuses new image/video
work until a current video request mapping is verified; historical references
preserve selections only. Known video IDs and retained Gateway bytes still use
their existing recovery/delivery paths without generating again.
Choose a clip length in Provider settings; that choice persists with the model
and every queue row. For Story scenes this is the generated clip length; the scene
timeline length is retained separately. An unsupported combination is refused
before any fresh-image or video submission. Neither labels nor key suffixes are
used to invent another backend ID or duration binding.

Refreshing can report the visible workspace's selected length, resolution and
output count as UI observations. Those observations do not change your selection
or authorize new lengths. The reported Omni 1.2 Flash 3–10s UI range still needs
sanitized text/image request captures pairing each exact key and RPC payload with
its selected duration, aspect, resolution and output count. Until those mappings
and live availability are captured, the corresponding combinations remain
unavailable, and Gateway keeps its existing live-inventory refusal.

## Discovery and control parity: future releases

The owner requires all three generator extensions to list new models dynamically
and carry newly supported controls and durations through Story and Gateway. This
is a release requirement, not a claim that current live discovery is implemented.
The maintained checklist is in `AGENTS.md`. An observed listing, a verified request
schema, control support and a successful generation are distinct evidence states.

Story scene timeline duration is retained separately from the selected clip
length. Unknown Gateway request fields are retained as inert `unmappedFields` on
the queue row and refuse new provider work; they never become executable queue
state or silently disappear. Existing known media and retained delivery bytes do
not regenerate because new metadata is present.

The missing Story/Gateway counterpart contract must define discovery identity
and freshness, each control's type/value domain, scene-versus-clip duration,
immutable job binding, unknown-field round-trip and unsupported/refusal reporting.
No new wire schema or model/duration IDs are inferred here. Current video request
capture and live acceptance remain missing and owned by Stack.

## Account labels and generation pacing

Settings and the side panel edit the same saved pause range (0–3600 seconds).
New settings default to a random 5–15-second pause; existing custom
ranges, including 0–0, are retained. The first generation starts without a pause.
The worker saves its sampled pause before each actual image/video submission and
retains it through recovery, then starts the gap when that work finishes. A freshly
generated start image also pauses before its video; it is not generated again.
Future deadlines survive MV3 restarts and wake through Chrome alarms. Alarm timing
is earliest eligibility, not a promise of an exact start time. Provider cooldowns
remain separate, including manual review holds. Known-media polling and saved-result
delivery bypass new-generation waits and do not create an unrelated new pause.
Gateway checks eligibility before claiming; uncertain paid work remains held.

The optional shared account profile ID is a configured label: use one ID for the
same image/video browser account/profile. Local `getQueue` telemetry returns
`manager.account` (`profileId`, `identitySource`, and unknown `ready`, `creditBalance`,
`creditResetAt`), `manager.pacing` (`minimumSec`, `maximumSec`, `nextGenerationAt`,
`cooldownUntil`, timestamps in epoch milliseconds), and observed `manager.inventory`.
No account readiness, credit balance or reset time is inferred from a label.

Gateway account-worker schema 1 now adds authenticated `/api/workers/telemetry`
readback and `control` on health, telemetry and claim replies. Desired dispatch,
close and pacing are saved locally; a revision is echoed only after actual dispatch
and pacing readback matches. OFF survives restart and local Resume cannot override
it. A paired worker keeps reporting in Story and Standalone modes; only Gateway
mode may claim jobs. The manager's initial default range does not overwrite an existing custom range:
actual pacing is reported, dispatch stays off and the unmatched revision is not
acknowledged until a subsequent explicit control matches or changes it. Unsupported
ranges above this extension's displayed 3600-second limit are refused without ack.
Provider cooldowns remain authoritative; fractional custom ranges also persist.

External state reports connection/sign-in/readiness independently from actual
activity, enabled/paused state, control revision, pacing and next eligibility as
zoned ISO timestamps. Unknown claims and active/recovering work never report an
idle close acknowledgement. `closeRequested` never closes Chrome, cancels work,
releases a hold or replays paid work; Gateway owns `safeToClose` and account-wide
reservation/spending switches. New/missing dispatch control remains OFF. No app-only
account enablement or manager token operation is called by the extension.

A configured profile ID is never transmitted as provider account identity. The
read-only Flow account/quote inspector currently returns unknown because no exact
provider identity/quote mapping has been captured; external telemetry therefore
omits `account`. No account readiness, balance, reset, plan or buckets are invented.
An observed stable opaque provider account, fresh matching state/revision and an
exact observed provider quote are required before a new executable Gateway claim.
`quoteRequired.job` is an UNCLAIMED preview with `executionAuthorized:false`, never
queued or generated. The quoted claim sends actual account observations in that
same request, then verifies returned account/reservation and rechecks the signed-in
account before provider actions. Known media and retained result delivery keep their
recovery paths. Gateway remains the sole authentication/queue/artifact authority;
its real enabled-account switch is never inferred from a quote or profile label.
This source adoption is offline-tested, not installed/live qualification.

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
