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
- [x] Add benchmark-provenance-aware capability ratings without presenting inferred or missing data
      as measured fact.
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
