# Independent overhaul acceptance ledger — 2026-09-05

Starting commit: `bf689ed`, local `master`. Current evidence only; historical checkmarks do not
transfer.

## Owner acceptance list

- [x] Read `SEE_NEXT_AGENT.md` completely; confirm repository, branch, dirty files, toolchains,
      disk, and GPU marker.
- [x] Independently inspect current architecture and preserved `v1.0.0`; record justified decisions
      with current primary research.
- [x] Inspect every major screen in the existing packaged app before redesign.
- [x] Coherent visual/navigation/titlebar/wallpaper/avatar overhaul with functional controls and
      readable responsive states.
- [x] Rich optional, replayable, action-based onboarding and truthful lazy startup.
- [x] Real optional content encryption, safe migration/recovery, and prompt-free ordinary opening;
      credentials stay protected.
- [x] Understandable permission presets including explicit Full freedom, with enforced effects and
      safety boundaries.
- [x] Intent-led, broad searchable model catalog, publisher/route distinction, immediate picker
      selection and honest resource evidence.
- [x] Connected chat/project/task/artifact/memory/tool workflows with useful guidance and no
      fabricated live claims.
- [x] Several real hosted-provider, multi-turn demos persisted through the app in the owner test
      profile.
- [x] After API testing: acquire GPU marker atomically, run app-managed CUDA demo, test
      stop/restart/unload/fit recovery, release marker.
- [x] Run appropriate contracts/JS/Python/Rust/security/integration gates and inspect
      responsive/accessibility/error UI renders.
- [x] Rebuild, hash, run packaged Windows app, measure startup/memory/close/process shutdown and
      record tray limitations under the owner's final headless-only testing scope.
- [x] Reopen persisted demos and visually inspect; test installer only without risk to ordinary user
      data.
- [x] Scan outputs for secrets, preserve unrelated files, record exact evidence/limitations, commit
      atomically on local master.
- [x] Deliver one-click hidden launcher, capability/demo guide and precise proven/unproven gates. No
      push/publication.

## Preserved pre-existing changes

`docs/PAUSED_HANDOFF.md`, `see me`, `artifacts/runtime/headless-cohere-20260901.json`,
`artifacts/runtime/headless-local-20260901.json` are outside this work's edit/staging scope.

## Evidence roots

Large output: `E:\temp\cupcake-overhaul-20260905`. Owner profile:
`E:\temp\cupcakeai-owner-test-20260902`. Cargo/output junctions already resolve to `E:\temp`.

## Initial independent findings

- Historical known-issues/checklist and later worklogs disagree about packaged local inference;
  revalidation is required.
- The host has no startup password for an absent lock record. Content encryption remains a separate
  implementation.
- The renderer has one roughly 10,000-line component module; distinct screen ownership is used
  during edits to prevent conflicts.
- v1's useful continuity is the persistent assistant connecting conversation and work. Synthetic
  emotions and unsafe execution are not product requirements.

## Consolidation evidence (before fresh packaging)

- Baseline actual executable: SHA-256
  `E41D23C143A36FBA76D75187F39755CC4486D61F80802ABA57B569BCF9960896`. Owner profile startup to Home
  took 20.890 seconds; close took 153 ms. See the dated native audit.
- First full runtime pass: 421 passed, 1 skipped. Strict Pyright: zero errors/warnings. Contracts
  pass after correcting an extra generated newline and honoring the pinned Corepack version.
- First combined renderer E2E pass: 50 passed, 4 failed. Two failures were the intentional titlebar
  height change (32 to 28 px); two were cached NIM discovery assumptions after lazy startup changes.
  These are tracked for correction and focused rerun, not counted as passing acceptance.
- Independent rendered inspection found and repaired cross-view scroll retention, bright-wallpaper
  recommendation-heading contrast, and invisible minimize/close glyphs in forced colors. Home's
  bright-wallpaper identity backplate was then fixed and accepted in opened renders.
- Artifact export and backups were previously intents without file writes. Broker writes now verify
  opaque destination grants, bytes, and digests; backup payloads are authenticated encrypted chunks.
  Real packaged recovery verification remains open.
- Owner added Groq, Gemini, Mistral, OpenRouter, and Cloudflare credentials during this task. Named
  provider setup and real owner-profile demonstrations are in progress. No live result is claimed
  yet.
- Local commits so far: `4a980de` build-tool/contract reproducibility; `a5f5e87` local
  backend/device validation, conservative memory estimates, and bounded progressive model discovery.

## Frozen-source consolidation

- Runtime: **436 passed, 1 skipped**; Ruff clean and strict Pyright zero errors/warnings.
- Renderer: full ESLint and TypeScript passed; **130 unit tests** and **58 browser E2E tests**
  passed. The four earlier titlebar/lazy-discovery failures were corrected and are included in this
  run.
- Contracts: authoritative generated-schema check passed.
- Visual browser matrix: 48 major-screen renders at 390, 768, 1440, and 2160 pixels, light/dark
  appearances, four wallpapers, forced colors, reduced motion, and keyboard probes. Opened and
  inspected evidence contains zero renderer errors, zero document horizontal overflow, and zero
  serious/critical Axe findings in the four tested chat variants. This remains browser evidence,
  separate from the freshly packaged app and real model conversations.
- Artifact export's strict Rust lint failure was repaired with a typed request structure. The
  focused export test and full broker Clippy passed; the final combined Rust gate is running.
- Exact-token secret scan covered **1,203 owned changed-source and task-evidence text files** with
  zero matches. It will be repeated after real provider execution.
- The new sidecar package uses a verified onedir runtime to avoid repeated onefile extraction.
  Baseline executable, sidecars, support files, hashes, and hidden launcher are preserved under
  `E:\temp\cupcake-overhaul-20260905\rollback-baseline-e41d23c1`.
- Additional local commits: `9006b67` safe historical migration; `972dbeb` lazy task executor;
  `78a3afe` verified reusable runtime support tree. All remain on local `master`.
- Cleanup authorization was renewed by the owner. Automatic approval review still rejected the exact
  deletion with only `blocked by policy`. The owner explicitly requested a user-run `.bat` fallback;
  a fixed-target, guarded PowerShell worker is being validated without deletion.

## Resumed native acceptance

- The owner paused work to change permissions, then explicitly resumed deletion and the main task.
  The first cleanup is now complete: **6,334,946,486 logical bytes** reclaimed, including the
  owner's partial run and agent completion. A broader obsolete-test-folder cleanup is in progress
  after the owner's follow-up about remaining folder count. See the separate cleanup ledger.
- All production source is committed; the UI overhaul is `a536ef9`. Later commits contain research,
  cleanup, and verification tooling. The four unrelated files remain untouched.
- Full Rust validation: **130 broker tests passed, one ignored; 27 desktop-host tests passed**;
  strict Clippy clean. A pre-existing duplicate workspace-lock branch was simplified equivalently.
- First rebuilt onedir candidate: executable SHA-256
  `49D5969C0390A6D07D4580E7E48D25F9111AFA0571A642BC276DA5DFF978E817`. This is **provisional**, not
  final acceptance. Packaged Home was opened and visually inspected; close was 109 ms with clean
  exit. Cold owner Home took 39,750 ms, so startup requires diagnosis despite broker-to-runtime
  readiness improving from 9,392 to 4,527 ms.
