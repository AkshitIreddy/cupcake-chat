# Local release-candidate packaging

This directory contains declarative inputs for local CUPCAKEAGI release-candidate builds. It does
not contain signing credentials, updater endpoints, publishing credentials, or release automation.

`node scripts/package-sidecars.mjs` builds the Python runtime with PyInstaller and the Rust broker
with Cargo on Windows x64. It writes both native executables and a checksummed
`sidecars.manifest.json` to `out/sidecars/win32-x64/sidecars/`. The same command downloads the exact
pinned official llama.cpp Windows x64 CPU ZIP, verifies GitHub's published SHA-256 plus every
catalogued file, executes `llama-server.exe --version`, and stages it as the no-weights Cupcake
Local CPU baseline. Electron Forge copies that final `sidecars` directory into its packaged
resources with the same name. Windows 10 and Windows 11 on x64 are the only release-candidate
targets; other operating systems and architectures are rejected by the Forge configuration.

The committed runtime catalog and public key under `packaging/catalogs/` are explicitly for this
local release candidate. They are **not a production signing root**. The matching Ed25519 private
key exists only in ignored `.secrets/` local state. A future published release must replace this
catalog and trust root through a controlled production signing process. No GGUF/model weights are
downloaded, staged, or bundled by the packaging command.

To stage or independently verify only the CPU baseline on Windows:

```powershell
python scripts/stage-cupcake-local.py
python scripts/stage-cupcake-local.py --verify-only
```

When the two native sidecars are already current, an incremental RC restage can preserve them while
refreshing and re-verifying Cupcake Local plus the aggregate manifest:

```powershell
node scripts/package-sidecars.mjs --no-clean --reuse-native
```

`node scripts/setup-fixtures.mjs --clean` creates deterministic, disposable integration fixtures
below `out/test-fixtures/`. The source templates contain no credentials and are never used as live
application data.

`node scripts/release-candidate-audit.mjs --require-artifacts` is the final local gate. It checks
versions, manifests, forbidden tracked state, workflow permissions, publishing/update configuration,
staged sidecar integrity, and the packaged desktop layout. It never uploads or publishes an
artifact.
