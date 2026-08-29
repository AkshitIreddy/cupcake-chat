# CUPCAKEAGI 2.0 local RC handoff

**Updated:** 2026-08-29 UTC **Branch:** `feat/cupcakeagi-2.0` **Scope:** Windows 10/11 x64 only
**Distribution policy:** local unsigned test artifacts only. Do not push, publish, create a release,
or configure an updater without explicit owner approval.

This document replaces the previous pause checkpoint. Final local validation is complete, Git
history and the `v1.0.0` tag preserve the original product, and the 2.0 work remains on the local
branch for owner testing.

## Completed release-candidate work

- Rebuilt the Windows frozen Python runtime, Rust broker, unpacked Electron app, Squirrel installer,
  and portable ZIP.
- Added atomic sidecar staging, promotion, and rollback so a failed build cannot replace the last
  complete Python/Rust sidecar set.
- Fixed cross-language canonical JSON coverage for ECMAScript number thresholds and UTF-16
  object-key ordering; non-string keys now fail closed.
- Fixed the live NIM path: the renderer accepts the catalog's metadata-shaped capability fields,
  valid memory states no longer abort bootstrap, unknown NIM limits get an explicitly disclosed safe
  planning envelope, and the provider catalog is cached/coalesced rather than refreshed per chat.
- Added runtime-enforced acknowledgement for NIM models whose chat compatibility is unverified. The
  acknowledgement is stored as product state; direct settings writes cannot bypass the picker flow.
- Added retry only for idempotent cold-start `runtime.health` and `app.bootstrap` reads. It never
  retries a chat, tool, task, approval, or other side-effecting request.
- Changed normal desktop shutdown to request a signed broker/runtime shutdown before escalating to
  stdin close, `SIGTERM`, and only then `SIGKILL`.
- Cleared the strict Pyright backlog under the declared runtime configuration.
- Completed live packaged-app checks for hosted NVIDIA NIM and local LM Studio GPU inference.

## Live packaged-app evidence

An unpacked package was exercised with disposable Windows-DPAPI-backed profiles and the
user-authorized NVIDIA NIM credential. The hosted NIM flow:

1. opened the encrypted workspace;
2. detected the configured NIM provider and its 66 safe catalog entries;
3. required explicit compatibility acknowledgement for `nvidia/nemotron-3-nano-30b-a3b`;
4. showed the bound NVIDIA cloud disclosure with no files, references, memories, or tools; and
5. rendered an exact three-bullet response with the requested equation and correct arithmetic; and
6. exposed no private reasoning trace after the adapter disabled the model's visible thinking mode.

The same packaged renderer discovered LM Studio, loaded `google/gemma-3n-e4b` on the local NVIDIA
GPU, sent a real chat through the CUPCAKEAGI local route, and rendered the response in the UI.
Separate direct LM Studio testing with Qwen 9B measured approximately 36.8 generated tokens per
second on this machine.

Rendered evidence is retained locally:

- `out/live-ui/nim-confirmation.png`
- `out/live-ui/nim-chat.png`
- `out/live-ui/quality-suite.png`
- `out/live-ui/gpu-local-chat.png`

The profile is encrypted (`profileEncrypted: true`) and the credential remained broker-owned. No key
appears in Git, source, screenshots, command output, or this handoff.

## GPU coordination

`C:\Users\akshi\Desktop\Code Palace\gpu use.txt` ends at `no`. The GPU validation was coordinated by
setting it to `yes` immediately before local inference and restoring it to `no` after unload. No
model remains loaded and the LM Studio server is stopped. The live NIM test used NVIDIA's hosted
API; the Gemma and Qwen checks used the local NVIDIA GPU.

## Local test artifacts

- Unpacked app:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\CUPCAKEAGI-win32-x64\CUPCAKEAGI.exe`
- Installer:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\make\squirrel.windows\x64\CUPCAKEAGI-Setup.exe`
- ZIP:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\make\zip\win32\x64\CUPCAKEAGI-win32-x64-2.0.0-rc.1.zip`
- Disposable live profile: `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\out\live-ui-dpapi-profile`

The installer and ZIP were rebuilt, the make-mode package smoke passed, and the release-candidate
artifact audit passed. An isolated installer lifecycle test completed without installing into the
normal system-wide location: clean silent install passed; after closing the test app, clean
reinstall passed; and `Update.exe --uninstall -s` exited 0, removed the installed app/launcher
executables, and preserved `out/installer-rc-20260829/profile-retention/cupcake.db`. Normal Squirrel
`.dead`/Update cleanup residue remained. A same-version silent reinstall attempted while the test
app was running hung and had to be terminated; see
[known issues](known-issues.md#running-app-same-version-reinstall). Use only a disposable profile
while owner-testing. See [local testing](local-testing.md) for the complete checklist.

## Verification evidence

Passed in the current source/package pass:

- Prettier, ESLint, TypeScript typecheck, and 138 unit tests.
- Strict Pyright, Ruff, and the full Python runtime suite.
- 22 Playwright tests across normal/narrow layouts, all four themes, keyboard flows, and automated
  accessibility checks.
- Rust formatting, Clippy with warnings denied, and 98 broker tests passing (one intentional
  AppContainer probe ignored), plus process and contract suites.
- Atomic sidecar promotion/rollback, authenticated frozen sidecar smoke, seeded protocol/local-model
  discovery, persistent-profile method matrix, package and make smoke, and RC audit.
- Isolated clean silent install/reinstall/uninstall lifecycle, executable cleanup, and profile
  retention; running-app same-version reinstall remains a known issue.
- Packaged live NIM and local LM Studio GPU conversations, with visual inspection of the completed
  chat frames.

## Remaining boundary

No automated release gate is currently known to be failing. The remaining gate is owner acceptance
of the unpacked app and unsigned installer. Passing local validation does not authorize
distribution, publication, or an updater.

## Owner acceptance next steps

1. Launch the unpacked app with a disposable profile and use the app normally.
2. Repeat the unsigned installer lifecycle on the desired clean Windows test machine and test a
   supported upgrade between different candidate versions. Do not start a same-version silent
   reinstall while CUPCAKEAGI is running.
3. Check backup/restore, migration preview, recovery, and any additional local-model workflow only
   when GPU ownership has been coordinated.
4. Do not distribute or publish any artifact until explicit approval.

The old `write-the` MkDocs generator remains historical at the `v1.0.0` tag and is intentionally not
migrated into 2.0.