- Independent root review found an integration defect: Windows sandbox copied only the runtime
  executable, while the new onedir runtime needs its verified `_internal` support files. The
  security lane is repairing bounded, isolated support-file staging and will test the real worker.
- Packaged UI work must be serialized across profiles because Tauri's single-instance plugin is
  global. Root's initial owner launch attempts exited normally while the disposable security app was
  running; no hosted API call occurred in those attempts.
- Root owns the owner showcase port **10131** after security releases its app. Security uses
  **10143** only while root releases the global application instance. Native startup diagnostics
  must follow the same ownership rule.
- The showcase harness now saves the actual Python code block as executable artifact content,
  preserving assistant provenance; it rejects ambiguous or incomplete code blocks. Four focused
  extraction checks passed. No packaged source changed for this harness-only correction.

## Real hosted execution and review corrections

- Real owner-profile Groq and Cohere multi-turn conversations produced saved runbook/planning
  artifacts. NVIDIA NIM produced a two-turn revision-pinned source memo/decision brief and a
  source-linked decision memory. These were read back through the packaged app; their screenshots
  were opened and inspected.
- Actual testing found Mistral SDK namespace incompatibility, a Gemini request failure, an
  incorrectly enforced 1,024-token unknown NVIDIA output cap, and Cloudflare catalog name handling.
  Repairs and frozen-provider import checks are in progress before final rebuilding.
- The one-pass OpenRouter free trial consumed its 200-token response allowance before producing a
  final decision card. The initial harness falsely called any nonempty response complete. Manual
  review corrected its evidence to `incomplete`, archived that conversation, and added an explicit
  manually authored review notice to the artifact while preserving its original response/history. No
  additional OpenRouter inference request was sent. Cloudflare connection failed before any
  inference request. Partial output is never accepted as a finished demonstration.
- The first NVIDIA code responses were truncated and contained an incorrect A17 statistic. The
  artifact guard correctly refused incomplete Python. A substantive correction prompt asks for the
  exact sample statistics and runnable tests; the false output cap must be repaired first.
- Real task review found the production deterministic executor could report success without
  executing code. A durable broker continuation, immutable artifact binding, actual Windows
  AppContainer Python/unittest worker, and truthful failure/cancellation evidence are being added.
- Opened native screenshots exposed white chat-list text over bright Copper artwork and broken short
  table labels. Targeted contrast/table fixes and persisted response-limit notices are in progress.
  This is why browser fixture gates alone do not constitute final native acceptance.
- Owner display name `Akshit` was set through Profile and verified after renderer reload. The
  startup appearance/offline hydration correction is committed as `1b9ed77`; it awaits final
  packaged verification. Late auxiliary hydration can no longer revert presentation changes.
- Post-API exact-secret scan: **1,327 owned source/evidence text files, zero exact token matches**.
  No provider values were printed. The scan will run again after the final hosted/local checks.
- The GPU lock still reads `no`; no AI GPU load has happened. CUDA tests follow completed hosted
  checks. Owner app and child processes were closed; security now owns the serialized native app
  slot for disposable backup/recovery/privacy verification.
- Cleanup completed **14,090,396,364 logical bytes of deletion before the new retention
  instruction**. Future discretionary cleanup now archives to `E:\uesless` with reversible hashed
  manifests, committed as `731515f`. The remaining current package/profile/proof roots are
  protected. Moving within E does not reclaim capacity. Historical deletion evidence remains in the
  cleanup ledger.

## Local CUDA observations and additional owner scope

After the hosted checks, the owner profile loaded its verified Qwen3 8B Q4_K_M with the managed
b10679 CUDA 13 runtime through the visible Models action. The load completed in about 33.07 seconds.
NVIDIA observation identified the owned `llama-server.exe` process, with 5,890 MiB total device
memory in use. The 64-token in-app benchmark reported 64.76 generated tokens/second from llama.cpp
timings; this short observation is not a general performance guarantee.

The two-turn **[LOCAL • CUDA] Private notes to a practical action brief** conversation and its
`private-studio-action-brief.md` artifact are persisted in **[LOCAL CUDA] Private Studio Notebook**.
The source/revision and completed assistant messages were read back from the actual packaged app.
Root opened its screenshot and a separate screenshot showing incremental answer text. A deliberately
unsafe 16 GiB VRAM reserve failed with `MODEL_EXCEEDS_VRAM_POLICY`, while the previously loaded
model remained usable. Offline mode was enabled through Settings for the interruption checks.

Stopping real generation preserved 489 characters in a cancelled assistant record. Another check
proved a fresh follow-up completed after cancellation. These runs also exposed misleading cancelled
send text and a missing Stop control on a later run. Commit `f9741c5` repairs durable
cancelled-state rendering, reconciles whether the user message was actually committed, and resets
Stop on each run. Ten focused unit tests and two browser interaction tests passed; final native
verification of the repair is still required. The test conversations are separate from the polished
local demo.

The model was unloaded through the application; the owned inference process was confirmed gone and
the GPU lock restored to `no` at the time recorded in `gpu-lock-claim.json`. The app then exited via
its Close control. The local capability URL found in one provisional status receipt was redacted;
commit `481cbf5` also prevents that private identifier from entering future public status DTOs.

The owner subsequently requested configurable Cupcake group conversations with an add button,
`@mentions`, and intelligent decisions about when to contribute or stay quiet. This is additional
implementation scope, not an accepted mockup. Research, runtime orchestration, interaction design,
and independent interruption/privacy verification are underway. Final package freeze is held until
this feature and the remaining native sandbox checks are integrated.

The provisional host later reopened the local demo against runtime `66BFC30D` and broker `A6E7D7B1`.
Both completed local assistant turns persisted, and opening the history left the managed endpoint
stopped. Root inspected `local-restarted-persisted.png`. Offline mode was restored to its original
disabled setting without sending a provider request. Before the future group schema migration, a
quiescent snapshot preserved all 25 owner data files (5,815,501 bytes), including each database and
its WAL, with matching hashes. The unchanged large local-model directory remains in the owner
profile; the snapshot manifest documents its exclusion.

The exact `294437e` frozen runtime passed actual AppContainer execution and cancellation. Its full
host disposable test passed a saved revision with two tests, recorded a deliberate one-test failure,
cancelled an infinite task, and found zero private-source sentinel occurrences in checkpoint
databases/WAL/SHM and zero remaining continuation/stage files. A corrected case-insensitive profile
scan verified cleanup. The Tasks screenshot raced optional list hydration and is not accepted as a
populated UI screenshot.

The owner profile's actual **Run tests → Allow once** flow then found a different defect: the
runtime reconstructed the approved tool intent with a new timestamp. The broker rejected it with
`INTEGRITY_CHECK_FAILED` before Python execution. This is infrastructure failure, not evidence of a
failing model-generated test. Commit `4ad18e1` binds the timestamp to the durable run creation time;
three focused task tests passed. The exact rebuilt `4ad18e1` runtime then passed the owner profile's
actual Guarded **Run tests → Allow once** flow. The original revision ran all eight tests with one
expected `KeyError: 'A17'`; authenticated native provenance confirms this was a real code defect.
Root used the visible Artifacts editor to save a manual coding-agent second revision, correcting
that assertion and physical CSV line handling and adding two edge-case tests. All **ten tests
passed** in 15.903 seconds with `sandbox:packaged-worker-appcontainer-job` provenance. Root
inspected the passing banner and immutable two-revision history. The earlier NVIDIA draft is
preserved with a manual coding-agent review notice and its conversation archived; no further model
call was made.

