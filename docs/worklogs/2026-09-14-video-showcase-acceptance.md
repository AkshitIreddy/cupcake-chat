# September 14 owner video showcase

The owner requested a clean test app containing many useful past conversations for later video. The
old collection was moved out before any new projects were created. The replacement contains 10
active projects, 12 featured conversations, 103 complete unique assistant replies across their
branch histories, 26 current artifacts, two active project memories, and two durable code Tasks.
Three failed setup conversations are archived. These are fictional scenarios with real provider
responses, not customer data or fabricated assistant messages.

## Owner entry point

- Launch: `Launch CupcakeAI Test.vbs` in the repository root.
- Profile: `E:\temp\cupcakeai-owner-test-20260902`.
- Recording route and scenario list: `docs/OWNER_TEST_GUIDE.md`.
- All large outputs and private receipts: `E:\temp\cupcake-video-showcase-20260914`.
- Complete content review: `docs/worklogs/2026-09-14-video-output-review.md`.

## Reset and recovery

The packaged app and its 11-process tree were closed before the reset. Existing product databases,
objects, runtime state, and security state were moved to
`E:\temp\cupcake-owner-backups\before-video-showcase-20260914`. Installed model downloads, runtime
packs, window preferences, and the external DPAPI credential vault were retained.
`cleanup-receipt.json`, `clean-workspace.json`, and the inspected `clean-home.png` establish the
empty starting profile. No old project IDs appear in the replacement inventory.

A separate encrypted database backup preceded title organization:
`E:\temp\cupcake-owner-backups\before-artifact-organization-20260914`. Two accidental duplicate
repair-cafe output titles were renamed in a closed-profile, exact-ID transaction with their search
records synchronized. Entity counts, immutable messages and revisions, triggers, foreign keys and
database integrity were preserved. Through the real app API, those artifacts then received explicit
editor revisions containing printable signs and a volunteer shift checklist. The final inventory has
26 distinct project/title pairs. See `artifact-organization.json` and `repair-handouts-saved.json`.

## Real generation and reviewed deliverables

`scripts/fixtures/owner-video-scenarios.json` defines 12 source bundles and 70 initial user prompts.
The scenarios cover a pantry grant report, client scope changes, weighted grades, personal budget,
repair cafe, two CV directions, support triage, donor CSV validation, rainy-day planning,
spreadsheet formulas, meeting decisions, and stock ordering. Later real correction turns remain in
history. No dates, replies, provider metadata, or successful actions were invented after the fact.

Groq and Cohere generated the hosted conversations. Several Groq conversations have real Cohere
follow-ups. Cloudflare performed one successful Smart selection for the repair-cafe group, with two
distinct Cohere persona replies. Qwen3 8B Q4_K_M generated two local conversations through
app-managed llama.cpp CUDA 13. The helper uses explicit offline routing for those calls and never
substitutes a hosted route for a local one.

The model drafts contained material mistakes. Saved deliverables therefore include explicit
user/editor revisions, with original model messages and original artifact revisions preserved.
`editorial/*-receipt.json` records source message, original and reviewed hashes, revision IDs and
authorship. Corrections include arithmetic, unsupported CV claims, deadlines, staffing assumptions,
SLA clocks, and code behavior. Three wide report tables were converted to readable per-item sections
without changing their facts; before/after editorial receipts and rendered previews were inspected.

The collection demonstrates useful iteration, source references, branches, artifacts, memory,
provider choice, local inference and actual saved-code execution. It does not establish that these
models reliably solve every task without review. No email, refund, purchase, cancellation,
application or other real-world action was performed.

## Executed code and local GPU

The donor validator's initial model-authored revision is preserved. A reviewed in-memory,
standard-library implementation includes 18 meaningful tests. The first real AppContainer Task
rejected an unsupported `__future__` import before tests started. Removing that unnecessary import
produced the saved revision that passed all 18 tests: zero failures, errors or skips.

