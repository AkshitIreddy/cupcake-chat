# E: drive cleanup ledger — 2026-09-05

## Scope and result

This pass audited and removed only verified CupcakeAI-owned derived data under `E:\temp`. Other
projects were inventoried by name only and left untouched. The command safety reviewer initially
rejected direct `Remove-Item` calls with `rejected: blocked by policy`; after the user explicitly
resumed deletion, the reviewed fixed-target PowerShell worker completed the cleanup.

- Free space before the audit: `186,585,235,456` bytes.
- Latest free-space snapshot: `290,743,013,376` bytes at `2026-09-05T11:32:30+05:30`.
- Logical file bytes reclaimed: `14,090,396,364` bytes (about 13.12 GiB).
- The free-space delta is not attributable to this pass. Other active project agents were both
  writing and deleting their own E: data during the audit.
- Deleted content includes `316,124,284` bytes of closed WebView caches, `1,214,388,641` bytes of
  completed runtime-download cache, `2,187,490,329` bytes of a completed security-lane Rust build
  cache, `2,616,943,232` bytes of an unreferenced general Cargo build cache, and `7,755,449,878`
  bytes of superseded profiles, duplicate model/runtime payloads, old QA evidence, and legacy test
  output.
- The deletion figures above are a historical record of work completed before the owner changed the
  retention policy. They must not be re-labelled as archived or moved data.

## Retention policy from 2026-09-05 11:34 IST

Future obsolete CupcakeAI data must be moved, never deleted, into a unique
`E:\uesless\CupcakeAI-cleanup-*` batch. `Archive Obsolete CupcakeAI E Drive.bat` is the user-facing
launcher; the older `Cleanup CupcakeAI E Drive.bat` remains as a compatible launcher for the same
archive-only worker.

The worker now validates the exact source and destination roots, rejects source, descendant, or
ancestor reparse points, rejects active-process and non-superseded repository references, and never
overwrites an archive collision. Each moved file or directory receives `planned` and `moved` records
in the batch's `manifest.jsonl`, mapping the original path to the archive path with its logical byte
count, SHA-256, and hash scheme. Directory hashes cover sorted relative paths, entry types, file
sizes, and file content hashes. Runtime ZIPs and their download metadata share a group identifier
and move as a checked pair; a failed second move rolls the first one back. Logs report bytes moved
to `E:\uesless`, not reclaimed space.

`E:\uesless` was created and verified as an ordinary directory resolving to that exact path. A
non-deleting validation after the conversion found all 79 old targets already absent, so it created
no empty archive batch and moved no data.

## Final reversible archive pass

After the current package build started, the final acceptance owner released an additional fixed
allowlist of 18 obsolete CupcakeAI directories. A fresh preflight verified that every source still
resolved beneath either `E:\temp\cupcake-overhaul-20260905` or `E:\temp\cupcakeagi-out`, all source
ancestors and `E:\uesless` were ordinary directories, the trees contained no reparse points, no
active process referred to them, and none overlapped a protected path.

The worker moved all 18 directories to
`E:\uesless\CupcakeAI-cleanup-final-20260905-145615-e8f0a120`. The batch contains 3,022 files with
12,951,766,048 logical bytes (about 12.06 GiB). Because this was a same-volume move from E: to E:,
it did not reclaim drive capacity. No deletion occurred and the Recycle Bin was not involved.

`archive-manifest.json` maps every original directory and relative file path to its archive path. It
records each file's size plus matching pre-move and post-move SHA-256 values. The completed manifest
SHA-256 is `C54EE9D4736519A3E20D4B84183F5650A3A4FD1FE511C4326893E7B75602F04E`. Independent
postflight checks found all 18 original paths absent, all 18 archive destinations present, and zero
recorded hash mismatches. The guarded restore worker is preserved at
`E:\temp\cupcake-overhaul-20260905\restore-final-cleanup.ps1`; it refuses occupied original paths
and verifies archived hashes before moving anything back.

Three pytest trees containing reparse points remained in place. The complete Guarded security task
evidence at
`E:\temp\cupcake-security-native-20260905-provisional-green\final-task-4ad18e1-guarded-r1` also
remained intact, together with current owner and WebView profiles, local model weights and runtime
packs, build targets, rollback snapshots, and current group, browser, native, and security evidence.