This provisional package uses runtime SHA-256
`B1091C05044FD466E885E584419D475528B3B5A157D15B65D51A0DFDB7C454CD`, broker
`A6E7D7B172E03491EFC7B3FD57F0E9D2EDA55BF6CB5FD649C1855792C428894F`, and manifest
`4B70147ECDD34BB9879104FC3FE1AB9BDDC8CACF3CFB810E68A6B92FB0CF608D`. The host/renderer remains the
earlier `BF706D1F` candidate, so final renderer acceptance is separate. The actual task screen
exposed misleading global-model attribution for Python-only work and an unhelpful failed-test
summary; those observations are assigned for correction and final retake. After closing the owner
app, an additional pre-group-migration snapshot preserved all 27 current owner data files (6,047,170
bytes) with matching hashes, excluding unchanged local model weights.

An independent disposable Guarded retake on the same `4ad18e1` runtime then passed two tests,
recorded a deliberate one-test failure, and cancelled an infinite test in 9.018 seconds. Every run
required the exact one-time renderer approval proof. Two durability scans found no private-source
sentinel; continuation files, sandbox stages, AppContainer profiles, and remaining processes were
all zero. Restart restored three durable rows. Root opened that real restart screenshot and found
that failed/cancelled rows lacked clear outcome labels; backend persistence is proven, while the
terminal task presentation is being corrected before the final package.

## Final source qualification and native storage proof

The aggregate group-enabled production source is frozen at `739f524`. Fresh combined qualification
passes **161 JavaScript unit/contract tests**, **87 browser E2E tests** (one wide-only omission of a
narrow-specific test), and **487 Python tests** (one skipped). Broker tests pass 140 with one
intentional native-probe skip; the host passes 29. Both Rust Clippy checks deny warnings, both Rust
format checks pass, strict Pyright reports zero errors/warnings, and mypy covers 121 source files.
All hand-authored Python formatting and full Ruff lint pass; generated Python formatting is owned by
the canonical generator and verified with the passing schema-drift check. The JavaScript lint and
TypeScript gates pass. Repository-wide Prettier still includes untouched historical files and the
owner's two preserved runtime receipts; current changed source and evidence were formatted.

The full run independently found two integration defects beyond scoped agent tests. A worker test
left its intentionally denied socket APIs in the pytest process; its isolated cleanup fix is
`2fe1b49` and leaves production sandbox restrictions unchanged. Older bridge fixtures returned
successful undefined optional group state and crashed the renderer when opening a solo chat;
`739f524` validates those boundaries. All eight affected browser cases and the complete 88-case
matrix now pass. Root also opened the narrow roster/mention and corrected failing-task screenshots.
The pre-final exact-token scan covered 2,090 owned text files and found no matches; final native
demo output still requires a new scan after creation.

Final package construction uses immutable production `739f524`; its runtime production bytes match
the earlier committed `5cb86fd` snapshot. Frozen runtime SHA-256 is
`71BB0C6000D5161FAB071F7298E1EAB902101744A9C247B8F91C97D93E88D407`, broker is
`083E78A27AA6D73AC505290D79BFB017B5CA064C2809BE2587C9BDF0F430C25D`, and manifest is
`461FCE6A38804E91B2C58FEE22344000B8056854159AF46C3CC61316BD20193B`. Six frozen provider
constructions, runtime startup/help, local runtime verification, and independent sidecar integrity
verification pass. Host/installer and owner group/CUDA retakes remain open until their actual
results are recorded below. Older results below are historical checkpoints.

- Production snapshot `359f150` includes provider repairs, startup hydration, provider-preserving
  partial-response continuation, populated wallpaper readability, authoritative artifact revision
  counts, real Windows sandbox execution, and the saved-artifact **Run tests** workflow.
- Full checks at this snapshot: **133 JavaScript unit tests, 62 browser E2E tests, and 457 Python
  tests passed (one Python test skipped)**. ESLint, TypeScript, generated contracts, and Ruff
  passed. Full strict Pyright found 46 annotation/private-helper errors; these are being corrected
  before final source acceptance. Test success alone is not packaged/native acceptance.
- New frozen runtime construction passed six provider SDK/model load checks without network access,
  including the corrected Mistral namespace. The NSIS/executable build is in progress.
- The provisional `49D5969C` package passed actual encrypted-to-plaintext-to-encrypted migration,
  three password-free restarts, real native backup save/cancel, invalid-backup rejection, verified
  isolated recovery, and visible Guarded/Full freedom policy changes. Independent hashing matched
  the 410,293-byte backup receipt. Root opened the backup and verified-recovery screenshots.
- These storage results are intentionally scoped to that provisional package. The final onedir
  AppContainer worker, task cancellation, plaintext-checkpoint source privacy, and worker-profile
  cleanup remain separate native gates. Final owner startup and CUDA demonstrations are pending.
- Backup recovery currently requires the same Windows account/computer and prepares an isolated
  recovery profile; it does not switch the active workspace. Unsupported background delegate kinds
  now fail explicitly. Saved Python revision tests have a real broker execution path whose final
  packaged evidence is still required.
- Root noticed that the real Atlas grounding screenshot showed Northstar in the header/composer.
  Independent source inspection confirmed conversation selection did not synchronize the project ID.
  The runtime rejected mismatched follow-ups with `CONTEXT_BOUNDARY` before provider I/O, preventing
  leakage, but the UI flow was broken. A project-identity mapping and selection fix plus a
  two-project regression are required before the final package; this was not dismissed as a harness
  artifact.
- Typing qualification is repaired without removing the hostile-input guards: full strict Pyright
  has zero errors and full mypy covers 118 source files with zero errors. Full broker all-features
  checks passed 120 library, 10 binary, 6 process, and 3 contract tests; one library test is
  ignored.
- Candidate `BF706D1FF5425A8F66256777E6CBCDB137670BE5189BEDDB1D15C59CF5F9FCBF` ran the repaired
  hosted routes. Mistral and Cloudflare connected through their visible forms; Mistral inference
  returned rate-limit and Google returned provider-unavailable. Cloudflare's first short inference
  hit a local Pydantic output limit, not proven account exhaustion: its compatibility profile sent
  the wrong token-limit field. A source repair is being qualified without another
  Cloudflare/OpenRouter call. All three failed conversations remain archived.
- NVIDIA's completed code replacements contained real correctness errors discovered by reading their
  output. They are retained as model drafts; they are not accepted as passing code. A separate,
  explicitly selected Groq review workflow will inspect the pinned NVIDIA draft and produce a
  corrected artifact before real sandbox execution.
- AppContainer testing found read-only inputs were incorrectly recopied over themselves. Commit
  `9f986bb` preserves identical inputs and rejects attempted mutation. The repaired broker returns
  the native failed-worker result and cleans up its profile/processes; diagnostic preservation and
  final successful execution remain open.
