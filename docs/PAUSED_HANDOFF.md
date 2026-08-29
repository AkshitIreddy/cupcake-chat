# CUPCAKEAGI 2.0 resumed handoff

**Resumed and packaged:** 2026-08-29 UTC

**Branch:** `feat/cupcakeagi-2.0`

**Last checkpoint commit:** `44e2851 docs(handoff): checkpoint paused 2.0 work`

**Target:** Windows 10/11 x64 only

**Release policy:** local candidate only; do not push, publish, release, or configure an updater.

This is the post-resumption ledger. The implementation remains in the working tree until the green
slices are committed atomically. Do not discard, reset, or overwrite uncommitted files. The original
implementation remains recoverable through Git history and the `v1.0.0` tag.

## Pause shutdown evidence

- Every active subagent was interrupted.
- CUPCAKEAGI Vite servers on ports 42620 and 42631 were terminated with their process trees.
- The active AppContainer Cargo test process was terminated with its child process.
- A follow-up process scan found no CUPCAKEAGI, `@cupcakeagi`, port 42620/42631, or sandbox-test
  process still running.
- The final sidecar, package, installer, and disposable-profile smoke jobs have completed; no
  CUPCAKEAGI test process remains active.

## Secrets and live-test state

- The user source file remains at `C:\Users\akshi\Desktop\Code Palace\Commonly used Keys.txt`.
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
- Final renderer gates: typecheck, lint, 102 JavaScript tests, 18 Playwright tests, and the required
  four-theme/viewport screenshot inspection passed. The grown 2.0 mascot is in the Home hero; the
  original glossy mascot remains in About and Classic.

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
- Runtime integration: Ruff clean, strict Pyright clean, full runtime tests passed, and the frozen
  Windows executable passed the authenticated broker→runtime protocol smoke.

### Local models

- Cupcake Local manager supports signed catalogs, resumable verified downloads, safe extraction,
  runtime versions, model registry, load/unload/status, random authenticated llama-server loopback,
  Ollama, LM Studio, external vLLM, and hardware recommendations.
- Official llama.cpp `b10679` Windows x64 CPU archive is pinned and staged; archive SHA-256 is
  `c0dec4dfb52919e17f0a108a94bfbe877c67d77825145079e7703fc84f63986e`.
- All 51 extracted CPU-pack files are pinned; no GGUF/model weight is bundled.
- Optional Vulkan/CUDA catalog entries are re-signed with the ignored local-RC key; the staged CPU
  baseline remains the only bundled runtime and contains no GGUF weights.

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

## Resolved in the resumed pass

- Rust stream ordering/cancellation, durable security-database integration, MCP/custom-tool
  supervisors, native preflight path, backup crypto/container tests, local catalog signatures,
  NVIDIA NIM adapter/docs/redaction, renderer method review, and lockfile drift are green in the
  current source gates.
- The preload now enforces a reviewed renderer runtime-method allowlist. Web search is an explicit
  broker endpoint opt-in (`CUPCAKE_WEB_SEARCH_ENDPOINT`); fetch remains available without it.
- The Windows x64 sidecar package includes the rebuilt SQLCipher/DBOS runtime and Rust broker. The
  protocol smoke passed with seven model descriptors; Forge package, Squirrel installer/ZIP smoke,
  and `release-candidate-audit --require-artifacts` all passed.
- A disposable unpacked-app launch created the isolated profile at `out\\test-profile` and was
  terminated cleanly. The installer was built but not installed system-wide.

## Owner acceptance boundaries

These are intentionally still owner-operated checks, not hidden claims of completion:

1. Exercise the unpacked app and unsigned installer with the disposable profile, including restart,
   migration/backup/clear-data flows, provider credentials, and any available local model.
2. Web search requires the user to choose and configure a credential-free public HTTPS search
   origin; leaving it unset is the safe default.
3. Do not distribute, sign, publish, push, configure an updater, or create a GitHub release before
   explicit owner approval.

## Completed resume order

1. The owner resumed the task; the dirty tree was preserved.
2. JS, Python, Rust, contracts, visual, sidecar, package, installer, and release-audit gates ran.
3. The remaining handoff is owner testing with the paths below. Refresh JS dependencies/lock on
   Windows only when changing dependencies:

   ```powershell
   corepack pnpm install --lockfile-only
   corepack pnpm install --frozen-lockfile
   ```

4. Run contracts and JS gates:

   ```powershell
   corepack pnpm --filter @cupcakeagi/contracts check:schemas
   corepack pnpm typecheck
   corepack pnpm lint
   corepack pnpm test
   corepack pnpm test:e2e
   ```

5. Run Python gates with the repository venv:

   ```powershell
   services\runtime\.venv\Scripts\python.exe -m ruff check services\runtime
   services\runtime\.venv\Scripts\python.exe -m pyright --pythonpath services\runtime\.venv\Scripts\python.exe services\runtime
   services\runtime\.venv\Scripts\python.exe -m pytest services\runtime
   ```

6. Run Rust gates:

   ```powershell
   cargo fmt --manifest-path crates\tool-broker\Cargo.toml --all -- --check
   cargo clippy --manifest-path crates\tool-broker\Cargo.toml --all-targets --all-features -- -D warnings
   cargo test --manifest-path crates\tool-broker\Cargo.toml --all-features
   ```

7. Re-run live provider smoke only if provider code changed and only with tiny prompts. Use the
   ignored secret copy; never print a key. Cohere production remains fallback-only on an actual 429.
8. Start one exclusive Vite server, run the expanded capture script, and inspect every required
   screenshot. Copy the accepted final chat frame to the tracked README screenshot.
9. Rebuild the final sidecars when runtime source changes. Expect the complete PyInstaller build to
   take roughly 20–30 minutes:

   ```powershell
   node scripts\package-sidecars.mjs
   node scripts\test-sidecar-protocol.mjs
   corepack pnpm --filter @cupcakeagi/desktop make
   node scripts\smoke-package.mjs --platform win32 --arch x64 --mode make
   node scripts\release-candidate-audit.mjs --require-artifacts
   ```

10. Test the unpacked app and private installer with a disposable profile, including restart,
    upgrade, uninstall, and retention. Do not distribute the unsigned artifact.
11. Update the implementation checklist/known issues truthfully, then create small Conventional
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
