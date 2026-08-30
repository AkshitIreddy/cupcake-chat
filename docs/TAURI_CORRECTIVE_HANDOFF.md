# CUPCAKEAGI 2 Tauri corrective handoff

Paused on 2026-08-30 at the user's request. This is the exact local checkpoint for the next session.

## Safe stopped state

- No `CUPCAKEAGI`, `llama-server`, CUPCAKE runtime, broker, Cargo, Rust, or NSIS process from this work is running.
- `C:\Users\akshi\Desktop\Code Palace\gpu use.txt` is `no`.
- The final NSIS build was interrupted during installer compression after the latest host executable had compiled. Treat the current installer as unverified and rebuild it before using it.
- No release, push, or remote deployment was performed.
- Work is saved on the local default branch. The user-owned `NEXT_AGENT_TAURI_HANDOFF.md`, `docs/PAUSED_HANDOFF.md`, and `see me` changes remain outside the checkpoint commits.

## Completed implementation

- Replaced the Electron desktop host with Tauri 2 and a narrow sidecar command surface.
- Added packaged runtime and broker sidecars, signed runtime/model catalogs, managed downloads, activation, recovery actions, provider onboarding, and Windows/NVIDIA runtime selection.
- Added an NVIDIA-first ladder: CUDA 13.3 for driver 580+, CUDA 12.4 for older supported NVIDIA drivers, Vulkan fallback, and CPU baseline.
- Added in-process NVML hardware detection and protected baseline seeding so startup does not overwrite an active GPU runtime.
- Added retry handling for transient Windows atomic-state and Rust build file-sharing failures.
- Increased the Tauri request ceiling to 300 seconds so the 180-second local-model readiness window can finish.
- Gave the 2.0 installer a distinct `CUPCAKEAGI 2` identity so testing does not collide with the legacy per-user install or its credential data.
- Added resumable packaged-local-model and safe NSIS lifecycle harnesses. All child Windows processes are configured to run hidden.

## Verification already completed

- Python runtime: 382 passed, 1 skipped on the full run; latest focused regressions passed; Ruff passed; Pyright reported 0 errors.
- Renderer: 7 files and 38 tests passed; TypeScript typecheck passed.
- Tauri host: 20 tests passed; Rust formatting check passed.
- Earlier full gates: 111 JavaScript tests, 28 Playwright tests, 103 broker tests with 1 ignored, contract generation, sidecar protocol, and package smoke passed.
- The exact frozen runtime/broker sidecars were rebuilt, staged, and their help/protocol paths verified after the Windows state-file fixes.
- A signed Qwen3 8B model download completed with checksum verification and resumable recovery evidence. Its 5,027,783,488-byte file is intentionally preserved in the disposable profile to avoid downloading it again.
- CUDA 13 runtime installation and activation succeeded. The model process launched and allocated about 4.99 GB, but the prior 120-second host ceiling terminated that acceptance run before readiness. The 300-second fix is in source and the latest executable, but the full acceptance sequence still needs a clean rerun.

## Preserved local evidence

- Disposable profile: `out/tauri-test-profiles/packaged-local-final-20260830`
- Acceptance evidence: `artifacts/screenshots/packaged-local-final-20260830`
- Latest executable: `apps/desktop/src-tauri/target/release/CUPCAKEAGI.exe`
- Installer target: `apps/desktop/src-tauri/target/release/bundle/nsis/CUPCAKEAGI 2_2.0.0-rc.1_x64-setup.exe`

The executable contains the 300-second host-timeout fix. The installer target must not be considered final until it is rebuilt and smoked because compression was interrupted.

## Resume order

1. Confirm the GPU marker is `no` and no CUPCAKEAGI/model process is running. Set the marker to `yes` immediately before AI-model testing.
2. Run `pnpm --filter @cupcakeagi/desktop bundle:nsis` headlessly and let NSIS finish.
3. Run the package smoke and release-candidate audit against the newly produced installer.
4. Resume `scripts/accept-packaged-local-model.mjs` with the preserved profile. Verify CUDA 13 remains active, then complete model readiness, benchmark, offline chat, unload, and removal while reviewing the screenshots.
5. Stop every model/runtime process and return the GPU marker to `no` immediately after AI-model testing.
6. Run `scripts/test-nsis-lifecycle.mjs` for the new 2.0 identity. It must install, first-run with a disposable profile, uninstall, and preserve that profile without touching the legacy `CUPCAKEAGI` record or directory.
7. Run the full final validation gates and update the implementation checklist with only evidence actually observed.

## Still external or separately required

- Clean Windows 10 and Windows 11 installation checks.
- A real two-version upgrade test once two signed 2.x installers exist.
- Owner acceptance and any eventual release/publish decision.