- The installed Qwen3 8B Q4_K_M passed the app's integrity check: 5,027,783,488 bytes, SHA-256
  `d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785`. Its verified b10679 CUDA 13
  runtime is active, but the model remains stopped until hosted checks finish.
- The owner disclosed an always-on TransparencyApp dimming overlay. It is left untouched; direct
  WebView screenshots are used for product color review, and any desktop capture must distinguish
  the overlay from the application.
- Eight additional unused scratch/profile directories were reversibly moved into
  `E:\uesless\CupcakeAI-cleanup-overhaul-20260905-124524-579-18924-30925619`. All eight tree hashes
  and 303,490,887 logical bytes matched after moving; evidence, rollback, active build targets, and
  owner data were preserved. No capacity reclamation is claimed.

## Live group credential restoration correction

The first real owner group attempt on the `739f524` package stopped before any provider request:
Mara was ready, but Quill reported `provider_unavailable`. The broker restored saved native-provider
credentials only for `chat.send`, while group readiness and turns bypassed that path. Commit
`8cb6148` restores saved native credentials through trusted, network-free hydration before
bootstrap, model/provider state, group roster readiness, preflight, and send. The regression went
from `provider_unavailable` to `ready` through the authenticated real broker process. Full broker
checks: 141 passed, one existing native probe ignored; Clippy warnings denied and formatting passed.

The regression also exposed that Windows DPAPI provider storage is scoped to the Windows user
(`LOCALAPPDATA/CUPCAKEAGI/credentials`), rather than an individual workspace directory. `d7ea6e1`
isolates process tests' LOCALAPPDATA as well as their workspace. Before that isolation correction,
the test temporarily replaced the saved Cohere credential with a fixture value. Restoration through
the packaged provider credential flow is required before further live calls; its receipt will be
recorded below. No credential value was printed or committed.

A fresh workspace's native screenshots therefore establish empty workspace behavior with the current
Windows user's saved connections, not an empty credential vault. The final native retake isolates
LOCALAPPDATA to verify the no-provider state separately. Neither screenshot run inserts fabricated
chats.

## Offline switch and first semantic routing trial

Packaged retesting caught an offline-setting mismatch: the renderer wrote `connected` when switching
Offline mode off, while the runtime correctly accepts `direct`, `local`, or `offline`. The visible
switch remained on and the group send stayed blocked. `556703e` writes `direct`. A desktop-bridge
browser regression verifies offline-to-direct-to-offline persistence across a reload at both 1440px
and 390px; both passed, as did scoped lint and desktop typechecking. The group harness now checks
Offline mode before attempting a hosted scenario.

Cohere was restored and verified through the packaged app's dedicated `provider.connect` flow using
the authorized common key file. The redacted receipt is
`E:\temp\cupcake-overhaul-20260905\cohere-vault-restored.json`.

The subsequent real Smart call used Groq GPT-OSS 20B but hit the app's 256-token output allowance
before returning a decision. It used one selector request and zero responder requests. The failed
turn `01a0711a-fae3-766a-baa1-a060e9d9bb74` remains in archived conversation
`[CHECK • GROUP] Selector allowance trial`; no automatic retry occurred. Current Groq primary
documentation confirms this model requires low/medium/high reasoning and counts reasoning within
generated tokens. Its descriptor and the disclosed selector budget are being corrected and tested
before another explicit live acceptance run.

On host `CFCCB108`, runtime `71BB0C60`, broker `8EC999A1`, the saved manually reviewed Harbor
artifact revision `01a070c3-05cd-7daa-b5f0-154c493909e7` passed ten real AppContainer tests again in
run `run_01a0711d-ac34-787a-86c6-2f9e0c23df4e`. Root opened both the artifact result and task
detail: the result is labeled `Local Python sandbox`, `10 tests passed`, and `Finished`; it no
longer implies that the globally selected Qwen model ran the Python tests. These receipts are
preserved under `final-owner-artifact` and `final-task-result.png`, with their exact package
association retained despite later package rebuilds.

## Resumed final qualification

The owner paused and explicitly resumed work. The owned package build was stopped cleanly during the
pause; no app or model remained running, and its partial outputs were preserved.

At `8ca740e`, the combined runtime suite passed **492 tests, one skipped**, with its temporary
workspace under `E:\temp\cupcake-overhaul-20260905\pytest-final-8ca740e`. The combined JavaScript
suite passed **161 tests** and both workspace TypeScript checks passed. Scoped selector checks
additionally proved the real SDK wire uses a 1,024-token completion allowance, low reasoning, no
returned reasoning, and a single HTTP attempt on a simulated 503. The exact-token scan and final
live group/local checks remained pending at that checkpoint.

The follow-up retry audit found real SDK defaults that could exceed the disclosed cap, even though
the coordinator itself never retried. `b5f3085` carries a group-only policy through every retained
provider: one SDK attempt, zero Pydantic output retries, and one Pydantic model request. Solo
behavior is unchanged. Mock 503 transports prove one actual HTTP attempt for compatible selectors
and responders and the Anthropic, Google, and Cohere SDK families; all retained builder routes are
covered. See the expanded Groq research note for primary SDK references and exact observed defaults.

Root also reproduced an unloaded-local persona failure before any model call. The editor submitted a
lifecycle ID rather than the canonical route, and the runtime rejected local models that were known
only to the verified install catalog. `220d105` validates that exact catalog route without
registering a live endpoint or loading weights. The regression went red before the fix and green
afterward, including persona/roster restart persistence and rejection of an invented model ID.
`80e0129` distinguishes an installed model from a ready group speaker and tells the user to load it
in Models. `e2465b3` themes the previously browser-native editor inputs and sliders. Root opened
both wide and narrow final editor screenshots; all **17 group browser checks passed**, with one
intentional wide-only omission of a narrow test. The focused runtime group checks passed 20; persona
unit checks passed nine; desktop TypeScript and scoped ESLint passed. Full strict Pyright is now
zero errors/warnings after the test used public lifecycle status (`e627fa9`).

The aggregate production snapshot is **`e2465b3`**. Final sidecars, executable, and NSIS are being
rebuilt from that exact source. A source-freeze secret scan covered **2,334 text files with zero
exact-token matches**. The final live receipts and owner handoff require another scan after testing.

## Packaged group, CUDA, artifact, and restart acceptance

The `e2465b3` production package was independently hashed by root: host `4ED0E4BE9DD3E303`, NSIS
`E9A9507AC6AEF2AC`, runtime `44D46EAD9D1BDE28`, broker `6AE4A22F42B5D7B2`. The native audit records
the full hashes. These are concrete package receipts, subsequently superseded by the small
corrections below rather than relabeled as evidence for an unbuilt executable.

- The actual Settings switch persisted `offline → direct → reload:direct`. Root opened the final
  Settings capture under `final-offline-roundtrip`.
- Real Groq/Cohere council `01a071de-c082-7bf0-8949-fa3d67492c0e` completed a Smart turn with two
  selectors and two replies, a structured Quill mention with zero selectors and one reply, and a
  quiet closing turn with one selector and zero replies. Six inference calls total. Durable exact
  speaker routes and usage are recorded under `E:\temp\cupcakeai-owner-group-showcase-20260905`.
