# Changelog

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
