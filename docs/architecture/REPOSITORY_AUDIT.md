# Repository audit

**Snapshot:** 2026-08-28
**Branch observed:** `feat/cupcakeagi-2.0`
**Baseline commit observed:** `ab7e3f0` (`chore(repo): establish 2.0 implementation baseline`)
**Decision:** Replace the runtime and UI in place while preserving Git history, `v1.0.0`, product provenance, and selected visual assets.

## Baseline state

The clone has already been flattened into the outer workspace. The repository root contains `.git`, the legacy `backend/` and `frontend/` trees, documentation, and root configuration; there is no remaining `CUPCAKEAGI/` wrapper directory. The local 2.0 branch and an LF-first `.gitattributes` policy are present. The historical `v1.0.0` tag resolves to `446d7c8` and must not be moved or rewritten.

The baseline is a 2023 web application:

| Area | Current implementation | Audit result |
|---|---|---|
| UI | Next.js 13.3, React 18, Tailwind; one chat page and simple navigation | Replace with Electron + React/TypeScript/Vite; retain original mascot artwork for About and Classic theme |
| API | FastAPI/Uvicorn on a separately launched localhost server | Remove from the product boundary; no public localhost API in 2.0 |
| Agent | LangChain `0.0.147`, OpenAI `0.27.4`, hard-coded GPT-3.5-era behavior | Replace with product-owned contracts and Pydantic AI adapters |
| State | Mutable JSON and text files in `state_of_mind/` | Import once into encrypted relational storage; never use as live 2.0 state |
| Tasks | FastAPI background work plus an uncheckpointed polling loop | Replace with durable DBOS workflows and persisted canonical events |
| Tools | Model-generated Python and requirements executed via `subprocess.run(..., shell=True)` | Security-critical removal; replace with broker-mediated structured intents and a staged sandbox |
| Retrieval | Legacy Chroma/OpenAI embedding path mixed with conversation mutation | Replace with project-filtered FTS5 baseline and rebuildable semantic indexes |
| Secrets | A tracked `.env` file contains provider/configuration slots | Remove from the active tree and Git index; rotate any credential ever placed there; migration must never read or import it |
| Generated state | Tracked `__pycache__`, `.pyc`, temp output, conversation/task state | Remove from the active tree; ignore thereafter; preserve only in historical commits |

## Confirmed security and reliability findings

- The FastAPI service accepts credentials compared with hard-coded literals and enables wildcard CORS. This is not an acceptable desktop trust boundary.
- Uploaded filenames are transformed and written under a relative `tempfiles` directory without the brokered grants, staging, content checks, or symlink defenses required by 2.0.
- Both talk and task paths create model-authored Python and dependency files, then invoke a composed command string with `shell=True`. Generated code therefore inherits the user's ambient credentials, network, filesystem, and process rights.
- Conversation, emotion, thought, memory-count, and task state are updated through multiple independent JSON/text writes. A crash can leave mutually inconsistent state, and there is no schema migration or integrity boundary.
- Background work uses an in-process loop with sleep and no durable step identity. Restart loses execution state and retry can duplicate effects.
- The client renders a local-only message array, triggers work from an effect, treats every Enter as send, and lacks streaming, branching, persisted drafts, accessible controls, or structured error recovery.
- The 2023 dependency set is pinned to old framework/provider generations and must not be carried into the packaged runtime.

## Preservation map

Retain:

- Git history, the Unlicense, the `v1.0.0` tag, and acknowledgements of the original CUPCAKEAGI.
- The product concepts of chat, durable tasks, modular abilities, memory, personality, quiet thoughts/dreams, and continuing conversation while work runs.
- The original mascot/rainbow artwork only in About and the Classic theme, subject to asset provenance and packaging verification.
- Legacy user-authored data through the read-only, idempotent importer in ADR-0007.

Do not retain as active implementation:

- The Next.js client, FastAPI public service, old LangChain loop, flat-file state, generated dependency installation, generated code execution path, hard-coded authentication, or tracked runtime state.
- API keys, environment files, caches, bytecode, temp files, generated scripts, or historical provider SDK objects.
- Legacy emotion/sensory scalar files as model instructions. They may be summarized in the migration report but cannot silently steer 2.0.

## Baseline completion criteria

- The root is the only working repository root and `git rev-parse --show-toplevel` resolves to it.
- The 2.0 branch descends from the preserved history; `v1.0.0` resolves to the original commit.
- Text files normalize to LF except explicit Windows scripts; binary and font assets are declared binary.
- The tracked `.env`, caches, bytecode, and generated state are removed from the active tree. Credential rotation is documented as a user action without printing secret values.
- Architecture records are accepted before replacement implementation is treated as the new source of truth.