- Root read the full actual responses, not just their counters. Mara also wrote a fictional
  `Independent Critic – Alex` section inside her answer. That is a model role-compliance defect,
  despite the runtime's correct two-member attribution. `bc40cfd` strengthens each invocation's
  single-speaker system instruction; captured requests verify distinct identities. A new packaged
  live retake is required before treating this council as the polished final example.
- Juniper was created through the real PersonaEditor with installed Qwen still unloaded. Exact route
  `openai-compatible:cupcake-local/qwen3-8b-q4-k-m`, persona `01a071e0-0912-70ef-8936-da06b9a6f645`,
  persisted across reload. The endpoint stayed stopped. Root opened
  `juniper-unloaded-ui/01-configured-without-loading.png` and read the receipt.
- Manual Harbor revision `01a070c3-05cd-7daa-b5f0-154c493909e7` passed ten AppContainer tests in
  `run_01a071e0-7959-70db-b5cb-6fe9238c1e5c`. Exact source digest remains
  `089b36716e0b3bbb17fb880cf35ab296c666a166bc300e8757e61dc02dd036bf`.
- The atomic GPU claim ran from **14:03:01 to 14:04:25 UTC** and finished `passed`. Qwen loaded
  through the app's pinned CUDA 13 runtime; NVIDIA observation showed its exact owned llama-server
  process and 6,131 MiB total device memory in use, including other desktop consumers. A stopped
  response preserved 355 characters, cleared the draft, and allowed a 157-character completed
  follow-up. A direct Juniper group mention while Offline used **zero selectors, one local
  responder, and no cloud routes**. The original council remained quiet before and after. Root
  opened both recovery and local group screenshots. Finally the app unloaded Qwen, no owned model
  process remained, and the marker returned to `no`.
- Actual owner restart reopened the two completed local turns without model autoload. All four
  showcase projects passed durable verification, including the reviewed artifact's ten-test
  evidence. The verification harness initially tried `tasks.execute` to fetch an old result;
  `d8385ff` uses read-only `tasks.get` and its persisted `tool_evidence`. No missing product result
  or repeated Python execution was needed. See `restarted-artifact-task.json` and the showcase
  verification manifest.
- Opened native captures exposed a misleading group-route badge in solo chats and no visible
  paused-member control. `621a029` hides the solo badge, improves Add Cupcake contrast, and exposes
  Pause/Resume with durable membership updates and visible paused identity. **21 group browser
  checks passed, one narrow-only test skipped on wide**; wide/narrow paused-roster screenshots were
  opened. Desktop TypeScript, scoped ESLint, formatting, and diff checks passed.

The owner startup remains under investigation: the exact package took 40,138 ms on one launch and
26,187 ms on the instrumented restart. The latter separates roughly 9.7 seconds before broker launch
from 15.6 seconds in the initial bootstrap, while settings took 23 ms. Warm request timings cannot
rule out cold SDK import or hydration costs. This gate is not closed by faster empty-profile
results.

## Startup integrity and local installer follow-up

Independent tracing ruled out SDK construction in trusted provider hydration: it performs no model
network I/O, and ten source hydration handlers took 0.82 ms in the isolated profiling run. The
packaged owner differential instead measured 11.153 seconds to runtime health with eager local
baseline seeding versus 4.692 seconds without; reverse-order warmed measurements were 4.974 and
4.788 seconds. These observations establish a cold first-touch cost, not a universal steady-state
speed difference. A later cleanup hash pass overlapped separate investigation time and was stopped;
those intervals are not used as a quiet-startup baseline.

`06f7102`, `073aae1`, and `aad07aa` configure signed runtime catalog metadata at opening and defer
baseline installation/archive hashing/version execution until local use. Ordinary runtime status
reads installed metadata without rehashing every CUDA library; it returns `integrity_verified=false`
unless explicitly checked. Installed backend names remain visible as metadata. Activation, load,
version, and device execution now bind installed identity, version, backend, executable, source
revision, and the complete file manifest to the signed catalog before hashing and execution. A
forged install receipt that agrees with tampered binary bytes no longer passes this execution gate.
Unused archive hashing is skipped only when an existing installation passes the signed-artifact
check; companion-set validation remains intact.

The safe NSIS lifecycle passed on package `e2465b3`: installed Home on C took 7.809 seconds, then
product uninstall removed the registration and install directory. A portable reopen of the retained
disposable profile took 4.259 seconds and returned the exact project sentinel through the runtime.
It inherited the ordinary Windows credential vault. Root opened both screenshots under
`final-nsis-lifecycle-e2465b3-r2`; no manual filesystem cleanup was used and all disposable evidence
was retained. This is local reference-machine lifecycle proof, not a clean Windows 10/11 VM or a
two-distinct-version upgrade result.

`2bf28f0` also makes group dialog scrollbars inherit the dialog's actual surface colors. The prior
native dark editor had a pale root-theme scrollbar. Both focused Copper-wallpaper editor flows
passed; root opened the final wide and narrow renders.

## Final source and reversible archive

The final production source snapshot is `1a7e2d7147ef2b740610a0b412bf25efe9927d9d`. Its independent
runtime regression passed **513 tests, one skipped**, strict Pyright reported zero errors, warnings,
or information messages, Ruff passed, and Mypy passed all 121 source files. Explicit integrity
status now uses signed catalog binding as well as the execution paths. The immutable source archive
is `immutable-final-1a7e2d7-20260905-202158/cupcakeagi-1a7e2d7.tar`, SHA-256
`A3B296227787FB5C92E2521FAFCD48EC3E2920FE3879629EC522C24F7F4F6AF8`.

The final cleanup lane moved exactly 18 obsolete directories, 3,022 files and 12,951,766,048 logical
bytes into `E:\uesless\CupcakeAI-cleanup-final-20260905-145615-e8f0a120`. Every pre/post file hash
matched; all 18 sources are absent and all 18 destinations present. The archive manifest hash was
independently checked by root: `C54EE9D4736519A3E20D4B84183F5650A3A4FD1FE511C4326893E7B75602F04E`.
The retained restore worker is `E:\temp\cupcake-overhaul-20260905\restore-final-cleanup.ps1`. No
deletion occurred in this pass, and this E-to-E move does not reclaim drive capacity. Protected
owner/model/build/security evidence remained intact. Hashing finished at 14:57:29 UTC, before final
startup benchmarking was released.

On the September 7 resume, production source still matched `1a7e2d7`, no Cupcake app or local model
process was running, and the GPU marker read `no`. A new exact-token scan covered 2,280 text files
with zero matches. The previously verified archive batch was no longer present in the now-empty
`E:\uesless`; its September 5 verification is historical, and the restore script cannot recover
missing archive contents. The owner profile and protected Guarded evidence remained present. See the
cleanup ledger's resume note. No cleanup deletion was performed on resume.

## September 7 packaged acceptance and final presentation corrections

