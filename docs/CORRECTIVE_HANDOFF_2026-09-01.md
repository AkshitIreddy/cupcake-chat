# CupcakeAI corrective handoff - 2026-09-01

> The later password, provider, runtime, and normal-profile work is recorded in
> `READY_TO_CHAT_HANDOFF_2026-09-01.md`. The Windows-session-only gate described below has been
> replaced by a CupcakeAI-owned password lifecycle.

The owner's empty installed workspace is the acceptance target. Populated fixture documents are not
evidence for the installed app.

## Current local state

- Branch: `master` (all work is local; no feature branch was created and nothing was pushed).
- Test executable: `apps/desktop/src-tauri/target/release/CupcakeAI.exe`.
- Large build outputs and disposable model profiles are junctioned into `E:\temp`.
- GPU coordination marker was restored to `no`; no AI-model test remains active.
- Repository compatibility identifiers such as `@cupcakeagi`, `com.cupcakeagi.desktop`, the legacy
  data directory, authenticated sidecar handshake, and backup AAD remain intentionally unchanged.
  They are storage/protocol identities, not current product branding.

## Corrective result

- The live Tauri workspace stays unmounted until the user unlocks it with the current Windows
  session. The screen accurately explains DPAPI rather than pretending an unconfigured app password
  protects the existing SQLCipher/object keys.
- Empty Home and Artifacts states are intentional and useful. The Tasks badge derives from active
  records and disappears at zero.
- Models search and model-picker management work. Terminal download records no longer display as an
  active Qwen download, and picker status labels are exact.
- Managed llama.cpp uses automatic GPU-layer fit with 1024 MiB VRAM headroom and hybrid system-RAM
  fallback. The Models UI describes the slower CPU/RAM outcome.
- The signed b10679 CUDA 13 pack is verified and active in the disposable Windows profile. Real
  Qwen3 8B inference on the RTX 4080 Laptop GPU passed.
- Permission policy opens a real broker-backed dialog. Full freedom requires typing `FULL FREEDOM`,
  persists in the encrypted security store, skips approval prompts, and still honors explicit deny
  rules. Guarded mode can be restored immediately.
- Reported and nearby inert controls were repaired, including tool search, Memory add/scope filter,
  project context help, task traces, developer event filtering/export/copy, and model management.
- User-facing and packaged product branding is CupcakeAI. Compatibility identifiers and explicit
  original Cupcake 1.0 migration boundaries are retained.

## Acceptance evidence

- Hidden packaged screenshots: `artifacts/screenshots/packaged-hidden-corrective-20260901/`.
- Renderer screenshots at wide and narrow widths:
  `artifacts/screenshots/corrective-20260901/after-empty-live/`.
- CUDA runtime evidence: `artifacts/runtime/headless-local-fit-20260901.json`.
- The Win32 top-level-window probe observed the task-owned 1456 x 929 Tauri window as hidden before
  CDP attachment and after all interactions. Two WebView2/Tao 16 x 16 helper windows existed at
  `(0, 0)`; no user-sized app window was visible.

## Verified gates

- Renderer tests: 40 passed across 7 files; TypeScript typecheck passed.
- Runtime focused tests: 34 passed.
- Broker library tests: 105 passed, 1 ignored probe; rustfmt passed.
- Sidecar authenticated protocol passed with 7 models.
- Build-mode package smoke passed for `CupcakeAI.exe`, two sidecars, and the CPU baseline.
- Packaged hidden UI had no page errors and no current AGI branding in its rendered body.

The NSIS installer was not rebuilt in this corrective pass. Before calling a distributable installer
current, build `CupcakeAI 2_2.0.0-rc.1_x64-setup.exe`, then rerun package smoke, release-candidate
audit, and the isolated NSIS lifecycle harness.
