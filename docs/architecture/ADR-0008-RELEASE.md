# ADR-0008: Windows Tauri packaging and local-only posture

**Status:** Accepted (supersedes prior package decision)

**Date:** 2026-08-29

## Decision

Build a Windows 10/11 x64 Tauri 2 application and current-user NSIS installer. The local candidate
is unsigned and private. Production signing, publication, distribution, and updater configuration
are separate owner-authorized work.

The package must include the Tauri host, local fonts/licenses, checked-in contracts, verified Python
runtime, verified ToolBroker, and a no-weights Cupcake Local CPU baseline. Tauri external binary
sources use the `x86_64-pc-windows-msvc` target suffix. A signed manifest binds packaged executable
names, byte lengths, hashes, transport, protocol, and Cupcake Local provenance. The host verifies
the self-contained sidecar directory before launch.

Model weights remain user-selected downloads. Application files, encrypted product state, models,
caches/logs, and temporary sandboxes use separate per-user locations. Upgrades are transactional and
uninstall presents the documented data-retention choice.

CI may build and smoke a local unsigned NSIS package with read-only repository permissions. It must
not upload artifacts, publish packages, create releases, sign, or configure a live update endpoint.

## Gates

Fresh source tests, Tauri/WebView2 interactions, visual/accessibility matrix, secret scans, sidecar
integrity, clean Windows 10/11 install, two-version upgrade, uninstall/retention, startup/memory,
hosted chat, Cupcake Local chat/benchmark/recovery, and owner acceptance are required. No corrected
artifact is currently claimed as accepted.
