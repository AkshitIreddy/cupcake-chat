# CupcakeAI 1.0 product and migration audit

**Date:** 2026-09-05

**Current tree inspected:** local `master` at `bf689ed453efe65dd9ee9de2ab531354f58588e2`, plus
concurrent 2026-09-05 work

**Preserved product inspected:** tag `v1.0.0` at `446d7c8b3e642104fb5931fa1bb2fe3327703ebd`
(2023-04-25)

**Scope:** product intent, frontend, `state_of_mind`, backend behavior, current 2.0 architecture,
and one-time migration. No tracked environment file, credential value, owner profile, or live model
was opened or used.

## Executive judgment

CupcakeAI 1.0 had one unusually coherent product idea: a persistent assistant named Alex could talk,
remember, accept a longer task, and remain present while that task continued. Its rainbow cupcake
scene, visible thought/emotion/sense output, and modular abilities made that idea easy to recognize.
The implementation did not safely deliver the promise. Its navigation was decorative, upload support
was image-only despite broader claims, task execution was not durable, memory was lossy, and
generated Python was installed and run without an adequate security boundary.

CupcakeAI 2.0 has the correct technical center: a brokered desktop boundary, private authenticated
runtime, encrypted product-owned data, explicit providers, typed memory with provenance, durable
task records, immutable artifacts, and honest model routing. The main product risk is fragmentation.
The deeper capabilities can read as separate administration screens rather than one continuous
relationship between a conversation, its task, the evidence used, and the artifact produced.

The overhaul should recover the old continuity and character while keeping 2.0's truthfulness. It
should not recover simulated consciousness, numeric emotions, unsolicited dreams, or unsafe
generated-code execution.

## What 1.0 actually was

The preserved frontend is a single full-screen chat over a blurred rainbow background. A fixed glass
header advertises Multisensory, Emotions, Persistent Memory, Random Thoughts & Dreams, Special
Abilities, and scheduled tasks, but each item links to `#`; none is a usable destination. The
conversation renders every response as a stack of answer, thought, emotion, and sense bubbles. The
composer has Upload and Send controls, but its file input accepts images only.

The backend intended two modes:

- **Talk** answered in the foreground and could select a predefined ability.
- **Task** accepted work with a start time or deadline, processed it in a background loop, and let
  the user continue chatting.

State lived as mutable files under `state_of_mind/`: conversation, task list, personality, a thought
bubble, six emotional scalars, and three sensory values. The default persona was Alex: motivated,
goal-oriented, curious, capable, productivity-focused, and interested in mystery, supernatural
subjects, space, and nature. The old values for emotions were random-walk prompt inputs rather than
observations. Senses were usually “not activated.” The thought bubble contained topic seeds rather
than an explainable record of context actually used.

Long conversations were summarized and replaced with a summary plus recent messages. Summaries could
be embedded into Chroma. This preserved a rough sense of continuity, but it discarded source detail,
had no user-visible provenance, and could incur cloud work implicitly. Background waits could
generate dreams, random thoughts, and mental simulations and inject them into the conversation
without a direct user request.

The most serious implementation boundary was generated code. The Talk path could ask a model to
write Python and requirements, install dependencies, run the script through a shell, and retry based
on model-readable errors. There was no equivalent of the 2.0 tool broker, scoped grants, approval
record, network boundary, or durable cancellation.

## Product ideas to retain and retire

| 1.0 idea                                   | Product value                                          | 2.0 treatment                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A recognizable assistant                   | Makes a complex workbench approachable and memorable   | Keep as a user-selectable visual identity and communication preset; keep model/provider identity separately visible                             |
| Talk while longer work continues           | The strongest original workflow                        | Make a conversation-to-task handoff explicit, preserve the originating turn, and show real task events inside the conversation                  |
| Persistent conversation and memory         | Gives work continuity across sessions                  | Keep through immutable messages, typed memories, scope, evidence, and user review                                                               |
| Thought bubble                             | Shows what the assistant is focused on                 | Recast as a **context trail**: project, files, memories, tools, and task/artifact links actually used for the run                               |
| Multisensory input                         | A useful promise when real                             | Support image/audio/video only after the complete attachment-to-provider route is implemented; otherwise label metadata-only ingestion honestly |
| Modular abilities                          | Makes capabilities discoverable                        | Keep as brokered tools with effects, permissions, route, audit, and availability states                                                         |
| Scheduled tasks                            | Useful for multi-step or later work                    | Keep through durable tasks with pause/resume/cancel/recovery and exact event history                                                            |
| Numeric emotions                           | No reliable relationship to user intent or model state | Retire; use explicit user-selected communication style and factual operational status                                                           |
| Dreams and random thoughts                 | Distinctive but unsolicited and misleading             | Retire as default behavior; an optional suggestion inbox can surface bounded, dismissible ideas                                                 |
| Generated Python plus package installation | Flexible but unsafe and difficult to reproduce         | Only allow through the 2.0 broker, sandbox, declared effects, approvals, resource limits, and captured artifacts                                |