## Protected paths

The audit did not modify the current owner profile, current package/build roots, current overhaul
evidence, current showcase, active security evidence, the preserved rollback, current QA evidence,
Git worktrees, or paths belonging to other projects. The final inventory verified these 12 necessary
top-level roots intact:

- `E:\temp\cupcakeai-owner-test-20260902`
- `E:\temp\cupcakeai-owner-test-20260902-webview2` (the normal `Launch CupcakeAI Test.vbs` launcher
  explicitly reuses this folder)
- `E:\temp\cupcakeagi-out`
- `E:\temp\cupcakeagi-tauri-inputs`
- `E:\temp\cupcakeagi-tauri-target`
- `E:\temp\cupcake-overhaul-20260905`
- `E:\temp\cupcake-overhaul-20260905\broker-target`
- `E:\temp\cupcake-security-native-20260905-fresh`
- `E:\temp\cupcakeai-onboarding-qa-20260905`
- `E:\temp\cupcakeai-owner-showcase-20260905`
- `E:\temp\cupcake-model-catalog-qa-20260905`
- `E:\temp\cupcake-startup-profile-20260905`
- `E:\temp\CupcakeAI` (only the compact four-file quarantine database archive remains)

The final process scan showed the running owner app using only the protected owner profile/WebView
folder and its sidecars using the protected Tauri target. The package and broker junctions still
resolve to the protected roots listed above.

## Closed, unreferenced WebView cache candidates

All nine paths below resolve exactly inside `E:\temp`, are ordinary directories rather than
junctions, contain no nested reparse points, and had no browser or CupcakeAI process referencing
them when checked. A repository-wide check of launchers, scripts, and documentation found no current
reference to these exact cache paths. They are derived browser caches; acceptance screenshots and
the corresponding test profiles remain elsewhere.

| Path                                                         |      Bytes | Files |
| ------------------------------------------------------------ | ---------: | ----: |
| `E:\temp\cupcakeai-owner-test-20260902-close-webview2`       | 13,260,357 |   167 |
| `E:\temp\cupcakeai-owner-test-20260902-close-final-webview2` | 10,104,255 |   166 |
| `E:\temp\cupcakeai-owner-test-20260903-webview2`             | 10,718,710 |   185 |
| `E:\temp\cupcakeai-owner-test-20260903-probe-webview2`       | 10,110,499 |   177 |
| `E:\temp\cupcakeai-owner-test-20260903-status-webview2`      | 10,110,625 |   177 |
| `E:\temp\cupcakeai-owner-test-20260903-nim-webview2`         | 11,684,279 |   219 |
| `E:\temp\cupcakeai-owner-test-20260903-nim2-webview2`        | 15,352,424 |   222 |
| `E:\temp\cupcakeai-owner-test-20260903-diag-webview2`        |  9,423,444 |   178 |
| `E:\temp\cupcakeai-direct-open-smoke-20260904-v2-webview2`   |  9,267,583 |   168 |

The normal launcher sets `WEBVIEW2_USER_DATA_FOLDER` to
`E:\temp\cupcakeai-owner-test-20260902-webview2`. That 33,537,252-byte folder is active launcher
state and is protected even when no process has it open.

The reviewer rejected an exact recursive `Remove-Item -LiteralPath` for the diagnostic cache. It
also rejected a second attempt that enumerated the same verified tree and used non-recursive
`Remove-Item -LiteralPath` for each file and then each empty directory. Both attempts failed before
process creation. The later reviewed worker deleted all nine candidates while preserving the
launcher cache.

## Historical QA WebView cache candidates

The following 19 directories under `E:\temp\CupcakeAI\qa` were ordinary `EBWebView` cache trees.
Their exact names were not referenced by the current launcher. Current acceptance evidence now lives
under the protected 2026-09-05 QA, overhaul, security, and showcase roots.

