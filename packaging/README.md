# Local Tauri candidate packaging

This directory contains declarative inputs for a Windows x64 Tauri 2 local candidate. It contains no
production signing credential, update endpoint, publishing credential, or release automation.

`node scripts/package-sidecars.mjs` builds the Python runtime as a PyInstaller one-folder bundle,
builds the Rust ToolBroker, verifies the pinned no-weights Cupcake Local CPU baseline and signed
installable-model catalog, and atomically stages:

- protocol-test output under `out/sidecars/win32-x64/sidecars/`;
- Tauri externalBin sources under `apps/desktop/src-tauri/binaries/` using the
  `-x86_64-pc-windows-msvc.exe` suffix;
- a self-contained verified resource directory under `apps/desktop/src-tauri/resources/sidecars/`.

The runtime executable stays beside its `_internal` support directory so Windows can launch it
without extracting a one-file archive on every app start. Every support file is included in the
sidecar manifest by relative path, byte length, and SHA-256 digest. Host startup rejects missing,
changed, undeclared, linked, or out-of-root support files before it launches the runtime.

The Tauri configuration must declare `binaries/cupcake-runtime` and `binaries/cupcake-tool-broker`
as `externalBin` entries and bundle `resources/sidecars`. The verified sidecar manifest continues to
name packaged executables without a target-triple suffix.

The committed runtime catalog, model catalog, and public key are local-candidate trust inputs, not a
production trust root. The model catalog currently records Qwen3 4B, 8B, and 14B Q4_K_M variants
using immutable Hugging Face revisions, exact byte lengths, SHA-256 digests, Apache licenses,
context choices, capabilities, and runtime requirements. Model weights are never staged or bundled.

```powershell
python scripts/stage-cupcake-local.py
python scripts/stage-cupcake-local.py --verify-only
node scripts/package-sidecars.mjs
pnpm --filter @cupcakeagi/desktop bundle:nsis
node scripts/smoke-package.mjs --platform win32 --mode bundle
node scripts/release-candidate-audit.mjs --require-artifacts
```

Expected output conventions after a successful build are
`apps/desktop/src-tauri/target/release/CUPCAKEAGI.exe` and one
`apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe`. Record the exact actual paths; no
corrective artifact is currently claimed as verified.

The NSIS installer is current-user and unsigned for private local testing. Do not upload, publish,
distribute, sign for production, or configure an updater.
