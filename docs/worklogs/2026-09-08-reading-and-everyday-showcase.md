# September 8: readable conversations and an everyday showcase

The owner rejected the stacked chat heading, narrow message panels, repetitive cloud reminders,
inconsistent Tasks/Memory surfaces, and formal, low-value demonstration conversations. This
follow-up keeps all UI verification headless at normal scale. The owner's later instructions
supersede the original brief's zoom and VM checks.

## Design decisions and research

The title and project now share a compact identity area beside conversation navigation; Outline,
Context, and the solo Add Cupcake action use the available horizontal space. A solo conversation no
longer allocates an empty participant row. Real groups retain their roster and speaking controls.

Conversation and composer width increases from 800 to 1120 pixels, subject to the available window
width. Paragraphs retain an 80ch maximum measure while tables and code can use the panel. Windows
chat prose uses Segoe UI at 17px with 1.72 leading; display headings and Cupcake portraits retain
the app's character. Legacy response selectors no longer override modern Markdown table and heading
typography.

The
[W3C visual presentation guidance](https://www.w3.org/WAI/WCAG21/Understanding/visual-presentation.html)
and [C20 technique](https://w3c.github.io/wcag/techniques/css/C20) support controlling line measure
and allowing reflow. The particular font, spacing, and panel treatment are design judgments checked
in rendered screenshots, not a claim of WCAG AAA conformance. Research reviewed September 8, 2026.

Healthy composer routes no longer show the cloud badge or the repeated send reminder. Unavailable
model feedback and actual send/permission enforcement remain functional.

## Current evidence

- Browser bridge evidence is explicitly a fixture, not model output or owner data:
  `E:\temp\cupcake-ui-20260908\reading`.
- Opened normal-scale 1440px Copper chat top/bottom and 390px quiet-paper chat. Measured header
  66px, desktop conversation 1120px, prose 17px, no page overflow. Narrow capture waits for the
  sidebar transition to settle.
- Group UI regressions: solo Add Cupcake opens the editor from the header; existing mention
  identity/keyboard flow, adding a persona, and opaque scene settings pass. The old test helper
  required an empty participant tray even for solo chat; it now waits for the actual Add Cupcake
  entry point.
- Wallpaper save failure reproduced independently in the runtime validator. Commit `8a25eb7` accepts
  all four later wallpaper IDs; all four save-and-reopen tests pass in the pinned runtime
  environment.

- Product UI commit: `ccc17b8`. Desktop tests: 86 passed; TypeScript and ESLint passed. Four focused
  group interaction checks passed without zoom testing.
- Tasks/Memory evidence: `E:\temp\cupcake-overhaul-20260905\task-memory-theme-revision1`. All eight
  scenes and four base themes were captured at normal scale. Root also independently opened Copper's
  accepted Resume and Memory states. The Memory Instruction badge needed a further light-gold
  foreground correction, recorded in `task-memory-copper-final`. Scene tokens now live with the
  wallpaper stylesheet.
- Demo helper commit: `656e927`. This is an owner-only operational helper, not part of the packaged
  product. Parse, guard self-tests, and lint pass. Root corrected project navigation, polling of
  running turns, local sends without cloud dialogs, and the distinction between a quiet turn's zero
  replies and its configured cap.

## Acceptance ledger

| Owner request                                                | Status                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| Remove routine cloud/send admonition                         | Verified absent in final packaged chat                    |
| Compact horizontal chat heading                              | Final package: 66px header                                |
| Wider, more readable messages                                | Final package: 1120px, 17px prose, no overflow            |
| Theme Tasks resume/accepted feedback                         | All-scene fixture states inspected; final Tasks inspected |
| Theme Memory panel                                           | Final populated, detail, empty, undo states inspected     |
| Make later wallpapers selectable                             | All four actual packaged clicks saved and reloaded        |
| Natural, useful, playful real conversations                  | Four real multi-turn examples; draft limits below         |
| Persist hosted and local CUDA examples with useful artifacts | 21 replies and four saved plans verified on final package |
| Fresh packaged app, restart, shutdown, secret scan           | Final package/reopen/cleanup passed; scan receipt below   |

The preceding September 7 package is historical evidence and does not contain these source changes.
The following receipts distinguish fixture, actual app, and real inference observations.

## Real everyday conversations (September 8)

The owner-only helper is `scripts/create-owner-everyday-showcase.mjs` (guard/provenance correction
`0e5ec65`). It sends through the packaged application's authenticated runtime and uses the product
UI for group submission and explicit mentions. Direct hosted sends use the bound outbound preflight;
local sends run in Offline mode. It does not insert assistant messages, retry failed turns, or read
credentials. Prompts were written by the coding agent as sample user conversations, not by the
owner.

The first attempts did not pass quality review. A dinner group invented impractical quantities and
cooking assumptions; a first movie attempt and a truncated photo response are archived in the owner
profile. Their three trial-only Cupcakes are archived too. Groq reported a rate-limit on one earlier
turn; a Cohere selector failed; a NVIDIA NIM correction returned `provider_unavailable`. These are
preserved failures, not successful route demonstrations. No OpenRouter or Cloudflare quota was used
in this pass. Groq's existing credential was reconnected through its masked in-app setup to select
GPT-OSS 120B for the subsequent work; the credential never entered the helper or evidence.

[Groq's rate-limit documentation](https://console.groq.com/docs/rate-limits) was consulted on
September 8. Limits apply across requests/tokens, and group selection adds requests/history cost.
The helper spaces new Groq turns by 65 seconds instead of automatically retrying a failed
submission. [Groq's model documentation](https://console.groq.com/docs/models) and
[Cohere's Command A+ documentation](https://docs.cohere.com/docs/command-a-plus) were also reviewed.
A stronger model did not eliminate poor assumptions: actual follow-ups narrow scope and correct the
first drafts. We do not infer reliability from a model's size or a completed finish reason.

| Project              | Conversation                               | Completed assistant replies | Actual route                                       |
| -------------------- | ------------------------------------------ | --------------------------: | -------------------------------------------------- |
| Small Things, Sorted | Friday, sorted: a movie and popcorn        |                           5 | Groq GPT-OSS 120B and Cohere Command A+            |
| Small Things, Sorted | Make Sunday feel lighter                   |                           6 | First four Groq GPT-OSS 20B, last two GPT-OSS 120B |
| Pocket Adventures    | The ordinary-street photo game             |                           5 | Cohere Command A+                                  |
| Private Reset Room   | A gentle reset that stays on this computer |                           5 | Cupcake Local Qwen3 8B Q4_K_M, CUDA 13             |

The movie conversation includes a direct Remy mention, a reviewed no-shopping invite/checklist, and
a final quiet Smart turn. The earlier quiet turn and draft revisions remain in chronological
history. Each conversation has a saved Markdown artifact; the head content is SHA-256-matched to its
completed assistant source. Runtime artifact snapshots expose content at the top level, and
historical author kind is read from `artifacts.history`. The helper verifies these actual contracts
rather than assuming revision objects contain the content or expose source-message IDs.

The receipt
`E:\temp\cupcakeai-owner-everyday-showcase-20260908\everyday-showcase-verify-evidence.json` records
project/conversation/revision/message IDs, actual per-response provider/model IDs, content hashes,
group outcomes, and screenshots. Verification is read-only and requires no further inference. The
existing Harbor, Northstar, Atlas, and Private Studio projects are preserved.

These are useful iterative drafts, not a claim that every model follows every preference. The final
photo card labels itself 15 minutes but says to turn back after 15 minutes; the return trip must be
allowed for. Qwen's final card still includes one emoji after a request to omit them and suggests
closing three tabs rather than explicitly bookmarking them. Those source responses are retained
unchanged, and are not advertised as perfect instruction compliance. No physical task, invitation,
photo walk, or message was actually carried out by a model.

## Current-package CUDA and lifecycle

The actual `ccc17b8` host (SHA `63C664259992DB8194A86AA58AE66F0A23E8B7F114215D8590807C5D05318E4E`)
loaded app-managed Qwen3 8B through `llama.cpp:b10679:windows-x64-cuda-13.3`. The first GPU
observation records the owned `llama-server.exe` PID 28888 on an RTX 4080 Laptop GPU, driver 581.29,
12,282 MiB VRAM; total observed GPU memory use was 5,864 MiB. That total includes other Windows
processes and is not an isolated per-model measurement. Context was 4096; reserves remained 4 GiB
system RAM and 1.5 GiB VRAM, with hybrid placement allowed. Estimated placement is distinguished
from the observed CUDA backend/process. Earlier fit-refusal, stop/recovery, and offload evidence
remains in the broader September 5 ledger; this pass did not rerun every benchmark.

Both bounded GPU claims completed successfully and released the marker after unload. Their receipts
are under `E:\temp\cupcake-ui-20260908\gpu-readiness-claim-*`; the final claim ran 07:29:32–07:30:28
UTC. Local status was stopped afterward, and Direct mode was restored with Groq GPT-OSS 120B
selected. No local-to-cloud fallback occurred.

The pre-final close receipt
`E:\temp\cupcake-overhaul-20260905\final-owner-close-ccc17b8-pre-final.json` records all eleven
owned processes exiting in 2,419 ms including CDP helper overhead; no model remained and the GPU
marker was `no`. Free space was about 233 GB on C and 178 GB on E. No new filesystem cleanup was
performed during this pass.

## Final review corrections

`977199e` fixes a real packaged interaction failure: the transcript's Jump to latest control could
intercept a pointer click on the `@` picker because the composer created a lower stacking context.
The composer now sits above transcript controls. A regression test opens a long conversation and
clicks the second mention choice over the jump control; it passed headlessly.

A second source audit found Memory's empty header missed the scene selector and Memory notices
missed Task's opaque notice rules. `621c38b` adds stable page scoping; `31c54fd` fixes the empty
card's white-on-bright-blur contrast and replaces the implementation phrase about a “tombstone” with
“Memory removed.” Root independently opened the corrected Copper empty-state screenshot; it has a
solid brown rounded panel, readable cream text, and an opaque notice. Evidence includes Copper and
Cupcake Light populated/empty captures under `E:\temp\cupcake-memory-theme-qa`. These captures are
explicitly browser fixtures; they do not claim a real memory was removed in the owner profile.

The intermediate source `6d594d2` also gives group messages consistent model/route labels with exact
IDs retained in the tooltip, and removes the repeated “Roster route” message-action footer. Root
opened the agent's light-theme group capture. Root then reran the full desktop suite: 13 files / 86
tests passed, desktop TypeScript and relevant ESLint passed, and the long-chat pointer-mention
regression passed on the final source. The task-owned Vite server on 42623 was stopped afterward.

The real `6d594d2` package then exposed a functional Memory defect missed by the earlier visual
fixtures: saving the first project memory showed “Memory saved” followed by an empty panel. The
record was correctly stored, but the `memory.saved` event handler queried global memories without
the active project and overwrote the optimistic list. The screenshot and runtime record are
preserved under `E:\temp\cupcake-ui-20260908\final-ui\memory-save-stale-baseline.png` and
`E:\temp\cupcake-ui-20260908\memory-read.json`.

`c0e08ac` scopes event refreshes to the active project, retains global memories, and ignores
responses from an obsolete project selection. The new `3a7e75b` browser regression emits realistic
saved and forgotten events, waits for each refresh to complete, checks project/global retention, and
verifies that forgetting an undone memory uses its new record ID. It passed in 8.5 seconds. The old
real package supplies the failing baseline; no passing fixture is substituted for that observation.
Desktop tests again passed 86/86 across 13 files, and TypeScript, ESLint, and the focused test's
formatting passed. Both owned test-server ports were clear afterward.

## Final package and owner-profile verification

The final product commit is `c0e08ac07f34f4f0466242a37dad4e6fa2c73529`. The root independently
hashed the executable and unsigned NSIS, matching the
[package audit](../research/2026-09-08-package-audit.md): host
`FFBA90EE8A8E38DFCEA37C4C4521D691AD947FF5D405E293C60DC0D5749A3B45`, installer
`6E29B974A8FE8AD58DF7FC4F7F26FD54AB1E735AC2AB4E6BF98417CD2466D5B3`. The runtime, broker, and support
manifest remain the same verified bytes used for this pass's real provider/CUDA work.

All paths in this section are under `E:\temp\cupcake-ui-20260908` unless otherwise stated:

- `final-ui-c0e08ac/verification.json`: real pointer selection of Remy above Jump to latest, no Send
  and unchanged history; header 66px, conversation 1120px, Segoe UI prose 17px/29.24px leading, no
  routine send reminder or repeated roster footer, and no document overflow. Root opened the final
  group, mention menu, actual saved movie plan, Tasks, and Memory screenshots.
- The actual Memory record was forgotten then undone through the UI. The restored record remained
  visible after the event refresh and had the correct project scope and a new identity. The real
  populated/detail/empty/restored screenshots show opaque scene-colored panels and notices.
- `final-c0e08ac-everyday/everyday-showcase-verify-evidence.json`: all three new projects, four
  conversations, 21 completed real assistant responses, source-content hashes, and group outcomes
  passed read-only verification. No inference was repeated on this final renderer-only rebuild.
- `final-c0e08ac-legacy/owner-showcase-verify-evidence.json`: all four older projects and five
  showcase views retained their real hosted/local responses and artifact provenance; no failures.
- `final-wallpapers/wallpaper-clicks.json`: all four formerly rejected wallpaper choices were
  clicked in the actual `6d594d2` package, saved, and reloaded. Root opened all four captures. That
  package has the identical runtime and appearance styles as the final Memory-refresh build.
- `final-persistence-c0e08ac/receipt.json`: after complete process restart, the exact restored
  Memory ID remained in Small Things, Sorted and its card rendered. Copper Workshop and Direct mode
  were restored, Groq GPT-OSS 120B selected, and local status remained stopped.

The first opening of these new bytes took **28,364 ms** to the visible Home renderer; reopening the
same executable/profile took **5,129 ms**. Bootstrap itself took 2,502 ms and 1,623 ms respectively.
Both receipts report zero browser exceptions. These are two observations, not a latency percentile
or a promise of instant startup. The first-opening delay's cause is not established. The earlier
`6d594d2` first opening took 19,333 ms and remains preserved rather than replaced by the faster run.

The warm-start receipt also records an existing non-blocking `developer.events` request returning
`INVALID_ARGUMENT`: renderer startup sends only a limit, whereas that endpoint requires a run ID.
The optional request is caught, so Home, chats, artifacts, and Memory still load. This pass does not
claim historical diagnostics hydration is working; live-session event collection is separate.

`owned-window-audit-c0e08ac-geometry.json` records the actual Tauri content window outside the
virtual desktop and no visible sidecar console. Two 15px Win32 event-target windows have the
`WS_VISIBLE` style and are reported separately; zero visible-style handles is not claimed. The
audit's first naive visible-style assertion failed for these infrastructure windows and was refined
to record their classes and geometry. No screen, window position, overlay, zoom, or foreground input
was changed by the audit. The observed process-tree working set after navigation was 715,264,000
bytes; it includes WebView2 and shared pages and is not unique committed memory.

Close receipts in `E:\temp\cupcake-overhaul-20260905` are `final-owner-close-c0e08ac-first.json` and
`final-owner-close-c0e08ac-final.json`. All eleven owned processes exited in 2,589 ms and 2,960 ms,
including CDP helper overhead. No owned model remained. The shared GPU marker was `yes`, claimed by
other work after this task's two successful releases; it was left untouched. Final observed free
space was 232,605,028,352 bytes on C and 160,134,025,216 on E. No additional cleanup was needed or
performed.

The final exact-token secret scan read 2,674 owned source/evidence text files and reported zero
matches; secret values were never printed. Its receipt is
`E:\temp\cupcake-ui-20260908\secret-scan-final.json`. Ports 10131, 42619, and 42623 had no listeners
after shutdown. Unrelated handoff files and the two pre-existing runtime artifacts remain untouched.
All changes are local commits on `master`; nothing was pushed, published, signed for distribution,
or activated in an updater. The owner launcher resolves through the existing target junction to the
verified executable on E. The owner guide identifies the new everyday examples first.