| Directory                                          |      Bytes |
| -------------------------------------------------- | ---------: |
| `default-open-native-webview2`                     |  9,310,067 |
| `native-final-20260903`                            |  9,420,104 |
| `native-model-catalogs-20260903`                   | 10,807,772 |
| `native-model-catalogs-diag-20260903`              |  9,429,476 |
| `native-model-catalogs-final-20260903`             | 15,352,657 |
| `native-model-catalogs-final-verified-20260903`    |  9,422,153 |
| `native-model-catalogs-pass-20260903`              | 11,231,577 |
| `native-model-catalogs-pass2-20260903`             | 15,352,545 |
| `native-model-catalogs-verified-20260903`          |  9,422,193 |
| `native-model-intelligence-final-webview-20260903` | 31,004,816 |
| `native-model-intelligence-lazy-webview-20260903`  |  9,314,749 |
| `native-model-intelligence-lean-webview-20260903`  |  9,313,428 |
| `owner-final-build-webview2`                       |  9,306,716 |
| `owner-final-webview2`                             |  9,308,062 |
| `owner-migration-webview2`                         |  8,828,703 |
| `owner-migration-webview2-v2`                      | 10,125,450 |
| `owner-migration-webview2-v3`                      |  9,306,907 |
| `owner-optional-security-webview2`                 |  9,203,575 |
| `webview-model-intelligence-20260903`              | 10,631,158 |

These derived caches totaled `216,092,108` bytes and were deleted. The remaining old `qa`
screenshots, JSON output, and default script-created profile were later removed when the current
2026-09-05 evidence superseded them.

## Completed runtime-download cache candidate

`E:\temp\CupcakeAI\normal-profile\local-models\downloads\runtime` contains five completed runtime
ZIPs plus their small download metadata files. The corresponding installed `b10679` runtime
directories (`cpu`, `cuda-12`, `cuda-13`, and `vulkan`) exist beside the cache. Each ZIP has an
exact SHA-256-identical copy in the protected owner-profile download cache:

| Archive                                  |       Bytes | SHA-256                                                            |
| ---------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `cudart-llama-bin-win-cuda-12.4-x64.zip` | 391,443,627 | `8C79A9B226DE4B3CACFD1F83D24F962D0773BE79F1E7B75C6AF4DED7E32AE1D6` |
| `cudart-llama-bin-win-cuda-13.3-x64.zip` | 390,970,417 | `1462A050EB4C684921BA51DCC4CC488A036674C3E73E9945EE705B854808D03E` |
| `llama-b10679-bin-win-cuda-12.4-x64.zip` | 250,538,105 | `46E8C7F80B540BEFB10625F20C54B54777857E6C2DF51C349312CCFB4A0A83FB` |
| `llama-b10679-bin-win-cuda-13.3-x64.zip` | 146,519,312 | `2936F7230732DF0DDA2070960A940A7CA69D4DEBBD5EDFF4A1B98C2DAD339EFB` |
| `llama-b10679-bin-win-vulkan-x64.zip`    |  34,914,877 | `D288A375A324F650A587D3B876AFE692CA3586110F20B863FADBE91DD3B93469` |

The ten cache files (five ZIPs and five metadata files) totaled `1,214,388,641` bytes. The process
scan found no CupcakeAI, llama, or download process referring to the old cache; only the audit
command itself matched its literal path. The worker reverified every SHA-256 pair immediately before
deleting the old copies. The parent normal profile was removed later after its remaining
model/runtime payloads were independently proven redundant.

## Completed security build-cache candidate

`E:\temp\cupcakeagi-target\security-backup` was a `2,187,490,329`-byte Cargo/Rust build cache. The
security-lane owner confirmed it created this lane-specific target, completed and froze its
source/tests, and no longer needed the output. The current repository broker target resolves instead
to `E:\temp\cupcake-overhaul-20260905\broker-target`; native packaging also confirmed that the
security cache was outside its active inputs. It passed fresh containment, reparse-point,
repository-reference, and process-reference checks and was deleted.

## General Cargo build cache

`E:\temp\Cupcakeagi-cargo-target` contained only standard Cargo cache material (`debug`, `tmp`,
`.rustc_info.json`, and `CACHEDIR.TAG`) totaling `2,616,943,232` bytes across 3,594 files. It
resolved exactly beneath `E:\temp`, had no reparse points, was not a current repository junction or
package input, had no source/launcher reference, and had no active process reference. After a final
non-deleting validation, it was deleted and its absence was verified.

## Broad superseded-data cleanup

