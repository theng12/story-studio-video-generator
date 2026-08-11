# Video Generator Cleanup Design

## Goal

Bring Video Generator to the same maintained standard as Image and Audio while
keeping it Flow-only: truthful signed-session model discovery, fail-closed paid
submission, minimal settings, tested recovery, and accurate Fleet/release
surfaces.

## Provider And Billing Boundary

Google Flow remains the only video provider. It uses the signed Flow website
session and consumes that website account's quota or credits. The extension must
not accept developer API keys or add a separately billed developer API route.

Remove the dead single-value `videoProvider` setting and queue field. Do not add
a provider abstraction for one provider.

## Model Discovery And Queue Snapshot

Add one read-only Flow inventory command. It may accept a model only when the
signed Flow session exposes an exact provider-owned transport key plus a user
label. It must not infer a key from a display name or ship an unverified model.

If Flow exposes no trustworthy inventory, use the current tested catalog as an
explicit fallback. The panel shows whether inventory is live or fallback and
offers a refresh from the current signed Flow workspace. A newly advertised
model appears without a release only when Flow supplies the exact key required
for submission.

Queue items snapshot the exact model key and label approved by the user. Remove
the current unknown-model-to-Fast fallback. Unknown, removed, or malformed model
keys fail before any image or video provider request.

## Paid-Work Recovery

Preserve the existing video checkpoint: persist `submitting` before the paid
request, persist the returned media ID immediately, poll a known ID without a
new submission, and require explicit duplicate-credit acceptance after an
unknown outcome.

Apply the same ambiguity boundary to the optional fresh-start-image generation.
Persist its submission phase before the request and quarantine interruption or
unknown results instead of resetting them to pending. A saved generated image
or uploaded media ID resumes from the next safe phase without regeneration.

Keep the queue persistent, sequential, paced, deduplicated, and independent of
the side panel.

## Story Studio, Standalone, And Fleet

Preserve the one-request episode list and selected-episode Scene Review load.
Keep only approved scenes with a valid image, motion prompt, and duration.
Completed project clips continue to ingest into the matching Story Studio scene;
standalone videos continue to save to Downloads.

Do not add pagination or virtualization without a measured DOM bottleneck. The
current project-load network shape is already one aggregate request and local
linear rendering; cancellation guards may prevent stale project responses from
replacing a newer selection.

Remove the proven-dead `saveTarget`, `workflowId`, and `remainingCredits`
storage. Update the side panel and documentation to describe the already-active
opt-in, signed Fleet telemetry and safe queue commands rather than "Coming
soon".

## Verification And Release

Introduce Node's built-in test runner without adding dependencies. Cover exact
model normalization, live-versus-fallback inventory, unknown-model refusal,
queue model snapshots, fresh-image interruption recovery, known-media resume,
active deduplication, Story Studio eligibility, standalone output, Fleet command
limits, manifest integrity, and release versioning.

Run all tests, `node --check` on every JavaScript file, manifest and declared-file
validation, and `git diff --check`. With a signed Flow tab, refresh the real
inventory and run one real video through submission, polling, download, and the
appropriate Story Studio or standalone save path. Bump the manifest version,
update the changelog and README, commit, and push.