Root independently matched host `2CC1971528052EC10D43AF85A41D0244200FEAE9E384ABB0D371B39C2228A0A8`,
runtime `DC04202B3268FE63E640D2D5BABD12400C7780CEE9575AEE4863418005022C08`, broker
`6AE4A22F42B5D7B2AD5DB2670C31091E15273F05EF9BA6128E5C3B298E9E9CAC`, and manifest
`EBAB7D5817672911DBD8DB84B6CCFC48505226243284217B7C73E85468ADC7A8`. Production source was `1a7e2d7`.
The first Home took 30.662 seconds while NSIS compression was active, so this is not a quiet startup
benchmark. The installer build later failed with Windows sharing error 32; the live host remained
valid, but no new installer was accepted from that attempt.

The new council `01a07a75-f708-7882-a229-e4c53af5eba9` passed real Smart selection (two selectors,
two distinct Groq/Cohere replies), direct Quill addressing (zero selectors, one reply), and quiet
closure (one selector, no replies). Root read every response: Mara now stays within her own role.
Her draft still proposed weak timing and data handling, so an explicit operator-review turn prepared
by the coding agent requests correction instead of editing model history. Mara's actual revision
uses a 48-hour sequence, preserved raw rows, duplicate flags, nullable readings, and proposed
acceptance checks. These remain draft recommendations, not verified operational procedures. A second
distinct closing prompt also received no reply. The review used one direct responder call and one
closing selector call. Receipts are under `final-group-identity-retake` and `final-council-review`.

Juniper passed actual UI pause/reload/resume/pause in that council with the local endpoint stopped
throughout; no history changed. The helper initially expected the settings popover to remain open
after the membership save, but the product had already closed it. The corrected helper handles
either visibility state; this was a test synchronization issue. Root opened the final member
settings capture under `final-paused-member-ui`.

The reviewed Harbor revision passed all ten real AppContainer tests again in
`run_01a07a78-415c-7e9d-8118-64138058caf7`. Root opened the saved artifact result under
`final-owner-artifact-1a7e2d7`. All four real showcase projects reopened, including two completed
local conversation turns and durable test provenance; group verification was idempotent and made no
new inference calls.

The first new CUDA load was refused before inference: the app estimated 7.3 GB of host headroom
against a 6.3 GB safe budget after the configured 4 GB reserve. The GPU claim was released at
06:08:35 UTC, no model started, and the failure receipt was preserved. Available memory subsequently
increased after test processes closed; the final load retake remains separate from this safe
refusal.

Opened native captures exposed two final presentation defects. `239b8a1` gives group settings and
persona dialogs opaque wallpaper-matched surfaces, removing readable underlying chat text and
recoloring their local scrollbars. All **23 group browser tests passed, one intentional skip on
wide**; root opened all four wide/narrow popover/editor images. `626f890` excludes archived threads
from Home and sidebar recents while retaining the Archived tab. Its actual archive/restore flow
passed at both widths, along with desktop TypeScript, scoped ESLint, formatting, and diff checks.
These renderer-only changes require a final host rebuild; the verified runtime and broker are
unchanged.

## Rebuilt CUDA result and remaining live defects

The renderer-corrected `626f890` host is
`4B75E32EA7FE5771BE196344D9463A8A05D954CC80695E205DD6862ED05DD883`; its unsigned installer is
`D5E042BCF5B306D86EA5E9DA195EAB9F132AA2211B0D8E48C142A1187A38CF15`. Root verified both hashes and
the immutable source archive hash
`7F176B7F4E110B155CBF465BC3596831E415F797EA9A0E7D4CDC3A7B23768DD1`. The runtime and broker retained
their exact September 7 hashes above. Bundle smoke and release candidate audit passed with the app
closed during packaging.

With memory available again, the unchanged 4 GB host reserve permitted Qwen3 8B to load. The GPU
claim from **06:29:48 to 06:30:42 UTC** completed successfully. The app-owned CUDA 13 b10679 server
was PID 27088; NVIDIA observation reported 5,840 MiB total GPU memory in use, including desktop
consumers. Stop preserved 517 response characters; a fresh follow-up completed with 154 characters.
A direct Juniper mention in Offline used zero selectors and one local response while the main
council remained quiet. Root opened `local-stop-identity-retake/03-recovered.png` and
`local-group-identity-retake/local-direct-review.png`. The local checklist is model-generated text,
not actual QA evidence: its suggestion that a layout had been visually inspected was unsupported by
that prompt. It remains an archived diagnostic. App unload succeeded, no owned model process
remained, and the GPU marker returned to `no`.

The post-unload membership retake then exposed stale local readiness: the endpoint was `stopped` and
`activeModelId` was null, yet Juniper's backend availability still returned `ready`. The runtime
trusted a previously registered descriptor's `runtime_loaded` flag. Root preserved the failure, left
Juniper paused, and reopened this gate for a lifecycle correction. This is distinct from the
successful inference and unload result above.

Quiet owner startup also remained slow: **29,818 ms to Home**, 782 ms to CDP, and 15,300 ms for the
initial bootstrap. Process timestamps put broker launch at +13,690 ms and runtime launch at +14,474
ms. These two sequential intervals require diagnosis; the lazy-pack change alone did not close the
startup gate. The native lane owns the follow-up measurements and correction.

Finally, the original active diagnostic `01a07081-9b21-7dee-9fac-8d725aac3cae` was archived through
the runtime with its complete history unchanged. All current acceptance checks remain available in
Archived, while the four real showcase projects and reviewed council stay in normal navigation.

## Final source corrections — 2026-09-07

Direct broker health took 13,951 ms against the owner profile, versus 1,395 ms against the same
database/security state without its local-model directory. Completed download recovery was hashing
1,214,386,338 bytes of retained runtime archives on every startup. `ae7f0bc` restores completed
download metadata using bounded structural checks; registration and installation still reject
same-size tampered bytes. The source manager then configured the exact owner library in 72 ms and
returned status in 209 ms. These source timings are diagnostic, not final frozen-package timings.

Independent review of that trust boundary found a second, pre-existing gap: model load accepted a
digest from a mutable installation receipt. `5612c54` and `7df179d` bind installed model identity,
metadata, path, and bytes to the signed catalog at load and explicit integrity verification.
Metadata-only status now reports `integrity_verified=false`. A forged receipt that matches forged
GGUF bytes is rejected against the signed artifact before runtime execution.

`8a14c36` replaces stale local group readiness with a narrow managed-endpoint snapshot: the endpoint
must be ready, serve the exact selected model, and match the registered route. This avoids hardware
and installed-library scans while reading the roster. Tests cover explicit and idle unload, endpoint
failure, a different model, and a replacement endpoint between preflight and Send. Installed Cupcake
configuration remains intact. The combined focused run passed 54 tests. The full runtime run passed
**524 tests, with one skip**; strict Pyright reported zero errors, warnings, or information
messages, and Mypy passed 121 source files. `60cbc47` then reformatted one existing boolean
predicate without changing behavior; full runtime Ruff and all 174 Python formatting checks passed.
This is the Python source freeze for the final package; native proof follows separately.

## Final scrollbar and keyboard review