The old `E:\temp\CupcakeAI\normal-profile` contained only `local-models`; it had no chat, project,
profile database, or other ordinary user content. Its 220 files were compared with the protected
owner profile. Of these, 214 files totaling `7,034,099,460` bytes were SHA-256-identical, including
the Qwen GGUF and all runtime payload binaries. The remaining six files were small manifests: the
model manifest had the same model SHA-256 and differed only in installation time and absolute path,
`active.json` differed only in activation time, and four runtime manifests listed identical payload
hashes and differed only in installation time. With no active process or launcher pointing to the
old profile, its `7,034,121,532` bytes were removed.

The key-mismatch quarantine was reduced carefully rather than deleted. A duplicate `45,840,807`-byte
CPU runtime migration backup and a `512,177,277`-byte incomplete CUDA runtime were removed. The four
database files that could contain historical user state remain at
`E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z` and total `552,960` bytes.

The same guarded pass removed the remaining superseded smoke profiles, migration profiles,
wallpaper/UI runs, historical screenshots, and evidence JSON. It deleted 20 directories and 21 files
totaling `7,748,092,596` bytes with one initially preserved legacy-test directory. The legacy tree
contained only pytest output and 45 remaining test-created symbolic links; every link and
destination resolved inside that same disposable tree. A second non-deleting validation passed, then
the worker unlinked those internal links and removed the `7,357,282`-byte tree. No old target from
the fixed list remains.

## Historical user-run deletion cleanup

Before the retention-policy change, `Cleanup CupcakeAI E Drive.bat` launched
`scripts\cleanup-cupcake-e-drive.ps1` in a hidden PowerShell window. The deletion-era worker used a
fixed target list and:

- preserves the owner profile, launcher WebView state, current package roots, current
  overhaul/broker evidence, current showcase/QA/security evidence, installed owner runtimes, and the
  four quarantined databases;
- verifies exact `E:\temp` containment and rejects reparse points, except for the one explicit
  legacy pytest tree whose test-created links were individually verified to point inside the same
  cleanup tree before unlinking;
- scans current repository references and active process paths before each directory deletion;
- re-hashed every old runtime archive against the protected owner-profile copy and checked all
  installed backends before removing only the old archive and its metadata;
- logs every deletion, preservation, failure, free-space snapshot, and logical byte count to
  `E:\temp\cupcake-cleanup-20260905.log`.

The initial non-deleting `-ValidateOnly` run found all 29 original directory targets and all five
archive-plus-metadata pairs ready, with five matching archive hashes and zero failures. The user's
first run removed 19 directories (`230,785,536` bytes) before ending without a final summary. That
log is preserved as `E:\temp\cupcake-cleanup-20260905-user-run-partial-105716.log`. The resumed run
removed the remaining 10 directories and five archive pairs (`3,487,217,718` bytes) with zero
failures; its log is preserved as `E:\temp\cupcake-cleanup-20260905-agent-resume-110304.log`. A
final validation and run removed the general Cargo cache (`2,616,943,232` bytes) with zero failures;
its log is preserved as `E:\temp\cupcake-cleanup-20260905-final-cargo-110530.log`.

An idempotence follow-up found a strict-mode edge case when measuring an empty directory and
preserved both directories without deleting them; that evidence is
`E:\temp\cupcake-cleanup-20260905-empty-dir-failure-110721.log`. After `Get-TreeBytes` was fixed to
return zero for an empty tree, the final run deleted the empty `E:\temp\cupcakeagi-target` and
`E:\temp\cupcakeagi-tool-broker-target` directories with zero failures. The current log records this
last pass.

The broadened validation first found 41 ready entries and preserved the legacy test tree because it
contained reparse points. Its evidence is
`E:\temp\cupcake-cleanup-20260905-broad-validation-initial-20260905T1126.log`. After the links were
proven internal, a clean validation found 42 ready entries with zero failures. The broad deletion
log is `E:\temp\cupcake-cleanup-20260905-broad-delete-20260905T1128.log`. The final legacy-only
validation and deletion both completed with zero failures; the current log records that last run.

## Final remaining Cupcake directories

Only the 12 protected roots listed above remain. Their purposes are current package/build inputs and
outputs, the real owner profile and launcher cache, current 2026-09-05 acceptance/security/showcase
evidence, and the compact four-file quarantine database archive. Old worklog references alone were
not treated as a reason to retain superseded derived data. Cleanup logs remain as small top-level
files so every deletion pass is auditable.
