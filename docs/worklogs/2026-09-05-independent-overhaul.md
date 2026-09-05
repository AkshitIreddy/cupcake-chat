# Independent overhaul acceptance ledger — 2026-09-05

Starting commit: `bf689ed`, local `master`. Current evidence only; historical checkmarks do not
transfer.

## Owner acceptance list

- [x] Read `SEE_NEXT_AGENT.md` completely; confirm repository, branch, dirty files, toolchains,
      disk, and GPU marker.
- [x] Independently inspect current architecture and preserved `v1.0.0`; record justified decisions
      with current primary research.
- [x] Inspect every major screen in the existing packaged app before redesign.
- [ ] Coherent visual/navigation/titlebar/wallpaper/avatar overhaul with functional controls and
      readable responsive states.
- [ ] Rich optional, replayable, action-based onboarding and truthful lazy startup.
- [ ] Real optional content encryption, safe migration/recovery, and prompt-free ordinary opening;
      credentials stay protected.
- [ ] Understandable permission presets including explicit Full freedom, with enforced effects and
      safety boundaries.
- [ ] Intent-led, broad searchable model catalog, publisher/route distinction, immediate picker
      selection and honest resource evidence.
- [ ] Connected chat/project/task/artifact/memory/tool workflows with useful guidance and no
      fabricated live claims.
- [ ] Several real hosted-provider, multi-turn demos persisted through the app in the owner test
      profile.
- [ ] After API testing: acquire GPU marker atomically, run app-managed CUDA demo, test
      stop/restart/unload/fit recovery, release marker.
- [ ] Run appropriate contracts/JS/Python/Rust/security/integration gates and inspect
      responsive/accessibility/error UI renders.
- [ ] Rebuild, hash, run packaged Windows app, measure startup/memory/close/process shutdown and
      tray preference.
- [ ] Reopen persisted demos and visually inspect; test installer only without risk to ordinary user
      data.
- [ ] Scan outputs for secrets, preserve unrelated files, record exact evidence/limitations, commit
      atomically on local master.
- [ ] Deliver one-click hidden launcher, capability/demo guide and precise proven/unproven gates. No
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
Root used the visible Artifacts editor to save a user-authored second revision, correcting that
assertion and physical CSV line handling and adding two edge-case tests. All **ten tests passed** in
15.903 seconds with `sandbox:packaged-worker-appcontainer-job` provenance. Root inspected the
passing banner and immutable two-revision history. The earlier NVIDIA draft is preserved with a
user-authored review notice and its conversation archived; no further model call was made.

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
