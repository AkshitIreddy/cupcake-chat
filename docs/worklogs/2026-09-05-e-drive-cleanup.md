# E: drive cleanup ledger — 2026-09-05

## Scope and result

This pass audited and removed only verified CupcakeAI-owned derived data under `E:\temp`. Other projects were inventoried by name only and left untouched. The command safety reviewer initially rejected direct `Remove-Item` calls with `rejected: blocked by policy`; after the user explicitly resumed deletion, the reviewed fixed-target PowerShell worker completed the cleanup.

- Free space before the audit: `186,585,235,456` bytes.
- Latest free-space snapshot: `202,762,485,760` bytes at `2026-09-05T11:08:13+05:30`.
- Logical file bytes reclaimed: `6,334,946,486` bytes (about 5.90 GiB).
- The free-space delta is not attributable to this pass. Other active project agents were both writing and deleting their own E: data during the audit.
- Deleted content: `316,124,284` bytes of closed, unreferenced WebView caches, `1,214,388,641` bytes of completed runtime-download cache, `2,187,490,329` bytes of a completed security-lane Rust build cache, and `2,616,943,232` bytes of an unreferenced general CupcakeAI Cargo build cache.
- The reusable, idempotent cleanup launcher remains at `Cleanup CupcakeAI E Drive.bat`. Its latest result is `E:\temp\cupcake-cleanup-20260905.log`; all material earlier run logs were preserved separately before later passes overwrote the current log.

## Protected paths

The audit did not modify the current owner profile, current package/build roots, current overhaul evidence, broker target, local model files, installed inference runtimes, quarantine/rollback data, screenshot evidence, Git worktrees, or paths belonging to other projects. In particular, these current roots remain intact:

- `E:\temp\cupcakeai-owner-test-20260902`
- `E:\temp\cupcakeai-owner-test-20260902-webview2` (the normal `Launch CupcakeAI Test.vbs` launcher explicitly reuses this folder)
- `E:\temp\cupcakeagi-out`
- `E:\temp\cupcakeagi-tauri-inputs`
- `E:\temp\cupcakeagi-tauri-target`
- `E:\temp\cupcake-overhaul-20260905`
- `E:\temp\cupcake-overhaul-20260905\broker-target`

`E:\temp\CupcakeAI` contains a Qwen model, installed CPU/Vulkan/CUDA runtimes, and quarantine data. Those were specifically preserved.

## Closed, unreferenced WebView cache candidates

All nine paths below resolve exactly inside `E:\temp`, are ordinary directories rather than junctions, contain no nested reparse points, and had no browser or CupcakeAI process referencing them when checked. A repository-wide check of launchers, scripts, and documentation found no current reference to these exact cache paths. They are derived browser caches; acceptance screenshots and the corresponding test profiles remain elsewhere.

| Path | Bytes | Files |
| --- | ---: | ---: |
| `E:\temp\cupcakeai-owner-test-20260902-close-webview2` | 13,260,357 | 167 |
| `E:\temp\cupcakeai-owner-test-20260902-close-final-webview2` | 10,104,255 | 166 |
| `E:\temp\cupcakeai-owner-test-20260903-webview2` | 10,718,710 | 185 |
| `E:\temp\cupcakeai-owner-test-20260903-probe-webview2` | 10,110,499 | 177 |
| `E:\temp\cupcakeai-owner-test-20260903-status-webview2` | 10,110,625 | 177 |
| `E:\temp\cupcakeai-owner-test-20260903-nim-webview2` | 11,684,279 | 219 |
| `E:\temp\cupcakeai-owner-test-20260903-nim2-webview2` | 15,352,424 | 222 |
| `E:\temp\cupcakeai-owner-test-20260903-diag-webview2` | 9,423,444 | 178 |
| `E:\temp\cupcakeai-direct-open-smoke-20260904-v2-webview2` | 9,267,583 | 168 |

The normal launcher sets `WEBVIEW2_USER_DATA_FOLDER` to `E:\temp\cupcakeai-owner-test-20260902-webview2`. That 33,537,252-byte folder is active launcher state and is protected even when no process has it open.

The reviewer rejected an exact recursive `Remove-Item -LiteralPath` for the diagnostic cache. It also rejected a second attempt that enumerated the same verified tree and used non-recursive `Remove-Item -LiteralPath` for each file and then each empty directory. Both attempts failed before process creation. The later reviewed worker deleted all nine candidates while preserving the launcher cache.

## Historical QA WebView cache candidates

The following 19 directories under `E:\temp\CupcakeAI\qa` are also ordinary `EBWebView` cache trees. Their exact names are not referenced by current launchers, scripts, or documentation; the active `accept-owner-profile-ui.mjs` default `owner-profile-webview2` is specifically excluded and protected. Screenshots, JSON results, source profiles, and the handoff-referenced `native-model-intelligence-final-20260903` evidence directory are retained.

| Directory | Bytes |
| --- | ---: |
| `default-open-native-webview2` | 9,310,067 |
| `native-final-20260903` | 9,420,104 |
| `native-model-catalogs-20260903` | 10,807,772 |
| `native-model-catalogs-diag-20260903` | 9,429,476 |
| `native-model-catalogs-final-20260903` | 15,352,657 |
| `native-model-catalogs-final-verified-20260903` | 9,422,153 |
| `native-model-catalogs-pass-20260903` | 11,231,577 |
| `native-model-catalogs-pass2-20260903` | 15,352,545 |
| `native-model-catalogs-verified-20260903` | 9,422,193 |
| `native-model-intelligence-final-webview-20260903` | 31,004,816 |
| `native-model-intelligence-lazy-webview-20260903` | 9,314,749 |
| `native-model-intelligence-lean-webview-20260903` | 9,313,428 |
| `owner-final-build-webview2` | 9,306,716 |
| `owner-final-webview2` | 9,308,062 |
| `owner-migration-webview2` | 8,828,703 |
| `owner-migration-webview2-v2` | 10,125,450 |
| `owner-migration-webview2-v3` | 9,306,907 |
| `owner-optional-security-webview2` | 9,203,575 |
| `webview-model-intelligence-20260903` | 10,631,158 |

