# Changelog

## 1.3.14 — 2026-11-12

- The page price source is named `flow.panel.price` and the line is matched through wrapped whitespace and casing.
- A missing panel plus an unpriced job refuses the claim instead of quoting zero, and a page/table disagreement is covered by a background test that fails without it.

## 1.3.13 — 2026-11-12

- The quote now comes from Flow's own "Generating will use N credits" line when the composer is set to the same model, ratio, resolution, length and single output as the job. The rate table answers only when that line is missing, and a disagreement between them is reported with the page's number used.

## 1.3.12 — 2026-11-12

- Flow's own name for Omni Flash 1.2 text-to-video, `veo_3_1_t2v_lite`, is now priced alongside this extension's catalogue key at the same rates, so a Gateway job using either naming gets its quote instead of being refused for want of a price.

## 1.3.11 — 2026-11-12

- A refused preview now says which part is missing — an unpriced model, an uncaptured resolution key, an out-of-range length, or an unreadable balance — instead of a generic message.

## 1.3.10 — 2026-11-12

- A 360p Gateway job is refused at claim until a 360p model key is captured. The 360p rate is known, but quoting it would name one price and submit the captured 720p key, which costs three times as much.

## 1.3.9 — 2026-11-12

- The credit rate belongs to a model, not to video: only the two Omni Flash 1.2 keys are priced, at 3 credits per second at 720p and 1 per second at 360p for the 3–10 second options. Any other model gets no quote instead of borrowing Omni's rate.

## 1.3.8 — 2026-11-12

- Quotes now follow the owner's price rule instead of a fixed table: Omni Flash 1.2 costs 3 credits per second at 720p and 1 credit per second at 360p, for the 3–10 second options.
- A duration outside 3–10 seconds, or a resolution with no observed rate, gets no quote rather than a guessed price.
- Gateway jobs may carry a `resolution`; it is priced, and no captured Flow request field transmits it yet.

## 1.3.7 — 2026-11-12

- Account readiness now follows the page: a signed-in worker with an unreadable balance is ready and reports its balance as unknown, not zero. Only a known zero balance is unready.
- A 9:16 Gateway job is refused at claim instead of being claimed and failing at submit; Flow's 9:16 value has not been observed.

## 1.3.6 — 2026-11-12

- The read-only account and quote inspector now reads Flow's captured `nzlxg` credit RPC and binds an opaque page-provided identity, so Gateway claims have an observed account instead of none.
- A clip length with no observed price gets no quote, and an unreadable balance stays unknown rather than becoming zero.

## 1.3.5 — 2026-11-11

- Manager pauses and pacing stay saved after restart. Resume and close acknowledgements reflect the settings actually applied.
- Account readiness and credits remain unknown until observed from the provider; a configured profile label never authorizes spending.
- A job preview cannot generate a video. Paid work needs an exact observed quote and matching account reservation.
- Checking status during active generation keeps that work active; uncertain work stays held for review.
- A Gateway job bigger than the size Gateway itself advertises is refused before it is saved or run.
- Connected to Gateway, the extension keeps showing its state in Studio and Standalone modes too — stopped, never taking work — so Gateway can always see and stop it.

## 1.3.4 — 2026-11-11

- New settings use a random 5–15-second pause between generations, with no first-job delay. Existing custom pauses, including zero, stay saved.
- Pauses survive extension restarts and hold new Gateway claims until eligible; polling and saved-result delivery do not create another pause.
- Shared account profile labels can match the image and video extensions. Unknown sign-in, credits and reset times stay unknown.

## 1.3.3 — 2026-11-10

- Clip length stays with your model choice, saved settings and queued videos.
- Unverified model and length combinations stop before using credits instead of generating a different length.
- Historical model choices stay visible, but new generation waits for a verified current request mapping in every mode. Workspace observations do not silently change your selection.
- Gateway keeps unsupported request fields for review and stops before generation rather than silently ignoring them.

## 1.3.2 — 2026-11-10