- Successful run: `run_01a09fc7-ace9-78bc-8176-08d682f48afc`.
- Artifact: `01a09fc3-d5bf-7fb4-877c-fa0a37b93a54`.
- Tested revision: `01a09fc7-acd3-737c-b270-c6c268e3df73`.
- Code SHA-256: `af3ee73ba7a1e0d6fd9fbf7de1524a2e1500387d9814ca74df54f518fe83cf41`.
- Actual execution provenance: `sandbox:packaged-worker-appcontainer-job`.
- Receipt: `donor-sandbox-task.json`; rejection: `donor-sandbox-rejected-future-import.json`.

The reopened app's artifact hash and revision ID match the executed input. The real Task details
screen displays **18 tests passed**, and its artifact Revisions screen distinguishes Assistant v1
from User v2/v3. Both screens were captured and opened for visual inspection.

GPU use was guarded by an atomic claim on the shared `gpu use.txt` marker. Claims, readiness, actual
model processes, CUDA backend, NVIDIA observations, unload, and release are recorded in
`gpu-readiness-claim-*.json`, `native-load-*`, `native-gpu-observation-*`, and `native-unload-*`.
The local model is left unloaded; opening saved conversations does not consume model VRAM.

## Group acceptance boundary

The featured repair-cafe chat has three configured personas, 12 complete persona replies, and an
active **Event run sheet** branch. Smart turn `01a09fc4-262a-7c95-b503-162412f3e898` selected Remy
then Quill and completed both replies. The main branch retains unsuccessful selection trials. The
reviewed run sheet and two practical handouts are saved in its project.

Automatic quiet closing is not verified. Trials returned provider errors or
`GROUP_SELECTOR_INVALID`; raw selector output was not retained, so an exact parser cause is not
claimed. The recording guide excludes this behavior. Google and Mistral attempts also encountered
provider-unavailable and rate-limit respectively. They are not counted as successful demos.

## Packaged visual and persistence checks

All UI work used offscreen CDP against the actual Windows Tauri executable, at its restored owner
window size, without zoom testing, a VM, visible consoles or foreground UI automation. The owner's
screen-dimming overlay does not affect these renderer captures.

Inspected views include the empty Home, ten-project gallery, client email conversation, repair-cafe
roster and transcript, local budget conversation and Memory, CV branch switching,
grant/support/stock artifact previews, donor revision history, and Task list/details. CV Main and
Customer success direction were selected through their actual branch buttons and the latter
restored. Wide document tables were corrected after observing horizontal clipping in the original
preview.

`verification.json` verifies every featured conversation, complete replies, branches, provider
metadata, source hashes and current artifact hashes. `final-inventory.json` separately checks the
10/12/26/2/2 counts, distinct artifact titles, current handouts, saved-versus-executed code
identity, and unloaded local-model state. `group/repair-cafe-group-verification.json` is the final
read-only group proof; earlier failed harness receipts remain historical attempts.

The pre-label-fix product `c0e08ac` reopened to Home in 2,361 ms on this run. These are one-machine
observations, not general performance guarantees. A visual check then found a local-history model
label defect, described below.

## Local-history label diagnosis

The actual unloaded local conversations displayed **Model unavailable**. Commit `5c58e60` corrected
one catalog mismatch: persisted compatible-endpoint identity can now resolve the app-managed
`cupcake-local:<native-id>` catalog form. Its regression failed before the change and passed after
it, with 8/8 focused tests and a successful desktop typecheck. This was insufficient for the actual
showcase: the rebuilt native app still reproduced the bad label.

Read-only inspection then established that these replies stored `model_id=qwen3-8b-q4-k-m` and
`provider_id=openai-compatible`, but their canonical metadata had no `_providerContinuity` or model
family endpoint. The existing history cannot establish the endpoint from those fields alone. The
CUDA conclusion comes from the separate actual app execution receipts, not a guessed label.
`visual-local-label-before.png` preserves the observed failure. The subsequent fix separates a
faithful saved-model display from the strict resolver used for routing and continuation; immutable
message metadata is not rewritten.

