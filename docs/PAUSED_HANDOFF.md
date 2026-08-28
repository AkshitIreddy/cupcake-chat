# CUPCAKEAGI 2.0 paused handoff

**Paused:** 2026-08-28 UTC  
**Branch:** `feat/cupcakeagi-2.0`  
**Last safe commit at pause:** `23a9c34 chore(repo): retire legacy 1.x active tree`  
**Target:** Windows 10/11 x64 only  
**Release policy:** local candidate only; do not push, publish, release, or configure an updater.

This is the exact resumption ledger. The active 2.0 implementation is intentionally left in the
working tree because several cross-language integration gates are not green. Do not discard, reset,
or overwrite uncommitted files. The original implementation remains recoverable through Git history
and the `v1.0.0` tag.

## Pause shutdown evidence

- Every active subagent was interrupted.
- CUPCAKEAGI Vite servers on ports 42620 and 42631 were terminated with their process trees.
- The active AppContainer Cargo test process was terminated with its child process.
- A follow-up process scan found no CUPCAKEAGI, `@cupcakeagi`, port 42620/42631, or sandbox-test
  process still running.
- No provider smoke test, build, dev server, or packaging job remains active.

## Secrets and live-test state

- The user source file remains at
  `C:\Users\akshi\Desktop\Code Palace\Commonly used Keys.txt`.
- It was copied, never moved, to ignored `.secrets/provider-keys.txt`; the files matched byte for
  byte at the last copy.
- Detected entries: Cohere trial and production, ElevenLabs, AssemblyAI, and NVIDIA NIM. No secret
  value is written in this document, Git, logs, screenshots, or command arguments.
- Cohere trial smoke passed earlier; Cohere production was not used.
- NVIDIA NIM live smoke passed with `nvidia/nemotron-3-nano-30b-a3b`: 83 raw model entries were
  discovered and the tiny successful stream used 31 tokens. No quota/rate/credit headers were
  returned, so the user's dashboard wording “unlimited” is not independently verified.
- ElevenLabs and AssemblyAI remain unused because voice is excluded from 2.0.
- The local-RC Ed25519 private key for the llama.cpp catalog remains ignored at
  `.secrets/cupcake-local-rc-2026-08-ed25519.pem`. It is not a production trust root.

## Implemented and substantially validated

### Repository, architecture, and contracts

- Nested clone flattened; Git history and `v1.0.0` preserved.
- LF policy and ignore rules added.
- Unsafe legacy active tree, tracked `.env`, bytecode, flat state, and generated-code executor
  removed in commit `23a9c34`.
- Repository audit, product proposal, system overview, research ledger, and ADRs exist.
- TypeBox source produces 26 versioned JSON Schemas plus generated strict Pydantic and Serde
  bindings.
- Last focused contract results: TypeBox 73, Pydantic 4, Serde 3; schema drift and TypeScript
  typecheck passed.

### Desktop and renderer

- Hardened Electron shell, custom `cupcake://` protocol, CSP, sandbox, context isolation, narrow
  preload, navigation denial, opaque file handles, tray, and Windows-only Forge gate exist.
- Four themes, Frosting Thread, responsive layouts, packaged fonts/licenses, simplified mark,
  Classic mascot/About history, command palette, model picker, context inspector, and all shelf
  destinations exist.
- Live `WorkspaceProvider` wiring covers project-scoped conversations, immutable branches,
  edit/regenerate, tasks, memory, artifacts, search, models, tools, settings, opaque attachments and
  references, offline cloud blocking, outbound disclosure, and runtime events.
- Rich Markdown supports stable partial streams, GFM, highlighted/copyable code, KaTeX, citations,
  safe links, blocked remote images by default, and phrase-debounced screen-reader announcements.
- Last renderer checkpoint before interruption: Prettier, focused ESLint, and desktop TypeScript
  check passed. The new focused Playwright run had started but was interrupted for this pause.
- Earlier pre-live-workspace baseline: 88 JS tests and 10 Playwright cases passed. Those results
  must not be treated as final evidence for the newer live renderer.

### Python runtime

- SQLCipher product DB, immutable conversation/artifact DAGs, encrypted content-addressed objects,
  FTS5, backups, migrations, project hard boundaries, typed memory, retrieval, ingestion, artifacts,
  observability, agents, tools, MCP contracts, and legacy importer exist.