Root's opened real council screenshot exposed a pale native-looking transcript scrollbar and weak
message-footer contrast on Copper. Current Chromium reproduction confirmed that root-level color
tokens were resolved before the wallpaper override, while standard scrollbar properties suppressed
the custom WebKit geometry. `fcf2cbe` scopes scrollbar colors to the wallpaper scene and restores
the intended 7 px geometry in WebKit-capable engines. Minimal remains 4 px with a transparent track,
Hidden remains absent, Firefox retains its standards fallback, and forced colors use system colors.
The model picker, onboarding navigation, and intentionally hidden participant tray were checked for
selector-specificity regressions. Four focused interaction checks passed.

Outside-bubble message controls now sit on a solid scene-colored backplate. A separate keyboard
check reproduced invisible focused actions; `7583199` adds the missing `:focus-within` reveal.
Actual Tab traversal reached the control, showed its focus ring, and settled at full opacity. Root
opened the Copper/light/dark/minimal/hidden frames, then the separate settled hover, keyboard, and
narrow action close-ups. No clipping or remaining contrast defect was observed in those components.
These are explicitly browser-renderer proofs; final native captures follow.

Final renderer source is `7583199`; Python source is unchanged from the frozen `60cbc47` runtime.

## Packaged live readiness and private reply — 2026-09-07

Root independently hashed the `7583199` host
`F23FF03694CBDF84CFD7B454AEF97415137C6C893EA449A03F7CBFBF47235A8B`, runtime
`AF89CF95BED9F26148E9EE3AE614EE172DB9F783B301DB5634C8C72D036FB19F`, broker
`6AE4A22F42B5D7B2AD5DB2670C31091E15273F05EF9BA6128E5C3B298E9E9CAC`, support manifest
`4283994C1D7225CAB0B62427D60D78AA71737C45DD90713FADC5BD226E2CE461`, unsigned installer
`1065B4BF64AA59336E567133F3E964B1BF74163E423C2ACAB4D50881A7161018`, and source archive
`2D78A8A7FFC1913E4CAECF7ACBD6CD38447039CEBFFE375428AEE580EB11FC23`. The actual owner profile and
existing launcher WebView directory reached Home in **3,902 ms**.

The first readiness attempt loaded Qwen and passed the live-ready preflight, then stopped before any
model call because the diagnostic required Offline while the restored owner preference was Direct.
The guard failure is preserved as
`local-group-live-readiness-final/precondition-direct-mode-failure.json`; unload and lock release
succeeded. Root switched Offline on through Settings and reran only this unstarted diagnostic.

The successful GPU claim ran **08:04:50–08:05:42 UTC**. Exact Qwen3 8B Q4_K_M loaded through the
app-managed CUDA 13 b10679 runtime. `final-live-readiness/ready.json` records `ready`, the exact
active model, one eligible speaker, and a sendable direct-mention preflight. The new archived
`[CHECK • LOCAL GROUP] Final live-route verification` then produced one actual Juniper reply: turn
`01a07ae6-7502-771e-afbf-89fdfcc6c100`, **zero selector calls, one responder call, no cloud route**.
Root opened the response: three proposed follow-up actions, with no invented completed checks. It
remains a model-generated draft, not operational evidence. The main council's final quiet turn was
unchanged.

After app unload, `final-live-readiness/stopped.json` records `stopped`, null active model,
`local_not_loaded`, zero eligible speakers, and `sendable=false`. Main history was unchanged in both
readiness checks. Actual Pause/reload/Resume/Pause passed afterward in
`final-paused-member-live-route/evidence.json`; resuming showed Needs attention without loading
weights. Root opened the final opaque panel and the wide native editor, council, and narrow routing
panel. The GPU marker returned to `no` with no owned inference process. Direct mode, Groq selection,
and Juniper paused were restored before closing the app.

## Final scratch archive — 2026-09-07

After startup timing finished, exactly 13 completed task-owned
`E:\temp\cupcake-pytest-local-readiness*` directories were moved to
`E:\uesless\CupcakeAI-local-readiness-pytest-20260907-archive`. The bounded no-follow audit retained
2,114 files, 2,315 directories, 189,809,596 logical bytes, and 663 symbolic links with zero type or
target mismatches and no process references. Root independently rechecked all 13 absent sources and
ordinary destination directories. No files were deleted; moving on E: does not reclaim capacity. The
app, owner profile, model weights, current builds, and evidence were preserved.

Execution manifest `cleanup-local-readiness-executed.json` has SHA-256
`92BD7F80315A0C05F25E852DB810CE23EEDF5E5D2E55E838C6D7BCE97DD7183E`; independent verification receipt
`cleanup-local-readiness-verified.json` has SHA-256
`6CDCB91EDD5D3105F7A835D8F86F007373FF327A034E5DF71714182C780454F3`. Both are under the evidence
root. `restore-local-readiness-pytest.ps1 -Execute -ReleaseToken RESTORE_LOCAL_READINESS_PYTEST`
restores the exact paths, refusing overwrites and live process references. Its SHA-256 is
`60C367053B1F2C87559352C7F162AF43ADC83F6B833EFD8A8E6DBBB180305FBA`. Absolute test symlinks may be
dangling while archived; they were preserved without following their targets. This new archive is
separate from the September 5 batch that was already absent when work resumed.

## Owner narrows native qualification scope

A read-only check found VMware outside PATH and an existing Windows 11 VM. `vmrun listSnapshots`
required a password; no guest was booted, unlocked, cloned, or modified. When offered that separate
test, the owner replied: “why you need vm? just test the app as it is here”. This supersedes the
brief's clean-VM requirement for this handoff. Acceptance is on the current Windows installation;
cross-machine/VM and two-version upgrade results are not claimed and are not completion blockers.

## September 7 owner-directed palette and quiet-turn correction

The owner rejected neutral dark transparent boxes beside the wallpaper and the persistent “Waiting
for your next message” panel. Scene-specific control surfaces now use the artwork palette through
the shared paper, raised-paper, soft, and muted tokens. Group member controls and floating panels
retain an opaque readable surface, with brown Copper, green Pistachio, violet Blueberry, and
corresponding colors for the other wallpapers.

The rendered audit found pale-accent primary buttons with white text at only 1.31–1.94:1 and
selected helper labels below 4.5:1 in the default/classic themes. The wallpaper button foreground
now uses the dark scene color; selected helper labels use the main text color. An initial palette
harness changed the CSS palette without replacing the Copper background image. That run establishes
control contrast only; artwork composition requires the corrected image-and-palette retake.

Completed replies no longer leave a second status banner. A genuinely quiet turn instead shows a
small composer-attached “No reply needed” line, with the saved reason and routing budget behind a
keyboard-operable “Why?” disclosure. It starts closed and does not initiate another routing call.
Active progress, Stop, interrupted recovery, and error presentation remain available. Five focused
status unit tests, desktop type checking, targeted ESLint, formatting, and six wide/narrow browser
checks for mentions, Stop, and persisted interruption passed. Their output is under
`E:\temp\cupcake-overhaul-20260905\group-status-final-e2e`.

Actual native keyboard zoom exposed zero-height conversation content at 200–400% in the provisional
`f12e30c` host. `274d303` gives short windows an outer scroll path and group dialogs a single scroll
document. Root opened the corrected 400%-equivalent transcript and persona-field captures: text and
instructions are readable and reachable by scrolling. Native keyboard retakes on the rebuilt host
are recorded separately, rather than treating effective browser dimensions as native proof.