The first NSIS attempt returned Windows error 32 after the operator opened the executable before
bundling had completed. The app was fully closed before the subsequent build. This failed attempt is
retained in `build-5c58e60.log`; it is not successful installer evidence.

Commit `276be8d` addresses the actual metadata gap with a label-only fallback. The rebuilt app
displayed **Qwen3 8B · Q4_K_M · Saved response** in both local conversations while the model was
unloaded. The endpoint resolver remains strict and does not turn display-name matching into a
continuation route. `local-history-provenance-diagnostic.json` records the observed stored fields.

## Project gallery count diagnosis

The final gallery review found that every non-selected project displayed zero chats despite its
conversations opening correctly. The view was counting the active project's scoped chat list for
every project. `visual-gallery-counts-before.png` preserves the native failure.

Commit `9f5a571` introduces a separate metadata-only conversation-count inventory. One global
`conversations.list` request returns summaries, not chat contents; the active project's conversation
state remains scoped. Archived chats are excluded. Creation and archive changes update the count
cache. The runtime caps this inventory at 2,000 summaries; reaching that cap makes counts unknown
and the UI shows **Open Chats**, rather than representing a partial total as exact. Focused tests,
desktop typechecking, and all 89 desktop tests pass.

## Final package and owner state

The final product source is `9f5a57100a7f69aeddb0d9321e18efc22009fe42`, with unchanged packaged
runtime source `8a25eb7`. The full NSIS build completed with the owner app closed. No installer was
published or installed during this renderer-only correction; local installer lifecycle evidence from
earlier work is historical. Current bundle checks establish packaging integrity, not a new
installation or cross-machine qualification.

| Final artifact          |      Bytes | SHA-256                                                            |
| ----------------------- | ---------: | ------------------------------------------------------------------ |
| CupcakeAI.exe           | 12,782,080 | `084727E8EDB26383361843E04D1779B5844B563864A9F957C79359D9C9C7FD46` |
| Unsigned NSIS installer | 82,462,405 | `0AB8B18A47E35BAF20A9A616D4F6342A45A52D2A5664D5D4DD525574FD38A798` |

`final-package-hashes.json` also records the unchanged runtime, broker and sidecar-manifest hashes,
plus the exact source archive. `build-9f5a571.log`, `package-smoke-9f5a571.log`, and
`package-audit-9f5a571.log` record successful build, bundle smoke and local-candidate audit.

The exact final executable opened Home in **2,560 ms**, with no browser errors. The native gallery
showed Data Cleanup Workshop and Small Business, Less Panic at two chats each, and the other eight
projects at one each. `final-project-counts.json` verifies all ten displayed counts; both captured
gallery sections were opened and inspected. The final Qwen badge and **18 tests passed** Task
details were also reopened and visually inspected. All 12 conversations passed final verification;
their source artifacts, saved deliverables and handouts match the recorded content. Both active
memories persist, and the saved donor code remains identical to the executed revision.

Final process-tree shutdown took **1,234 ms**, leaving no owned app/model process and the GPU marker
at `no`. `final-owner-close-9f5a571.json` records the tree and disk observations. A closed-profile
snapshot at `E:\temp\cupcake-owner-backups\video-showcase-20260914-complete` contains 77 files,
5,040,693 bytes, with every copied file hash checked against the source. Model downloads were
excluded from this small recovery copy. See `completed-profile-backup.json`.

## Checks and handoff

Focused helper syntax, ESLint, Prettier and whitespace checks passed before commit. All 89 desktop
tests pass, together with the focused endpoint-provenance and project-count regressions and desktop
typecheck. The exact token scan checks changed source and this task's text evidence against the
authorized key file in memory, printing no credential values. `secret-scan.json` records 531 scanned
text files with zero exact-token matches. Recovery copies and useful evidence remain on E:; no
unrelated project's storage was touched during collection creation.

All changes are reversible local master commits. The four pre-existing unrelated dirty files from
the original handoff are preserved. Nothing was pushed, published, production-signed or deployed.