- Real Pydantic AI Core engine exists for explicit models, canonical visible history, bounded
  context/output, broker-deferred tools, safe reasoning summaries, usage/cost, continuity, and
  cancellation.
- Real DBOS 2.31.0 runtime exists with separate SQLite system DB, one `@DBOS.step` per product task,
  approval continuation, stable run IDs, cancellation/resume, and two-process no-duplicate-effect
  recovery test.
- Provider matrix covers OpenAI, Anthropic, Gemini, xAI, Mistral, Cohere, generic compatible, and
  NVIDIA NIM with recorded deterministic streams/errors/tools/usage/reasoning/cancellation.
- NVIDIA NIM also has opt-in hosted embedding and reranking providers; FTS remains local default.
- Semantic retrieval is model-versioned/rebuildable and project-filtered before scoring. The opt-in
  100,000-record benchmark measured FTS p95 at 100.94 ms against the 250 ms budget.
- Structured document and Python workers run through staged protocols intended for the broker's
  Windows AppContainer; ingestion/adversarial tests last reported 31 passing.
- Product legacy migration sink, preview/decline/execute ledger, provenance, credential exclusion,
  and idempotency exist.
- Runtime integration reported targeted application/protocol 10/10 and strict Pyright clean. The
  last full run had one active local-catalog signature failure after acceleration-pack edits; all
  non-local-model runtime tests passed.

### Local models

- Cupcake Local manager supports signed catalogs, resumable verified downloads, safe extraction,
  runtime versions, model registry, load/unload/status, random authenticated llama-server loopback,
  Ollama, LM Studio, external vLLM, and hardware recommendations.
- Official llama.cpp `b10679` Windows x64 CPU archive is pinned and staged; archive SHA-256 is
  `c0dec4dfb52919e17f0a108a94bfbe877c67d77825145079e7703fc84f63986e`.
- All 51 extracted CPU-pack files are pinned; no GGUF/model weight is bundled.
- Optional Vulkan/CUDA catalog work was in progress when paused and needs catalog re-signing and
  final tests.

### Rust broker and security libraries

- Authenticated framed protocol, DPAPI vault, broker-owned Windows Credential UI, provider leases,
  policy precedence, one-use approvals, grant/path validation, security DB, audit, MCP/custom-tool
  supervisors, portable backup envelope, and native executors exist as libraries.
- Windows sandbox uses a one-shot zero-capability AppContainer plus Job Object CPU/memory/process,
  timeout, UI, output, cancellation, and kill-on-close limits. Seven live sandbox tests passed.
- Native executor covers scoped files, exact Git/patch flow, strict DNS-pinned HTTPS, staged Python,
  local model proxy, and artifact export. Fourteen focused native tests passed; the broker library
  last reported 91 passing and one intentionally ignored probe.
- Security DB has 12 focused passing tests. Portable backup crypto reported 8 Rust and 11 Python
  tests passing.

## Known blockers at pause

These prevent calling the tree a release candidate.

1. **Broker stream timing/cancellation:** the full Rust run still failed a timing assertion because
   the first runtime event was observed after roughly 1.77 seconds. True event-before-response
   latency and concurrent cancel must pass.
2. **Security DB integration:** `SecurityDatabase` exists, but `BrokerIntegration` was still using
   in-memory policy/grants plus the older `AuditStore` in some paths.
3. **MCP/custom tool integration:** remote MCP was partially reachable; installed-package stdio and
   `CustomToolSupervisor` were not yet wired into the final approval/policy path.
4. **Native path unification:** the old `broker.dispatch` compatibility path must not bypass the
   production native executor/preflight/approval path.
5. **Web search:** strict HTTPS fetch works, but no final broker-owned search endpoint was configured.
6. **Portable backup orchestration:** Argon2id/AES-GCM key wrapping and manifest validators exist;
   broker-level opaque archive create/restore with runtime + security snapshots was not finished.
7. **Clear-data workflow:** recoverable quarantine core work was interrupted; broker
   `data.clear.preflight`/`data.clear.execute` was not wired.
8. **Local acceleration catalog:** optional Vulkan/CUDA entries changed signed payloads. Re-sign with
   the ignored RC key, fix two Ruff wraps, and rerun local/full runtime tests.
9. **NVIDIA NIM finalization:** live chat passed, but redaction, docs, recommendation UI, dynamic
   compatibility retry, generated bindings, and final tests were interrupted mid-finish.