This mapping follows the current architecture. `ADR-0004-MEMORY-AND-CONTEXT.md:7-24` replaces mixed
“state of mind” with typed, lifecycle-controlled memory; lines 38-58 require visible personality
controls and a safe Context Inspector; lines 63-81 reject active simulated consciousness and
unapproved inferred instructions. `ADR-0007-MIGRATION.md:27-35` defines the legacy dispositions.

## UI and personality direction

The product should feel like a **confectionery instrument panel**: warm and tactile enough to be
CupcakeAI, precise enough to trust with real work. The visual subject is a working assistant, so
status, provenance, and transitions should provide the ornament.

Use one signature device throughout the app: a restrained **frosting thread** that connects the
originating conversation turn to a task, the task to its evidence, and the result to an artifact or
memory. It can appear as a thin route line with compact nodes, never as unexplained colored dots.
Clicking a node should open the exact source. This recovers the old sense of one living assistant
while encoding real provenance rather than fictional thought.

The preserved rainbow mascot and gradient should remain available as a clearly named Classic Cupcake
theme. Use the rainbow as a peripheral light wash, first-run moment, or active route accent. Avoid
full-spectrum card fills and multicolored text, which compete with task state and provider routing.
A strong default family is warm parchment, ink-ganache text, raspberry action, pistachio success,
blueberry local/cloud route, and copper task state, with contrast verified in every wallpaper.

The assistant should have a stable portrait beside assistant turns and task handoffs. A user can
choose a built-in cupcake, upload a custom portrait, and optionally name the assistant. The portrait
must not imply that a provider model has a persistent internal identity. Provider, model,
local/cloud route, and tool activity remain explicit run facts.

Personality must be a real behavioral control. The current renderer exposes Classic Cupcake,
Balanced, Focused, and Playful (`apps/desktop/src/renderer/App.tsx:7510-7523`), but Classic Cupcake
and Playful both map to the runtime's same `warm` instruction. The runtime already has distinct
`creative`, `analytical`, and `technical` instructions
(`services/runtime/src/cupcake_runtime/personality.py:30-55`) that the renderer cannot select. This
produces false differentiation. Give every visible card a unique stable preset key and tested
instruction. A sensible mapping is:

- **Classic Cupcake:** curious, warm, lightly playful, with optional inherited Alex interests shown
  before activation.
- **Balanced:** warm, clear, capable, and scan-friendly.
- **Focused:** direct, compact, and low-distraction.
- **Playful:** expressive and creative while preserving factual precision.
- **Analytical:** conclusions, assumptions, tradeoffs, and checkable evidence.
- **Technical:** analytical with implementation detail and exact constraints.

Imported Alex personality text must appear as an inactive candidate with source and preview. The
user may accept, edit, or discard it. It must never silently become the system personality.

## Current functional consequences

The 2.0 workbench already has the right destinations: Home, chats, projects, tasks, artifacts,
memory, models, tools, search, settings, and developer evidence. The better journey is a single path
through them:

1. Start or reopen a conversation in a visible project boundary.
2. Attach a file and show the exact route and supported modality before sending.
3. Promote multi-step work to a task without losing the originating messages.
4. Keep chatting while the task emits real events.
5. Open the resulting artifact at its exact revision.
6. Review any proposed memory with evidence and scope.

Media is not yet an end-to-end version of the old “multisensory” promise. The ingestion service
routes media to `_ingest_media`, which returns `PARTIAL` and warns that content extraction is
unavailable (`services/runtime/src/cupcake_runtime/ingestion/service.py:445-474`). Provider chat
requests are text-oriented. A catalog claim that a model understands images is therefore
insufficient. The composer should distinguish “model can accept this modality through this provider”
from “Cupcake can store this file” and “only metadata will be indexed.”

The Context Inspector should only display the context manifest prepared for the active run. Enabled
memories are eligibility, not proof of retrieval. Token estimates should be identified as estimates
and replaced with provider/runtime usage when available. Every item shown as “used” needs a
run-linked citation.

## Migration audit and corrections

The accepted migration design is sound: read-only source, preview, explicit execution, idempotent
ledger, paused tasks, inactive personality/thought candidates, emotion/sense report-only, no
executable registration, and no credential import.

