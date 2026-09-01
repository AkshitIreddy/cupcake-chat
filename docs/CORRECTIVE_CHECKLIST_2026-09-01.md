# CupcakeAI corrective checklist — 2026-09-01

This file records the owner's current acceptance list. An item is complete only with behavioral
evidence; visual items also require inspected screenshots.

- [x] Explain and implement an honest encrypted-workspace unlock experience.
- [x] Recompose the landing-page idle-task state; the current placement feels detached.
- [x] Replace the hard-coded Tasks sidebar count with meaningful live state.
- [x] Redesign and behavior-check the Artifacts page.
- [x] Verify llama.cpp VRAM overflow/offload behavior, prefer RAM fallback when safe, and expose the
      chosen memory profile in the model UI.
- [x] Rename all user-facing and packaged branding from CUPCAKEAGI/Cupcake AGI to
      CUPCAKEAI/CupcakeAI without renaming the repository yet.
- [x] Make CUDA 13 acceleration installation complete for the Windows test build.
- [x] Wire the Permission policy control to a real policy surface.
- [x] Add an explicit, high-friction Full freedom permission mode and make the selected policy
      effective at the broker boundary.
- [x] Repair the Models page Find a model control and verify filtering at wide and narrow widths.
- [x] Wire Chat model picker's Manage models action to the Models page.
- [x] Audit all primary buttons and remove or wire inert controls in the reported surfaces.
- [x] Distinguish real model downloads from stale/fixture progress and repair any false
      "Downloading" presentation.
- [x] Run renderer QA headlessly and inspect screenshots.
- [x] Run the packaged Tauri app through a genuinely hidden test path if possible; otherwise move
      only the task-owned window to a secondary display and disclose that fallback.

## Evidence

- Real empty-workspace renderer captures: `artifacts/screenshots/corrective-20260901/after-empty-live/`.
- Hidden packaged captures: `artifacts/screenshots/packaged-hidden-corrective-20260901/`.
- The packaged Win32 probe observed the 1456 x 929 Tauri window as `Visible: false` before and after
  interaction; only two 16 x 16 framework helper windows were visible.
- The packaged Qwen3 8B card reported `Status Installed` with no active progress/checksum chrome.
- The disposable profile reported the verified b10679 CUDA 13 runtime as active.
- The real Qwen3 8B CUDA test returned the exact acceptance response at about 53.81 generated
  tokens/second; the GPU coordination marker was restored to `no`.
- Renderer: 7 test files and 40 tests passed; TypeScript typecheck passed.
- Broker: 105 library tests passed, 1 intentional Windows probe ignored; package protocol and build
  smoke passed.
- Runtime-focused tests: 34 local-model and legacy-migration tests passed.