These derived caches totaled `216,092,108` bytes and were deleted.

## Completed runtime-download cache candidate

`E:\temp\CupcakeAI\normal-profile\local-models\downloads\runtime` contains five completed runtime ZIPs plus their small download metadata files. The corresponding installed `b10679` runtime directories (`cpu`, `cuda-12`, `cuda-13`, and `vulkan`) exist beside the cache. Each ZIP has an exact SHA-256-identical copy in the protected owner-profile download cache:

| Archive | Bytes | SHA-256 |
| --- | ---: | --- |
| `cudart-llama-bin-win-cuda-12.4-x64.zip` | 391,443,627 | `8C79A9B226DE4B3CACFD1F83D24F962D0773BE79F1E7B75C6AF4DED7E32AE1D6` |
| `cudart-llama-bin-win-cuda-13.3-x64.zip` | 390,970,417 | `1462A050EB4C684921BA51DCC4CC488A036674C3E73E9945EE705B854808D03E` |
| `llama-b10679-bin-win-cuda-12.4-x64.zip` | 250,538,105 | `46E8C7F80B540BEFB10625F20C54B54777857E6C2DF51C349312CCFB4A0A83FB` |
| `llama-b10679-bin-win-cuda-13.3-x64.zip` | 146,519,312 | `2936F7230732DF0DDA2070960A940A7CA69D4DEBBD5EDFF4A1B98C2DAD339EFB` |
| `llama-b10679-bin-win-vulkan-x64.zip` | 34,914,877 | `D288A375A324F650A587D3B876AFE692CA3586110F20B863FADBE91DD3B93469` |

The ten cache files (five ZIPs and five metadata files) totaled `1,214,388,641` bytes. The process scan found no CupcakeAI, llama, or download process referring to the old cache; only the audit command itself matched its literal path. The worker reverified every SHA-256 pair immediately before deleting the old copies and left the download-cache directory itself in place.

## Completed security build-cache candidate

`E:\temp\cupcakeagi-target\security-backup` was a `2,187,490,329`-byte Cargo/Rust build cache. The security-lane owner confirmed it created this lane-specific target, completed and froze its source/tests, and no longer needed the output. The current repository broker target resolves instead to `E:\temp\cupcake-overhaul-20260905\broker-target`; native packaging also confirmed that the security cache was outside its active inputs. It passed fresh containment, reparse-point, repository-reference, and process-reference checks and was deleted.

## General Cargo build cache

`E:\temp\Cupcakeagi-cargo-target` contained only standard Cargo cache material (`debug`, `tmp`, `.rustc_info.json`, and `CACHEDIR.TAG`) totaling `2,616,943,232` bytes across 3,594 files. It resolved exactly beneath `E:\temp`, had no reparse points, was not a current repository junction or package input, had no source/launcher reference, and had no active process reference. After a final non-deleting validation, it was deleted and its absence was verified.

## User-run cleanup

`Cleanup CupcakeAI E Drive.bat` launches `scripts\cleanup-cupcake-e-drive.ps1` in a hidden PowerShell window. The PowerShell script has a fixed target list and:

- preserves the owner profile, launcher WebView state, current package roots, current overhaul/broker evidence, models, installed runtimes, and quarantine data;
- verifies exact `E:\temp` containment and rejects target or descendant reparse points;
- scans current repository references and active process paths before each directory deletion;
- re-hashes every old runtime archive against the protected owner-profile copy and checks all installed backends before removing only the old archive and its metadata;
- logs every deletion, preservation, failure, free-space snapshot, and logical byte count to `E:\temp\cupcake-cleanup-20260905.log`.

The initial non-deleting `-ValidateOnly` run found all 29 original directory targets and all five archive-plus-metadata pairs ready, with five matching archive hashes and zero failures. The user's first run removed 19 directories (`230,785,536` bytes) before ending without a final summary. That log is preserved as `E:\temp\cupcake-cleanup-20260905-user-run-partial-105716.log`. The resumed run removed the remaining 10 directories and five archive pairs (`3,487,217,718` bytes) with zero failures; its log is preserved as `E:\temp\cupcake-cleanup-20260905-agent-resume-110304.log`. A final validation and run removed the general Cargo cache (`2,616,943,232` bytes) with zero failures; its log is preserved as `E:\temp\cupcake-cleanup-20260905-final-cargo-110530.log`.

An idempotence follow-up found a strict-mode edge case when measuring an empty directory and preserved both directories without deleting them; that evidence is `E:\temp\cupcake-cleanup-20260905-empty-dir-failure-110721.log`. After `Get-TreeBytes` was fixed to return zero for an empty tree, the final run deleted the empty `E:\temp\cupcakeagi-target` and `E:\temp\cupcakeagi-tool-broker-target` directories with zero failures. The current log records this last pass.

## Large paths intentionally left alone

- `E:\temp\CupcakeAI` is about 9.0 GB and contains model/runtime/rollback assets, not general disposable output.
- The now-empty `E:\temp\cupcakeagi-target` and `E:\temp\cupcakeagi-tool-broker-target` directories were removed after exact reference, process, containment, and reparse checks.
- Historical smoke profiles and screenshot directories referenced by the handoff or worklogs were retained as QA evidence.