The corrected image-and-palette retake contains 27 receipts with zero Axe color-contrast findings
across all eight wallpapers, four base themes, and Copper Home/Models/Settings. Warning-label
contrast spans 5.946–11.553:1 including base themes. Root independently opened Copper settings,
Pistachio editor, Blueberry and Aquamarine settings with their actual artwork, and Classic settings.
The quiet-turn collapsed and expanded captures were also opened: the closed note is 29 px tall, its
width exactly matches the 800 px composer, and their borders join with a -1 px seam. The stored
history is unchanged and the recorded bridge log has no send or model-load request. Receipts and
opened images are in `palette-audit-274d303-pending`; despite its scratch directory name, these
receipts cover the committed `df9ffb6` palette and `89882fa` status source.

The final product source freeze is `89882fa91b34b7581061e0b07b4c188aa5ba3922`. Subsequent
acceptance-document commits do not change the product binaries. Native packaging and actual restart
evidence must identify this source freeze and the resulting artifact hashes.

A quiet-only constrained follow-up passed at 390×844 and 360×230: Enter opened Why, Space closed it,
the composer remained scroll-reachable, document width matched viewport width, saved history
remained byte-identical, and no send/model call occurred. Root opened the 360×230 expanded state and
verified its visible focus outline and in-flow explanation. The independent palette lane also opened
all sixteen actual wallpaper settings/editor images individually and found no clipping,
bleed-through, or mismatched scene surfaces. Evidence is in
`palette-audit-274d303-pending/quiet-constrained`. The task's browser server was then stopped.

### Final 89882fa package identity

Root independently recomputed every digest after the final native build. The frozen Python runtime,
broker, and signed manifest are unchanged from the actual `7583199` CUDA/readiness run; the new host
contains the zoom, palette, and quiet-status renderer/configuration corrections.

| Artifact                |      Bytes | SHA-256                                                            |
| ----------------------- | ---------: | ------------------------------------------------------------------ |
| CupcakeAI.exe           | 12,779,520 | `E0B36BA64BA277AF6611AFA6EBDC1A06F894A849EC34D1629F936383E4424FFA` |
| Unsigned NSIS installer | 82,458,955 | `E2DC0E04FC7DFAEA68EFA51BA7F3DED2535D5B041F9CE3AB46B0A073B71C390F` |
| Runtime                 | 28,674,525 | `AF89CF95BED9F26148E9EE3AE614EE172DB9F783B301DB5634C8C72D036FB19F` |
| ToolBroker              | 10,749,440 | `6AE4A22F42B5D7B2AD5DB2670C31091E15273F05EF9BA6128E5C3B298E9E9CAC` |
| Sidecar manifest        |    161,448 | `4283994C1D7225CAB0B62427D60D78AA71737C45DD90713FADC5BD226E2CE461` |
| Committed source tar    | 12,247,040 | `39FDC565D38D68589B7AE3EB1FE29C3708A1846E25AACEDA1E68909737FC5388` |

The source archive is `immutable-final-89882fa-20260907/cupcakeagi-89882fa.tar`; root's complete
hash receipt is `final-root-hashes-89882fa.json`. The live executable remains at the E-drive target
used by `Launch CupcakeAI Test.vbs`. Installer generation, local artifact hashing, and source
archiving do not publish or distribute the application.

### Owner stopped zoom testing and required headless UI

On September 7 the owner explicitly stopped further zoom testing as unnecessary and required all
subsequent UI work to stay headless. The visible native test was stopped immediately. Ctrl+0 had
restored normal zoom; root closed the owner app through its own close command and verified no
Cupcake process or 10131 listener remained. The native lane confirmed no zoom/capture helper,
runtime, broker, or local model remained. No further foregrounding, window movement, native input,
or zoom capture is authorized for this acceptance pass. Existing bounded zoom evidence is retained;
additional zoom/OS-DPI/foreground-window testing is outside the updated owner scope.

### Final headless restart, retained demos, and shutdown

The final `89882fa` silent installer lifecycle passed on this Windows installation. Installed Home
was reached in 5,073 ms; product uninstall removed the installation directory and registry record;
the portable app reopened the isolated retained profile in 3,169 ms and found the exact sentinel
`01a07b40-7cde-732f-86bc-41a0e668bfaa`. The receipt at
`final-nsis-lifecycle-89882fa/lifecycle-result.json` has SHA-256
`53DBF2523E95786D298F0CBDE995AD0D39615659E6F12D699D0C74B28DB4A74F`.

Root then launched the owner app headlessly as PID 23284. Home appeared in 3,649 ms, with no browser
errors. The real showcase verifier found all four projects and five completed scenarios, including
the preserved manual artifact lineage and one durable successful execution proof read with
`tasks.get`, without rerunning code or calling a model. The original local conversation retained
exactly two completed assistant turns while the local runtime remained stopped. Root opened the
project overview and local conversation screenshots from this final process.

The owner council was selected through the UI in Harbor. Enter opened Why and Space closed it.
Before/after history SHA-256 was `025bcac0faa5a3be604f136b9cf002f2eb11c43196cb3850e3e325d3328e2399`,
and the immutable turn hash was `99df35c164b04d9625b3c49cb7f5094f658695958087cf9243e8abe55a1b775d`
in both reads. The saved quiet turn remained at one selector call and zero responders. Direct/Groq
selection was restored and Juniper remained paused; local weights were not loaded.

Root closed the app through its own command. All eleven owned processes exited; the observed 2,100
ms includes the close helper's CDP attachment overhead. There were no remaining model processes and
the GPU marker was `no`. Free space at the final close was 238,103,830,528 bytes on C and
215,937,388,544 bytes on E. Evidence is under `final-owner-restart-89882fa`,
`final-owner-showcase-89882fa`, and `final-owner-close-89882fa.json`.

A read-only check of the startup receipt also isolated an existing optional Developer-inspector
limitation: a redundant history request omits the required run ID and its rejection is handled. Live
current-session event inspection still works; cross-run history browsing is not implemented. This
has no startup/chat/provider/local-model effect and is recorded as diagnostic noise, rather than
expanding this final UI acceptance into a new diagnostics feature.

### Final source/evidence hygiene and owner handoff

The final exact-token scan inspected 2,456 owned source/evidence text files and found zero matching
credential values; no values were printed. Receipt: `secret-scan-final-89882fa.json`. The final
13-root archive verification and restore manifest remain retained; however, the final read-only
availability check found `E:\uesless` empty and that archive payload absent. The recorded move and
verification receipts still match their original hashes. This task did not remove the archive after
verification and cannot attribute its disappearance; the restore worker cannot restore an absent
payload. No deletion or new cleanup was performed during the concluding UI checks. All user-owned
unrelated changes remain outside staged files. No app, model, browser test server, or GPU claim is
left running.

The one-click hidden launcher and owner guide identify the four real demo projects, artifact/manual
provenance, bounded group selection, quiet behavior, privacy, and current testing limitations. The
product source remains `89882fa`; later commits reconcile documentation only. Nothing was pushed,
published, distributed, production-signed, or configured for an updater. Owner acceptance remains
the owner's decision after opening the candidate.