The stricter staging design is also consistent with current primary guidance. OWASP recommends an
allowlist of only the extensions required for the business function, generated storage names, size
limits, non-public storage, and layered content validation; it explicitly treats a denylist as
supplemental rather than the main boundary
([OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html),
[OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)).
Microsoft likewise advises validating file content before a Windows app takes action on an activated
file
([Microsoft Windows file activation guidance](https://learn.microsoft.com/en-us/windows/apps/develop/launch/handle-file-activation)).
Microsoft packaging guidance calls for an explicit settings/data migration because package
identities and storage locations differ and recommends clean-Windows packaging tests
([Microsoft Windows packaging overview](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/packaging/)).
These checks support the chosen broker picker, private staging, exact allowlist, preview, and
clean-install E2E gates.

The audited implementation diverged in several material ways. The 2026-09-05 correction set
addresses these defects:

- **Broken broker/runtime path contract:** the broker wrote `migration-staging/<id>/source` with a
  sibling manifest while the runtime accepted only `broker-migration` and reconstructed
  `source/manifest.json`. Staging now uses `broker-migration/<id>/source`; the runtime validates the
  broker-supplied sibling manifest, exact staging token, fixed `source` name, containment, file
  type, and digest.
- **Over-broad staging:** the broker recursively copied every regular file before the importer
  ignored most of them. It now prunes unrelated directories and stages only the exact
  `state_of_mind` files and exact Chroma JSON/SQLite filenames the importer consumes. Environment
  files, credential-named files, code, bytecode, dependency trees, build output, and generated
  directories are excluded before file contents are opened or copied.
- **Active imported steering:** the sink activated the legacy personality as an explicit instruction
  and created an active task-state memory. Personality now imports as a non-explicit candidate.
  Legacy tasks import as paused historical records with no active task-state memory. A schema
  migration converts any earlier `pending` legacy task rows to `paused`.
- **Synthetic state became memory:** emotion and sense records were inserted as memory candidates.
  They now remain only in the migration report/ledger with no memory entity.
- **Misleading preview counts:** the runtime returned per-kind `counts`, while the dialog read
  `conversations`, `memories`, `tasks`, and `files`, producing zeros. The report now supplies stable
  product summaries and message count; the dialog also derives compatible fallback values from
  `counts`.
- **Terminal state mismatch:** the renderer checked for a nonexistent `completed` state, so
  successful `imported`/`no_data` migrations could reappear. Those states now close and remain
  hidden.

The correction is covered by runtime migration tests, product-sink persistence/restart tests, a
v2-to-v3 database upgrade test, a private preview containment/digest test, and a broker snapshot
allowlist test. The Python migration/database suite, desktop TypeScript check, and focused Rust
broker library test pass. A full broker binary test was temporarily prevented from compiling by
unrelated in-progress `main.rs` artifact-export edits in the shared worktree; the migration library
seam itself is green.

## Migration work still missing

These are separate capabilities rather than narrow defect corrections:

1. **Legacy abilities:** `abilities.json` names/descriptions are not imported or listed as untrusted
   legacy-tool candidates. Add report-only candidates with source metadata. Never copy, register, or
   execute ability scripts.
2. **Referenced files:** conversation attachment paths are preserved as labels with
   `attachment_available=false`; the referenced bytes are not imported. Add a second explicit review
   step that resolves each file through a fresh broker handle, validates
   containment/size/type/parser output, and copies accepted content into encrypted objects. Never
   follow a legacy path automatically.
3. **Per-item disposition:** the ledger records kind/source/entity but not the full proposed
   disposition/error model described by ADR-0007. Add imported/skipped/rejected/requires-review
   status, safe reason codes, and original/import timestamps.
4. **User-reachable import:** migration must remain available from Settings > Storage even when
   startup detection finds no configured legacy root. The action should open the broker directory
   picker, then the preview dialog. Do not require an environment variable or first-run
   auto-detection.
5. **Migration report:** preserve a durable, user-visible report after completion, including
   imported message/task/memory totals, report-only emotion/sense totals, ignored filename
   categories, warnings, and a link to each created entity. Do not display possible secret values or
   raw native paths.
6. **End-to-end desktop coverage:** drive Settings → choose folder → preview → import → restart
   against a synthetic non-secret v1 tree. Assert exact counts, paused/inactive states, no staged
   excluded files, no duplicates on retry, and cleanup after execute/decline/failure.

## Acceptance implications

The redesigned app should be judged on continuity rather than the number of destinations. A real
demonstration should show one cloud conversation, one alternate-provider conversation, and one
local-CUDA conversation that each visibly connect project scope, exact model route, context actually
used, task progress, and artifact revision. Classic Cupcake can supply the distinctive emotional
register, but every visible status must come from real product state.

The legacy import should not be called complete until the user can start it from Settings on an
ordinary installed profile, preview truthful counts, import without copying excluded files, verify
that historical tasks are paused and personality is inactive, restart without duplication, and open
the durable report.
