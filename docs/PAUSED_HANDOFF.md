# CUPCAKEAGI 2.0 local RC handoff

**Updated:** 2026-08-29 UTC **Branch:** `feat/cupcakeagi-2.0` **Scope:** Windows 10/11 x64 only
**Distribution policy:** local unsigned test artifacts only. Do not push, publish, create a release,
or configure an updater without explicit owner approval.

This document replaces the previous pause checkpoint. Git history and the `v1.0.0` tag preserve the
original product; the 2.0 work remains on the local branch.

## What was completed in this resumed pass

- Rebuilt the Windows frozen Python runtime, Rust broker, unpacked Electron app, Squirrel installer,
  and ZIP package.
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

## Live packaged-app evidence

An unpacked package was exercised with a disposable, Windows-DPAPI-backed profile and the
user-authorized NVIDIA NIM credential. The renderer:

1. opened the encrypted workspace;
2. detected the configured NIM provider and its 66 safe catalog entries;
3. required explicit compatibility acknowledgement for `nvidia/nemotron-3-nano-30b-a3b`;
4. showed the bound NVIDIA cloud disclosure with no files, references, memories, or tools; and
5. rendered the live assistant response `LIVE NIM UI OK`.

Rendered evidence is retained locally:

- `out/live-ui/nim-confirmation.png`
- `out/live-ui/nim-chat.png`

The profile is encrypted (`profileEncrypted: true`) and the credential remained broker-owned. No key
appears in Git, source, screenshots, command output, or this handoff.

## GPU coordination

`C:\Users\akshi\Desktop\Code Palace\gpu use.txt` is currently `no`. No local model was downloaded or
loaded and no NVIDIA GPU inference was performed. The live NIM test used NVIDIA's hosted API. Before
any future NVIDIA GPU workload, set that exact coordination file to `yes`, then restore `no`
immediately afterward.

## Local test artifacts

- Unpacked app:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\CUPCAKEAGI-win32-x64\CUPCAKEAGI.exe`
- Installer:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\make\squirrel.windows\x64\CUPCAKEAGI-Setup.exe`
- ZIP:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\make\zip\win32\x64\CUPCAKEAGI-win32-x64-2.0.0-rc.1.zip`
- Disposable live profile: `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\out\live-ui-dpapi-profile`

The installer was built and package-smoked but not installed system-wide. Use only a disposable
profile while owner-testing. See [local testing](local-testing.md) for the complete checklist.

## Verification evidence

Passed in the current source/package pass:

- Prettier, ESLint, and TypeScript typecheck.
- 20 Playwright tests across normal/narrow layouts, all four themes, keyboard flows, and automated
  accessibility checks.
- Full Python runtime suite and Ruff.
- Rust formatting, Clippy with warnings denied, and 98 broker tests passing (one intentional
  AppContainer probe ignored), plus process and contract suites.
- Authenticated frozen sidecar smoke, persistent-profile method matrix, package smoke, and RC audit.
- Packaged live NIM UI conversation and visual inspection of the confirmation and completed chat
  frames.

## Remaining release blocker

The Python project declares strict Pyright but currently has pre-existing type debt across the
runtime and tests. The verification script now invokes the actual project configuration rather than
silently using Pyright's weaker default mode. This strict gate is not clean and must be remediated
or explicitly dispositioned by the owner before calling the candidate release-approved. See
[known issues](known-issues.md#strict-python-type-check-debt).

## Owner acceptance next steps

1. Launch the unpacked app with a disposable profile and use the app normally.
2. Test the unsigned installer on the desired Windows test machine, including install, relaunch,
   upgrade/uninstall, and data-retention behavior.
3. Check backup/restore, migration preview, recovery, and any local-model workflow only when GPU
   ownership has been coordinated.
4. Decide whether to invest in clearing the strict Pyright backlog before release approval.
5. Do not distribute or publish any artifact until explicit approval.
