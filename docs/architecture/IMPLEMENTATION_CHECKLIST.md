# Corrective Tauri implementation checklist

Checked means implementation and relevant observed evidence both exist. The dated
[acceptance ledger](../worklogs/2026-09-05-independent-overhaul.md) identifies exact source/package
versions; historical results are not silently transferred to changed behavior.

The September 8 owner refinements and everyday conversations are tracked separately in the
[reading and showcase ledger](../worklogs/2026-09-08-reading-and-everyday-showcase.md). Its
[package audit](../research/2026-09-08-package-audit.md) supersedes the September 7 artifact hashes;
the earlier installer lifecycle remains evidence for the unchanged installer behavior.

## Host and package

- [x] Actual Windows Tauri host boots with its private verified runtime and broker; no separate
      Python, Node, Conda, or model-server installation is needed for the packaged app.
- [x] Typed commands/events, generated capabilities, navigation policy, and sidecar verification
      pass.
- [x] Thin titlebar, restored/narrow layouts, keyboard controls, and forced-color glyphs have
      inspected rendered evidence. Default Close exits; final aggregate tray/process checks are
      tracked below.
- [x] Active source/dependencies/packages contain no removed local-server integration.
- [x] Target-triple sidecars, resources, executable, and unsigned NSIS pass integrity smoke.
- [x] Local reference-machine NSIS install, actual first run, product uninstall, registration/path
      removal, and exact retained-project reopen passed on `e2465b3` and `7583199`.
- [x] Final `89882fa` package integrity, headless startup, silent installer lifecycle, retained
      profile reopen, and complete process cleanup pass after all product corrections.

On September 7 the owner explicitly requested testing on this Windows installation only. VM and
cross-machine upgrade qualification are outside this owner test scope. The owner's later
headless-only directive also stops foreground window/tray and further zoom testing. Final visible
tray hide/show is not claimed.

## Models and providers

- [x] Retained providers have app-owned disclosure, key entry, connection/discovery, masked saved
      identity, reconnect, and removal flows; adapter construction and error contracts pass.
- [x] Invalid/cancelled/offline/rate-limit/redaction behavior has focused coverage. Real provider
      errors remain preserved and are not presented as successful demos.
- [x] Real multi-turn Groq, Cohere, and NVIDIA NIM conversations, artifacts, and grounded memory
      persist in the owner profile. Google/Mistral/Cloudflare/OpenRouter limitations are recorded.
- [x] Fresh packaged no-model/no-credential profiles show a nonempty signed local catalog and hide
      unavailable chat routes by default.
- [x] Catalog/search/ranking/download recovery/checksum/removal behavior has focused lifecycle
      tests.
- [x] Existing pinned Qwen3 8B weights were verified and loaded by the actual packaged CUDA runtime.
      Streaming, Stop, fresh follow-up, graceful fit refusal, benchmark, unload, and real restart
      persistence have observed evidence. Owner weights were retained.
- [x] Startup/status reads no longer install or repeatedly hash local runtime packs. Signed catalog
      binding and complete file verification precede runtime execution; explicit integrity status
      uses that same signed binding. Tampered receipt plus binary is rejected.
- [x] Current frozen runtime passed exact-model load, one real Offline direct-group response,
      unload, and live non-sendable readiness after unload in the `7583199` packaged app.
      Stop/fresh-follow-up evidence is separately recorded on `626f890`.

## Visual and accessibility

- [x] Home, Chats, Projects, Tasks, Artifacts, Memory, Models, Tools, Search, Settings, Developer,
      About, provider/model dialogs, onboarding, empty/error states, and populated work have opened
      screenshot evidence. Direct packaged screenshots are distinguished from browser bridge tests.
- [x] Wallpaper continuity, identity/avatar consistency, thinner title strip, command search,
      deliberate scrollbars, and themed dialogs are implemented and inspected.
- [x] Optional action-based onboarding is replayable and contained at narrow sizes.
- [x] Browser matrix covers 390/768/1440/2160 widths, light/dark appearances, four wallpapers,
      keyboard, forced colors, reduced motion, and overflow. Four tested chat variants have zero
      serious or critical Axe findings. Group controls have wide/narrow error, cancellation, and
      recovery proof.
- [x] Scene-colored controls and quiet-turn presentation have inspected captures across all eight
      wallpapers and four base themes. The 27-surface contrast audit passes; quiet-note keyboard
      interaction and unchanged history pass at 390×844 and 360×230 without model calls.

The owner stopped further zoom testing on September 7 and required all subsequent UI work to remain
headless. Existing native shortcuts and bounded layout evidence are retained; no further zoom or
foreground-window test is an acceptance gate. OS-wide DPI changes and audible Narrator/NVDA
streaming remain unqualified.

## Core and security

- [x] Relevant contract, JavaScript, Python, Rust, security, and interaction gates have passed as
      recorded per change. Final runtime aggregate regression is tracked in the acceptance ledger.
- [x] Encryption on/off/on migration, prompt-free normal opening, object integrity, project scope,
      immutable history, indexing, and backup validation/recovery have concrete evidence.
- [x] Guarded and explicit Full freedom controls affect policy; non-bypassable containment remains.
- [x] Real saved Python artifact execution distinguishes original failing draft, manual revision,
      ten-test success, infrastructure errors, and cancellation. Durable result/provenance survives
      process restart and is read without re-execution.
- [x] Forgery/replay, grants, traversal/junction, prompt injection, redaction, sandbox limits, and
      process-tree checks have focused coverage; exact-secret scans report zero matches so far.
- [x] Tested chat/group/task interruption and recovery do not automatically repeat completed work.

Fault-injection evidence covers the recorded boundaries and scenarios. It is not a claim that every
possible process-kill timing or combination has been exercised.

## Cupcake group conversations

- [x] Reusable Cupcakes have identity, portrait, role, personality, exact model, contribution
      guidance, structured mentions, and pause/resume membership controls.
- [x] Runtime Smart selection is bounded, can leave a turn quiet, and has no autonomous loop or
      arbitrary fallback. Group SDK/output retries cannot exceed the disclosed model-call budget.
- [x] Real Smart two-provider turn, direct Quill mention, and quiet closing turn passed. The first
      routing-successful council had an extra fictional role inside Mara's text; single-speaker
      instructions were strengthened and passed the recorded live retake.
- [x] Direct local Juniper mention in Offline used zero selectors and one local response. No cloud
      route ran, and the main council remained quiet.
- [x] Durable identity, Unicode spans, authorization/privacy drift, concurrent turns, whole-turn
      Stop, partial failures, restart interruption, and bounded context have independent test
      coverage.
- [x] Installed-but-unloaded local Cupcake configuration works without launching inference.
- [x] Rebuilt owner council single-speaker output, native Pause/Resume persistence, and local direct
      mention retakes are complete and visually accepted.

## Owner handoff

- [x] Hidden one-click owner launcher exists; ordinary fresh profiles receive no fabricated work.
- [x] Four real showcase projects, preserved model/manual artifact lineage, and saved results
      survived actual app restart.
- [x] Final exact hashes, startup/working-set/close measurements, source snapshot, screenshot paths,
      remaining limitations, and owner guide are reconciled.
- [x] Final secret scan, archive cleanup verification, and final GPU/process check are complete.
- [x] No push, publication, distribution, production signing, or updater activation occurred.
- [ ] Owner explicitly accepts or rejects the candidate; this decision belongs to the owner.