- Finished Gateway videos stay saved until Gateway accepts them. Retrying delivery does not generate another video.
- Interrupted or uncertain Gateway jobs stay held for review, including after restarting the extension.
- Gateway connection checks report invalid replies and use the worker identity returned by the signed-in connection.
- Gateway image-to-video keeps its supplied reference instead of generating a replacement image.
- Saving connection settings preserves the connected worker. Connection checks do not request new work, and Claim now shows failures.

## 1.3.1

- Added the captured Omni 1.2 Flash models: text-to-video 4s (`macaron_cookie_t2v_4s`) and image-to-video 3s (`macaron_cookie_r2v_3s`). Length is part of the model key.

## 1.3.0

- Added a third, separate Gateway Studio mode: the extension claims jobs from the gateway, runs them through the existing queue, and returns the finished clip. Studio and standalone modes are unchanged.
- Added the worker protocol client (`gateway-client.js`) and pure job mapping (`gateway-worker.js`).

## 1.2.0

- Ported Google Flow to the current app: text-to-video and image-to-video, status polling, and signed video download.
- Removed the retired labs.google REST/session endpoints and the dead API host permission.

## 1.1.1

- Made the Google Flow address editable in Settings with a site-access grant, so a future Flow move is a paste instead of a code change.

## 1.1.0

- Added signed Flow model inventory discovery with tested fallback provenance and fail-closed exact model snapshots.
- Added fresh-image review and paid-video ambiguity recovery so unknown submitted work is never replayed automatically.
- Removed dead video settings and documented maintained Story Studio, standalone Downloads, and opt-in Fleet controls.

## 1.0.25

- Added a paste, review, and approval flow for standalone video prompts.

## 1.0.24

- Kept the compact queue-action row visible and added a consistent Clear pending control.

## 1.0.23

- Restored Standalone mode for local video prompts, with completed files saved to Downloads.

## 1.0.22

- Aligned the side-panel workflow with Image Generator: Provider settings,
  Generation workspace, Queue pacing, then Fleet Hub.
- Added a quiet Fleet Hub “Coming soon” disclosure; Video queue controls remain local.

## 1.0.21

- Hide the Update Studio URL recovery action while a fresh Studio connection
  test is in progress; it reappears only if that test fails.

## 1.0.20

- Replaced the expandable connection card with the shared always-visible
  connection layout, including consistent sign-in guidance and feedback.

## 1.0.19

- Aligned Video Generator's primary, link, and focus colors with its teal icon
  identity.

## 1.0.18

- Standardized Settings with the shared full-width primary Save action.

## 1.0.17

- Removed duplicated workspace, provider, and pacing controls from global
  Settings; those batch-specific choices now live only in the side panel.

## 1.0.16

- Added site-access and connection testing to Story Studio Settings.
- Added direct failed-connection recovery to the Studio URL setting and aligned Settings layout.

## 1.0.15

- Standardized the Video panel controls, disclosures, and toolbar.

## 1.0.14

- Made Story Studio the only completed-video destination.

## 1.0.13

- Removed the external prompt workflow; video generation now uses Story Studio scenes.

## 1.0.12

- Standardized the workspace action button.

## 1.0.11

- Updated Story Studio workflow controls.

## 1.0.10

- Combined queue pacing controls into one section.

## 1.0.9

- Corrected the generation workspace and provider settings hierarchy.

## 1.0.8

- Added a compact applied queue-settings summary.

## 1.0.7

- Added a Studio connection test in the side panel.

## 1.0.6

- Clarified the provider settings hierarchy.

## 1.0.5

- Standardized the provider cooldown controls.

## 1.0.3

- Standardized the primary video setup controls.

## 1.0.2

- Added queue pacing, cooldown, and recovery controls.

## 1.0.1

- Updated product naming and simplified public metadata.

## 1.0.0

- Initial video generation release.
- Guided generation from Story Studio scenes.
- Saves completed assets to Story Studio.
