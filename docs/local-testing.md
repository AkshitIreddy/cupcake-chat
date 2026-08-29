# Local release-candidate testing

This is the owner-facing verification pass for CUPCAKEAGI 2.0. It is intentionally broader than a
unit-test checklist: a passing build is not proof that the desktop app looks right, preserves data,
routes context safely, or recovers durable work.

Use a disposable test profile and non-production provider accounts. Do not point destructive or
migration tests at your normal files.

## 1. Record the build

From the repository root in Windows PowerShell:

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
node --version
pnpm --version
rustc --version
cargo --version
py -3.12 --version
```

The expected branch is `feat/cupcakeagi-2.0`. Record the commit, date, Windows edition/build, x64
architecture, CPU, RAM, GPU/VRAM, display scale, and whether the run is a development build,
unpacked package, or installer. Windows 10 and Windows 11 x64 are the only supported
release-candidate targets.

Do not treat unrelated dirty files as part of the candidate. Do not push or publish the result.

## 2a. Disposable packaged-app profile

The Windows package can be exercised with an isolated profile so acceptance testing does not touch
the normal `%APPDATA%\\CUPCAKEAGI` directory. From PowerShell, after `pnpm package` has completed:

```powershell
$env:CUPCAKE_TEST_PROFILE = '1'
$env:CUPCAKE_TEST_DATA_DIR = 'C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\out\test-profile'
New-Item -ItemType Directory -Force $env:CUPCAKE_TEST_DATA_DIR | Out-Null
& 'C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\CUPCAKEAGI-win32-x64\CUPCAKEAGI.exe'
```

The disposable profile contains the SQLCipher product database, DBOS runtime database, broker
security/audit data, and encrypted object store created by that test run. Delete only this exact
`out\\test-profile` directory when the test is complete. A normal installed run uses
`%APPDATA%\\CUPCAKEAGI` instead. The marker and absolute path are ignored unless both are present;
they are not required for everyday use.

Web search is opt-in at the broker boundary. To test it, set a credential-free public HTTPS search
origin before launching the package (the endpoint receives `?q=`):

```powershell
$env:CUPCAKE_WEB_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/'
```

The broker validates the endpoint and discloses its origin in the preflight; leaving the variable
unset keeps web fetch available while search remains disabled. Do not put API keys or private
endpoints in this variable.

The current private artifacts are:

- unpacked app:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\CUPCAKEAGI-win32-x64\CUPCAKEAGI.exe`
- Squirrel installer:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\make\squirrel.windows\x64\CUPCAKEAGI-Setup.exe`
- portable ZIP:
  `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi\apps\desktop\out\make\zip\win32\x64\CUPCAKEAGI-win32-x64-2.0.0-rc.1.zip`

These are unsigned local test artifacts. The installer has not been installed system-wide and no
update feed or publication step was performed.

## 2. Install and run automated checks

```powershell
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
pnpm format:check
node scripts/verify.mjs --lane js
```

Set up the Python runtime only through its package metadata:

```powershell
py -3.12 -m venv services\runtime\.venv
services\runtime\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e "services/runtime[documents,durability,packaging,providers,sqlcipher,test]"
node scripts/verify.mjs --lane contracts
node scripts/verify.mjs --lane python
node scripts/verify.mjs --lane rust
```

If the Python package metadata or `test` extra is missing, stop the runtime portion and record that
as a release blocker. Do not use the 1.x Conda environment as a substitute.

## 3. Start with deterministic fixtures

```powershell
node scripts/setup-fixtures.mjs --clean
pnpm --filter @cupcakeagi/desktop dev
```

Before adding credentials or local models, verify that the app opens and that fixture-backed
surfaces are clearly distinguishable from live provider state. A fixture must never imply that a
provider is connected, a model is installed, or a task has actually recovered when it has not.

Check:

- first interactive window appears within 3 seconds on the reference modern 8-core/32 GB/NVMe
  machine;
- no terminal or debug console appears in the normal user path;
- Home, Chats, Projects, Tasks, Artifacts, Memory, Models, Tools, Search, Settings, Developer, and
  About are reachable;
- window minimize, maximize/restore, close, resize, and reopen behave normally;
- the original mascot appears only in About/history or the Classic theme;
- no voice control or automatic model-routing option is present.

## 4. Verify chat and navigation

Run the canonical chat interactions:

1. Start a chat from Home and send multiline text.
2. Confirm Enter sends and Shift+Enter inserts a line break.
3. Stop a streaming response, then Retry and Continue.
4. Edit an earlier user message and prove the old branch still exists.
5. Create a sibling branch and move between branches through the Frosting Thread.
6. Rename, pin, duplicate, archive, restore, search, and delete a disposable chat.
7. Close and reopen the app; confirm drafts, branch head, and scroll anchor behave as documented.
8. Build or load a 500-message fixture and verify virtualization plus long-chat navigation remain
   responsive.

Provider deltas should render within 100 ms of receipt on the reference machine without
destabilizing incomplete Markdown or code blocks. Inspect long prose, headings, nested lists, links,
citations, wide tables, syntax-highlighted code, equations, images, tool cards, task cards, and
artifact anchors.

## 5. Inspect every theme and width

Use Playwright for interaction and screenshot capture, then open and inspect the images. DOM
assertions alone do not pass this section.

Capture full frames and relevant close-ups at widths:

- 360 px;
- 768 px;
- 1024 px;
- 1440 px;
- an ultrawide desktop width.

Repeat for Cupcake Light, Cupcake Dark, Minimal, and Classic. Include true empty, loading,
streaming, complete, offline, approval, provider error, tool error, interrupted task, artifact split
view, command palette, model picker, context inspector, and cost-warning states.

Look for clipped text, unreadable contrast, overlays beneath the composer, accidental horizontal
page scroll, unscrollable tables/code, stale focus, layout jumps, mascot overuse, and state
communicated only by color.

## 6. Accessibility pass

Without a pointer:

- reach and operate every shelf destination, menu, dialog, branch, tool card, citation, revision,
  artifact tab, and composer control;
- confirm visible focus and logical order;
- use F6 to cycle major application regions;
- verify Escape closes only the topmost transient layer and never discards a draft;
- test all documented shortcuts and their visible alternatives.

With a screen reader, verify streaming is announced as debounced phrases rather than tokens and that
task/tool updates use appropriate live regions. Test 200% and 400% zoom, Windows high contrast,
reduced motion, and keyboard-only file/model/approval flows. Confirm Local/Cloud, success/failure,
capability, and task state have text or icons in addition to color.

## 7. Provider matrix

Run deterministic adapter fixtures for every provider. Run live smoke tests only with explicit test
credentials and a small cost limit.

| Provider route    | Required live checks                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI            | Responses streaming, stop, reasoning setting, tools, citations/usage where supported, continuity, and malformed/rate-limit errors                                 |
| Anthropic         | Streaming, stop, tools, usage, supported reasoning control, and error normalization                                                                               |
| Gemini            | Streaming, stop, file/image capability disclosure, tools, usage, and errors                                                                                       |
| xAI               | Streaming, stop, supported tools/reasoning, usage, and errors                                                                                                     |
| Mistral           | Streaming, stop, tools, usage, and errors                                                                                                                         |
| Cohere            | Streaming, stop, retrieval/tool behavior, usage, and errors                                                                                                       |
| NVIDIA NIM        | Recorded OpenAI-compatible streaming, tool/reasoning deltas, usage, rate limits, bounded dynamic catalog parsing, and explicit model selection; no live key in CI |
| OpenAI-compatible | Custom endpoint validation, capability override, unavailable endpoint, and privacy boundary confirmation                                                          |

For each route, confirm credentials never appear in logs, diagnostics, UI events, crash output,
screenshots, or the product database. Switch providers mid-conversation and verify only canonical
visible history transfers. Confirm no fallback occurs unless explicitly configured, and that a
cost/privacy boundary requires confirmation.

## 8. Local model matrix

Test the app-managed llama.cpp runtime and any available Ollama/LM Studio installations. Test
external vLLM as a connection, not an installation workflow.

- absent, stopped, starting, ready, degraded, and crashed runtime states;
- hardware detection and conservative RAM/VRAM/context recommendation;
- license acknowledgement and catalog provenance;
- resumable download, pause, cancel, restart, checksum mismatch, unexpected content type, and low
  disk;
- atomic finalization with no loadable partial file;
- load, unload, chat, stop, removal, and version replacement;
- measured tokens per second rather than a fabricated estimate;
- fully offline chat after a verified model is installed;
- local prompt/file contents never sent to a cloud provider or catalog request.

On an approximately 12 GB VRAM machine, verify 7–9B Q4_K_M models are favored, 12–14B guidance
accounts for context/headroom, and larger models are labeled hybrid or unsuitable.

## 9. Projects, files, search, and artifacts

Create two projects with deliberately conflicting facts. Attach a disposable repository and
representative PDF, document, spreadsheet, image, code tree, log, archive, and large text file.

- Confirm repository access is read-only initially, honors ignore rules, and cannot escape through a
  symlink or junction.
- Confirm attachment cards show parse/index state, size, citation support, and destination.
- Verify stable page/range/line/archive/media locators survive app restart and incremental
  re-indexing.
- Search 100,000 fixture records and verify FTS results complete within 250 ms p95 on the reference
  machine.
- Disable semantic retrieval and prove lexical search still works.
- Confirm Project A files, memories, and search results never appear in Project B.
- Generate each artifact category, preview it, edit it, request a revision, inspect history, export,
  and follow its immutable chat link.
- Create conflicting artifact edits and verify no revision is silently overwritten.
- Stage a repository patch, inspect the exact diff, deny once, then approve a fresh identical
  preflight and confirm only the approved files change.

## 10. Memory and proactive features

- Explicitly remember a preference and verify immediate write plus Undo.
- Correct Cupcake and verify an inferred preference remains a candidate until reviewed.
- Attempt to remember a secret and verify confirmation/secret protections.
- Create user, global, and project-scoped records; test search, edit, pin, disable, expiry, delete,
  and tombstone behavior.
- Ask what Cupcake remembers and compare the answer with the Memory screen and Context Inspector.
- Disable memory for a conversation and verify it contributes no inferred records.
- Keep Thoughts and Dreams disabled and verify no suggestion appears or runs.
- Enable them and verify only a quiet suggestion appears, with no external action or undisclosed
  cloud call.

## 11. Tools, MCP, and security

Test native file/repository, web, Git, Python, model, and artifact tools with success, failure,
cancellation, and timeout fixtures. Test a local stdio MCP server, a remote Streamable HTTP MCP
server, OAuth/PKCE, an allowlisted custom tool, and a changed server schema.

Adversarial cases must include:

- forged or oversized IPC frames, unknown protocol version, expired deadline, invalid HMAC, replay,
  and sequence break;
- approval digest tampering, reused approval ID, changed resource, changed destination, and expired
  approval;
- path traversal, symlink/junction swap, case/normalization edge cases, and revoked grants;
- remote MCP redirect/origin changes, DNS rebinding/SSRF targets, OAuth state mismatch, and schema
  replacement;
- prompt injection attempting to broaden a tool grant;
- AppContainer/restricted-token isolation, sandbox network denial, environment/credential absence,
  output/time/memory exhaustion, and Job Object-enforced process-tree termination;
- deletion, external communication, financial, installation, system, and unsandboxed actions always
  asking freshly.

Search product data, logs, stderr, traces, crash reports, and exported diagnostics for credential
patterns and raw secret fixtures.

## 12. Durable tasks and recovery

Start the canonical scenario: attach a repository, ask for a deep redesign, continue chatting while
it runs, inspect tools and citations, receive and revise an artifact, switch between cloud and local
models, inspect/remove a memory, restart, and resume the task.

Separately kill the desktop or runtime during:

- a provider stream;
- a tool call before and after its side effect;
- file ingestion;
- an artifact write;
- an approval pause;
- a subagent run.

Recovered tasks should appear within 5 seconds of restart. Verify checkpoints resume without
repeating external communication, patches, artifacts, tool cards, usage, or text events. Test
Cancel, Retry, Continue, queued follow-up, steering, runtime revision mismatch, and recovery from
corrupt/partial checkpoints.

## 13. Backup, restore, and migration

With synthetic data:

- create a backup during normal use and verify databases plus reachable encrypted objects are
  complete;
- restore into a fresh profile and verify branches, projects, memories, tasks, artifacts, citations,
  grants, and settings;
- test wrong keys, corrupt database pages, missing objects, extra unreachable objects, and
  interrupted backup/restore;
- import a synthetic 1.x profile twice and verify idempotency;
- verify `.env`, API keys, tokens, generated scripts, bytecode, and unsafe legacy state are neither
  imported nor executed;
- verify the original legacy source remains untouched and the import report is understandable.

## 14. Package and installer

```powershell
python -m pip install pyinstaller
node scripts/package-sidecars.mjs
pnpm --filter @cupcakeagi/desktop package
node scripts/smoke-package.mjs --platform win32 --mode package
pnpm --filter @cupcakeagi/desktop make
node scripts/smoke-package.mjs --platform win32 --mode make
node scripts/release-candidate-audit.mjs --require-artifacts
```

On clean Windows 10 and Windows 11 x64 test machines, verify install, launch, first run, path with
spaces/non-ASCII characters, protocol registration, runtime and broker startup, supported update
from a prior local test build, crash recovery, uninstall, and the documented data-retention choice.
Confirm provider credentials are DPAPI-bound to the current Windows user and generated-code
processes cannot escape the restricted-token/AppContainer-style boundary or the owning Job Object.

Do not generate, test, or describe macOS/Linux/Windows Arm packages as release-candidate artifacts.

Unsigned or locally signed output is a private test artifact. Do not distribute it.

## 15. Final evidence and decision

The candidate is ready for owner review only when the following are attached to the handoff:

- exact commit and environment;
- command results for lint, type checks, unit/integration/security suites, and builds;
- provider and local-model matrix with skipped live cases explained;
- durability, migration, backup/restore, installer, accessibility, and performance results;
- inspected screenshot set and a short demo of the canonical scenario;
- updated architecture summary and known issues;
- precise path to the local installer or unpacked application;
- confirmation that nothing was pushed, published, released, or connected to a production updater.

Owner testing and explicit approval are required after this checklist. Passing it does not authorize
publication.
