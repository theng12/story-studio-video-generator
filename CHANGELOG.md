# Changelog

## 1.3.28 — 2026-11-13
- The side panel uses the same system as the image panel: 4/8/12/16 spacing, 32 px controls, 10 px radii, 11 px uppercase section titles, single-column full-width fields, and Queue video as the only primary action. Gateway keeps "Connected through Relay" under its own section title. Behaviour, ids and colours unchanged.

## 1.3.27 — 2026-11-13
- Contrast and layering pass: stronger borders in light and dark, and every text, muted, accent, primary-button and status pair measures at least 5.1:1 in both themes.

## 1.3.26 — 2026-11-13
- The Gateway pane says "Connected through Relay · <machine>" when Relay seeded this browser, marks the URL and token read-only while Relay owns them, and shows the shared readiness reason when Flow is not ready.

## 1.3.25 — 2026-11-13
- The manifest carries a fixed key, so the extension id and its storage survive versioned folders.

## 1.3.24 — 2026-11-13
- Gateway mode can reach the Gateway again: the loopback host permissions are restored, and a test fails if Gateway mode ships without them.

## 1.3.23 — 2026-11-13

- Only Standalone (default) and Gateway Studio remain. The old Story Studio mode and its connection,
  project picker and ingest UI were removed.
- A stored Studio choice moves to Standalone on load; nothing asks the user to choose again.
- Pending Studio queue rows now save to Downloads instead of being dropped.

## 1.3.22 — 2026-11-13

- Flow RPC ids are no longer hard-coded in the shipped command: a MAIN-world recorder learns them from the live page's batchexecute exchanges, with the captured ids kept only as editable fallback values in Settings (Flow request ids, advanced).
- An id that cannot be resolved is named with what was tried; the worker start probe reports "Account probe failed: …" and leaves manual work usable.
- Tests simulate a changed id, discovery falling back, and both failing, without expecting any fixed id.

## 1.3.21 — 2026-11-13

- A visibly signed-in Flow project whose account fields are missing claims with an unknown balance instead of refusing; the price quote still gates any spending.
- The panel names a failed account read ("Flow is open but Relay could not read the account (<error>). Retrying on the next check") instead of looking signed out.

## 1.3.20 — 2026-11-12

- Google Flow settings were removed; the address is fixed.
- The options page now keeps only the mode/provider, the Gateway Studio block, and the mode-conditional Story Studio connection.

## 1.3.19 — 2026-11-12

- Fleet Hub was removed.

## 1.3.18 — 2026-11-12

- Veo 3.1 - Lite no longer borrows Omni Flash 1.2's rate: Flow's own panel quoted 10 credits for one 8s 720p clip, not the 24 that rate would give, so its price now comes only from the panel line.
- One video per job is an explicit constant. A panel price for x2, x3 or x4 outputs never describes our work, because we never ask for more than one.

## 1.3.17 — 2026-11-12

- The selected model is read from the panel's model dropdown and the ratio from its checked chip, both confirmed against a live panel dump rather than guessed attributes.

## 1.3.16 — 2026-11-12

- The selected ratio is read from the settings trigger's own line, which a real capture shows reads `Video · 720p · 8s` / `crop_16_9` / `x2`, instead of guessing at a pressed-chip attribute.
- That capture also shows the video trigger carries no model name, so the selected model must come from a marked control in the open panel; without one the panel price is not used.

## 1.3.15 — 2026-11-12

- A panel price is used only when the composer's model and ratio also match the job, read from the settings trigger and the selected ratio chip. A stale model or ratio falls back to the rate table, and to a refusal when the table cannot price the job either.

## 1.3.14 — 2026-11-12

- The page price source is named `flow.panel.price` and the line is matched through wrapped whitespace and casing.
- A missing panel plus an unpriced job refuses the claim instead of quoting zero, and a page/table disagreement is covered by a background test that fails without it.

Earlier releases are in `git log`.