10. **Renderer final interaction pass:** core type/lint was green, but focused Playwright and the
    inert/live-control audit were interrupted. Verify all method names against runtime/broker.
11. **Settings/outbound contracts:** recheck exact key mapping and identical canonical outbound
    intent payloads for preflight/send after the interrupted edits.
12. **Narrow preload:** renderer still uses a generic runtime request method. Add a strict generated
    allowlist or individual methods so internal broker/runtime commands are unreachable from React.
13. **Dependency locks:** refresh `pnpm-lock.yaml` after the Squirrel, Markdown, and NVIDIA changes;
    refresh/verify Cargo.lock after all Rust integration changes.
14. **Final visual evidence:** recapture all four themes at 360, 768, 1024, 1440, and ultrawide plus
    required empty/error/approval/task/artifact states. The main agent must inspect every final frame.
15. **Final native package:** the staged Python executable predates later runtime changes. Rebuild
    sidecars, test the framed protocol/self-test, make the Squirrel installer/ZIP, launch-smoke it,
    and test upgrade/uninstall/data retention.
16. **No final commits for 2.0 implementation:** working files are intentionally uncommitted because
    the integration gate is not green. Do not squash or discard them.

## Exact resume order

1. Confirm the user has said to resume.
2. Read this file and inspect `git status --short`; do not reset the dirty tree.
3. Confirm no stale agents/processes. Resume the interrupted owners one at a time around shared
   files:
   - broker process integration: multiplex/cancel, SecurityDatabase, native path;
   - MCP/custom integration after broker compiles;
   - portable backup and clear-data orchestration;
   - local catalog re-sign;
   - NVIDIA finalization;
   - runtime final validation;
   - renderer final validation.
4. Refresh JS dependencies/lock on Windows:

   ```powershell
   corepack pnpm install --lockfile-only
   corepack pnpm install --frozen-lockfile
   ```

5. Run contracts and JS gates:

   ```powershell
   corepack pnpm --filter @cupcakeagi/contracts check:schemas
   corepack pnpm typecheck
   corepack pnpm lint
   corepack pnpm test
   corepack pnpm test:e2e
   ```

6. Run Python gates with the repository venv:

   ```powershell
   services\runtime\.venv\Scripts\python.exe -m ruff check services\runtime
   services\runtime\.venv\Scripts\python.exe -m pyright --pythonpath services\runtime\.venv\Scripts\python.exe services\runtime
   services\runtime\.venv\Scripts\python.exe -m pytest services\runtime
   ```

7. Run Rust gates:

   ```powershell
   cargo fmt --manifest-path crates\tool-broker\Cargo.toml --all -- --check
   cargo clippy --manifest-path crates\tool-broker\Cargo.toml --all-targets --all-features -- -D warnings
   cargo test --manifest-path crates\tool-broker\Cargo.toml --all-features
   ```

8. Re-run live provider smoke only if provider code changed and only with tiny prompts. Use the
   ignored secret copy; never print a key. Cohere production remains fallback-only on an actual 429.
9. Start one exclusive Vite server, run the expanded capture script, and inspect every required
   screenshot. Copy the accepted final chat frame to the tracked README screenshot.
10. Rebuild the final sidecars. Expect the complete PyInstaller build to take roughly 20–30 minutes:

    ```powershell
    node scripts\package-sidecars.mjs
    node scripts\test-sidecar-protocol.mjs
    corepack pnpm --filter @cupcakeagi/desktop make
    node scripts\smoke-package.mjs --platform win32 --arch x64 --mode make
    node scripts\release-candidate-audit.mjs --require-artifacts
    ```

11. Test the unpacked app and private installer with a disposable profile, including restart,
    upgrade, uninstall, and retention. Do not distribute the unsigned artifact.
12. Update the implementation checklist/known issues truthfully, then create small Conventional
    Commits only for green states. Do not push.

## Current Git policy

- Safe commits already on the local branch:
  - `ab7e3f0 chore(repo): establish 2.0 implementation baseline`
  - `de33f36 docs(architecture): record 2.0 system decisions`
  - `23a9c34 chore(repo): retire legacy 1.x active tree`
- The remaining dirty tree is the saved implementation checkpoint.
- Never run `git reset --hard`, `git checkout --`, or delete ignored `.secrets`/`out`/venv data when
  resuming.
- No push, release, publication, or updater action is authorized.
