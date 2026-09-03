# 2026-09-03 model intelligence and UI pass

- [x] Replace the fixed 24 GB RAM fallback ceiling with a hardware-adaptive automatic limit and
      explain it in the UI.
- [x] Measure and reduce the unlock-to-usable startup path without eagerly starting model services.
- [x] Harmonize the opening-screen shelf palette with the randomized dreamscape.
- [x] Keep onboarding guidance centered and add provider-connection guidance with detected
      completion states.
- [x] Scope workspace wallpaper artwork to chat only and prove it changes the chat surface.
- [x] Remove unnecessary automatic-routing warnings and model-selection confirmation friction.
- [x] Group the chat picker by model publisher and hide unavailable providers by default with an
      opt-in toggle.
- [x] Verify the current NVIDIA catalog versus the connected `/v1/models` inventory and classify at
      least twenty broadly useful NIM chat models.
- [x] Remove synthetic cupcake ratings and keep only traceable model facts, task fit, and runtime
      evidence.
- [x] Replace Models-page source banners and fragmented selectors with one rich include/exclude
      filter surface.
- [x] Move global search into a slimmer VS Code-style title strip.
- [x] Seed one real capability-demonstration project and hosted conversation into the disposable
      owner test profile.
- [x] Run focused regression tests, full relevant gates, packaged build, headless native UI
      interaction, and screenshot inspection.
- [x] Commit only task-owned changes on local `master`; leave unrelated dirty files untouched.

Measured native acceptance on the owner profile: 817 ms process-to-WebView, 3.65 s
unlock-to-opening, and 22.78 s unlock-to-interactive, down from 45.67 s before the runtime freeze
was reduced from roughly 343 MB to 60.9 MB. The remaining delay is frozen core-runtime startup;
model loading, hardware scans, provider catalogs, Pydantic AI, and DBOS task execution remain
demand-loaded. The final live catalog probe returned 64 account-discoverable NIM chat candidates
and 240 Hugging Face GGUF results with no WebView errors.

## Corrective acceptance, 2026-09-03

- Migrated the owner test profile from Argon2 password unlock to the supported version 2
  `WindowsDPAPI` quick-open record. A cold packaged-app launch reached the workbench with
  `unlockMode: windows`, a ready broker runtime, and no renderer errors. Conversation, project, and
  artifact data remained present.
- Reduced the custom titlebar to 32 px and applied the randomized opening palette to both the shelf
  and titlebar. Increased chat wallpaper visibility without leaking it onto non-chat screens.
- Replaced the broad model dump with a curated task-first catalog, multi-select checkbox filters,
  explicit size tiers, complete descriptions, publisher identities, availability evidence, and an
  opt-in Hugging Face search. The picker hides unavailable and non-curated entries by default.
- Removed synthetic cupcake benchmark scores and the visible compatibility-unverified label.
  Provider identity now comes from the model publisher; NVIDIA branding is reserved for NVIDIA
  models while `via NVIDIA NIM` identifies the serving route.
- Authenticated one-token qualification passed for eight current NIM routes: four NVIDIA Nemotron
  variants plus OpenAI GPT-OSS 20B, Poolside Laguna XS 2.1, Meta Muse Glimmer 30B, and Mistral
  Nemotron. Failed, unavailable, and timed-out candidates are excluded from the default chooser.
- Fixed the NIM picker dead-end by making the qualified chat-compatible catalog directly selectable;
  unknown routes remain out of the default picker instead of requiring an invisible confirmation.

Final gates: TypeScript passed; renderer Vitest 52/52; Rust host/security 26/26; full Python runtime
suite passed; Playwright 44/44 across desktop and narrow projects; ESLint, Ruff, and Prettier passed.
The first Playwright run found a 4.44:1 dark-theme transition frame; disabling the active-navigation
color transition produced stable AA contrast and the complete rerun passed. Native acceptance and
all app launches were hidden. No GPU-model lease was acquired, and the shared marker remained
`no`.
