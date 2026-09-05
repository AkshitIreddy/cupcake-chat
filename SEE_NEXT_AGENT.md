# CupcakeAI: independent overhaul brief for the next agent

- **Prepared:** 2026-09-05
- **Repository:** `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi`
- **Working branch:** local `master`
- **Baseline before this handoff:** `6ad5004` (`docs: record wallpaper and direct-open acceptance`)

Read this entire file before changing the repository. This is the current owner-directed handoff,
but it is not a demand to preserve previous agents' decisions. You are expected to be more capable
than the agents that built the present version. Independently inspect, reproduce, measure, research,
and judge the work. Assume prior decisions, including Codex's, may be incomplete, stale, or
suboptimal. Keep what survives scrutiny and replace what does not.

Do not reduce this to a cosmetic patch or a test-suite exercise. The goal is a substantially better,
owner-testable Windows application with real provider and local-model demonstrations left in its
test profile.

## One-paragraph product context

CupcakeAI 2.0 is a Windows 10/11 x64, local single-user AI workbench for chats, files, projects,
tasks, artifacts, memory, search, tools, and explicit local or cloud model selection. The current
implementation uses a React/TypeScript renderer in a Tauri 2 host, a packaged Python runtime for AI
and product behavior, and a Rust ToolBroker for credentials, policies, grants, native tools, MCP,
sandboxing, and audit. It aims to make advanced AI capabilities approachable without requiring the
user to install Python, Node, Conda, a separate model server, or understand provider plumbing. The
product name is **CupcakeAI**, never CupcakeAGI in user-facing copy; the repository can be renamed
later.

## First actions

1. Confirm the real repository path, current `master`, `git status`, recent history, toolchain, and
   available disk space. Work directly on local `master`; the owner dislikes multiple branches.
2. Preserve all unrelated dirty changes. At handoff creation, these pre-existing files were not part
   of this commit:
   - `docs/PAUSED_HANDOFF.md`
   - `see me`
   - `artifacts/runtime/headless-cohere-20260901.json`
   - `artifacts/runtime/headless-local-20260901.json`
3. Read the current code rather than trusting summaries. Then read, in this order:
   - `README.md`
   - `docs/architecture/README.md`
   - every accepted ADR in `docs/architecture/`
   - `docs/architecture/SYSTEM_OVERVIEW.md`
   - `docs/architecture/IMPLEMENTATION_CHECKLIST.md`
   - `docs/known-issues.md`
   - `docs/local-testing.md`
   - recent files in `docs/worklogs/` and `docs/research/`
   - `NEXT_AGENT_TAURI_HANDOFF.md`
4. Treat `NEXT_AGENT_TAURI_HANDOFF.md` as historical requirements and evidence. Its older sections
   contain superseded facts, including earlier password and wallpaper behavior. Reconcile it against
   source, current commits, live behavior, and this brief.
5. Inspect the old application through the `v1.0.0` tag and early Git history. Do not check it out
   destructively over the working tree. Use Git tree/show/diff tools or a disposable worktree under
   `E:\temp` if necessary. The tag contains the original Next.js frontend under
   `frontend/assistant/` and Python backend under `backend/Multi-Sensory Virtual AAGI/`, including
   `state_of_mind/` data. Study its intended personality, tasks, abilities, visual identity, and
   user flow. Recover good product ideas, not its obsolete architecture or unsafe practices. Its
   history includes a tracked `.env`; never print, copy, execute, or reuse its secret values.

## Current architecture: verify it, do not worship it

The intended topology is:

```text
React + TypeScript renderer
          | narrow typed Tauri commands and events
Tauri 2 Rust host
          | verifies and supervises private authenticated children
          +-- packaged Python runtime
          |     providers, agent orchestration, local models, chats,
          |     projects, tasks, artifacts, memory, retrieval, persistence
          |
          +-- Rust ToolBroker
                DPAPI credential vault, policies, grants, tools/MCP,
                process containment, sandboxing, audit
```

The design currently claims:

- The renderer receives no unrestricted filesystem, shell, process, credential, or network access.
- Product state is stored in SQLCipher; immutable objects use AES-256-GCM; profile keys and provider
  credentials are protected for the Windows user with DPAPI. Runtime/checkpoint, product, and
  security/audit stores have separate responsibilities.
- Chats and artifacts use immutable revisions; project scope is a privacy boundary.
- OpenAI, Anthropic, Google Gemini, xAI, Mistral, Cohere, NVIDIA NIM, and remote OpenAI-compatible
  routes are explicit hosted providers.
- Cupcake Local manages pinned `llama.cpp` packs itself. The proposed Windows NVIDIA backend order
  is CUDA 13, CUDA 12, Vulkan, then CPU, with GPU-layer offload and system-RAM fallback subject to
  safe adaptive budgets.
- Startup should be lazy: quickly show saved local state, then start provider/model/tool services
  only when the chosen action requires them.
- Model discovery combines a curated qualified catalog, connected provider catalogs, NVIDIA NIM, and
  live Hugging Face GGUF search.

Audit each claim in code and in the packaged app. In particular, judge whether the Python/runtime,
Pydantic AI/provider adapters, sidecar protocol, encrypted stores, process boundaries, model
catalog, and llama.cpp pack strategy are still the strongest practical choices. Replace weak
abstractions or false complexity with measured alternatives. Preserve security boundaries unless an
alternative is demonstrably safer and more usable.

## Research before deciding

Refresh the existing research using current primary sources and date every conclusion. Do not merely
search for support for the current architecture. Compare credible alternatives and record why the
winner fits this exact Windows/NVIDIA product.

At minimum, investigate:

- Windows NVIDIA local inference: current stable CUDA compatibility, `llama.cpp` CUDA builds and
  quantization/offload behavior, ONNX Runtime/WinML, TensorRT-LLM, and any now-viable Windows-native
  alternatives. Distinguish native Windows support from WSL-only claims.
- VRAM overflow and RAM fallback: actual runtime behavior, KV-cache and context costs, GPU layer
  selection, pinned-memory implications, safe RAM/VRAM reserve, OOM recovery, and truthful UI.
- Tauri 2/WebView2 startup, window lifecycle, close/tray behavior, titlebars, DPI, accessibility,
  hidden subprocesses, and performance.
- Current first-party APIs and SDKs for every retained provider: streaming, reasoning, tool calling,
  structured output, vision/files, citations, usage, cancellation, rate limits, and model discovery.
- Hugging Face and provider catalog search/metadata. Compare how LM Studio exposes a broad catalog
  without making the default experience noisy or unsafe.
- Evidence-based model classification and recommendation. Do not invent ratings or preserve the
  rejected cupcake-score treatment. Use trustworthy benchmark/model-card evidence, note uncertainty,
  and separate publisher, serving provider, compatibility, and operational verification.
- Local encrypted storage, optional workspace security, DPAPI boundaries, backup/migration, and the
  consequences of offering encryption-off mode.
- Modern AI-workbench UX: chat, model selection, projects, tasks, artifacts, memory, provider setup,
  onboarding, progress/error recovery, and accessibility.

Update the research ledger or add focused dated research documents. Include direct links to official
documentation and clearly mark inference versus observed evidence.

## Required product and UI overhaul

Build from the present app, but be willing to reshape it deeply. The owner finds the current app too
empty in places, inconsistent, and hard to understand. Produce one distinctive, coherent, artistic
system rather than a collection of cards and tinted surfaces. The cupcake identity can be playful,
but the application still needs to feel capable, calm, and professional.

### Visual system and navigation

- Inspect every screen in the rendered app before redesigning it. Test Home, Chats, an active Chat,
  Projects, Tasks, Artifacts, Memory, Models, Tools, Search, Settings, Developer, About, onboarding,
  startup/loading, empty states, errors, menus, dialogs, and long-content states.
- Wallpaper styling should coherently affect all application screens. Avoid white seams, squared
  image corners inside rounded hosts, disconnected titlebars/sidebar colors, and opaque panels that
  hide the art. Keep content readable by adapting text, icons, bubbles, glass/scrims, and controls
  to each wallpaper rather than washing the wallpaper out.
- The user-selected profile avatar and CupcakeAI assistant avatar must appear consistently in chat
  and elsewhere. Provide attractive original cupcake avatar choices plus custom uploads, without
  accidental black backgrounds.
- Make the title strip materially thinner while keeping drag regions and window controls usable.
  Default Close should exit promptly; close-to-tray should happen only when explicitly enabled.
- Put global search at the top in a polished command-center style. Remove awkward inline `Ctrl+F`
  treatments and unexplained dots/badges. Explain counts such as Tasks rather than showing stray
  numbers.
- Use thin themed scrollbars and provide a sensible compact/minimized scrollbar preference. Ensure
  chat follows new messages unless the user intentionally scrolled away, with a clear jump-to-latest
  affordance.
- Keep settings navigation usable while its content scrolls. Replace native-looking Windows form
  controls with accessible app-owned controls where appropriate.
- Make every visible button work or remove it. Verify keyboard, focus, hover, pressed, disabled,
  loading, success, and failure behavior.

### Onboarding and startup

- Make first-run onboarding optional, interactive, replayable from Settings, and much richer than a
  slideshow. Use centered tutorial panels, spotlight/highlight real UI targets, and guide actions in
  the style of a good game tutorial. It must remain usable at narrow sizes.
- Onboarding should introduce capabilities and help the user choose name, profile picture, CupcakeAI
  assistant picture, appearance/wallpaper, provider connections, local model runtime, permissions,
  RAM/VRAM safety, projects, tools, memory, and backup/security. Detect already-complete steps and
  allow skipping them on replay.
- Use original, well-composed cupcake art where it materially improves the experience. Do not squash
  images or place panels off-center. Compress large assets appropriately.
- Keep normal startup frictionless and lazy. Do not initialize expensive model/runtime components
  just to view old chats. Loading art, progress, sidebar, and titlebar should form one visually
  continuous scene and accurately report what is happening.

### Security, permissions, and owner choice

- Normal opening must not demand a password. Workspace lock/password and related security friction
  are opt-in.
- The current implementation reportedly removes the startup lock record for the owner test profile,
  but SQLCipher/object encryption/DPAPI still remain automatic in the background. The owner's newest
  request also asks for a real ability to turn password **and encryption** off. Do not fake that
  with a password-only toggle or misleading copy.
- Independently decide and document a safe encryption-on/off product design. A genuine change may
  require transactional migration/rekey, backup, failure recovery, clear disclosure, and handling of
  credentials that should remain DPAPI-protected even if content encryption is disabled. If it
  cannot be completed safely, preserve automatic background encryption, satisfy prompt-free opening,
  and report the remaining requirement honestly.
- Repair the Permission Policy surface. Offer understandable presets, including an explicitly chosen
  “Full freedom” mode, while clearly explaining risks and still enforcing non-bypassable operating
  system/product safety boundaries. Permission changes must actually affect tool behavior.

### Models and providers

- Redesign Models around user intent: what they want to do, connected/available routes, device fit,
  quality, speed, context, privacy, and cost. Use discoverable checkbox filters with include/exclude
  behavior, not a clutter of unexplained controls.
- Do not impose an arbitrary fixed result count such as 24 or 30. Pagination/virtualization and
  recommendations should adapt to the system and query. The broad catalog can remain searchable,
  while default recommendations should be a small, high-quality set: roughly the best three or four
  options for each meaningful task and hardware/size tier.
- Group the chat model picker by the company that released the model, distinguish publisher from the
  serving provider, and hide unavailable/unconnected routes by default with an option to show them.
  Selecting a usable model should select it immediately; remove broken hidden-confirmation flows.
- Use the correct official publisher/provider marks where licensing permits. NVIDIA NIM is a serving
  platform, not the publisher of every model it hosts. Verify OpenAI, Qwen/Alibaba, NVIDIA, Google,
  Anthropic, Mistral, Cohere, Meta, Microsoft, DeepSeek, and other marks rather than guessing.
- Replace “Review install” with the clear action “Install.” Remove unsupported “unverified
  compatibility” noise, but never claim operational verification without actually testing a route.
- Show connected provider state with an accessible color plus text/icon cue. Provider setup,
  testing, discovery, reconnect, and removal must all work in-app without generic credential
  dialogs.
- Remove odd warnings such as implying that messages may be sent to “Cupcake Local.” The UI should
  say exactly whether a route is local or which hosted service receives content.
- Clearly show measured or conservatively estimated VRAM/RAM/context behavior. If a model exceeds
  VRAM, explain when it will partially offload to RAM, expected performance impact, safety limits,
  and why a load failed. Let automatic limits adapt to current usable system resources, with
  advanced manual controls.

### Product depth

- Make Chats, Projects, Tasks, Artifacts, Memory, and Tools feel like connected parts of a real
  workbench. Fix the sparse/odd Artifacts presentation and any placeholder-empty screen.
- Surface what CupcakeAI can actually do through examples, contextual guidance, useful empty states,
  and onboarding. At final handoff, explain those capabilities to the owner in plain language.
- Preserve explicit model choice. Do not silently route a local request to a paid/cloud model or
  vice versa. Any optional fallback must be opt-in and disclose privacy/cost consequences.

## Real capability demonstrations are mandatory

The owner wants to open the test application and immediately see convincing, persisted examples—not
browser fixtures, screenshots of mocks, or seeded claims that were never produced by a model.

Use the authorized credentials in:

`C:\Users\akshi\Desktop\Code Palace\Commonly used Keys.txt`

You may read and use those values for this work. Never paste values into source, command output,
logs, screenshots, Markdown, test fixtures, shell history, or Git. Route them through the app's
credential flow so they are protected by DPAPI. Scan all resulting artifacts for accidental secret
exposure before committing or handing off.

Create a small, polished showcase in the real owner test profile:

`E:\temp\cupcakeai-owner-test-20260902`

Requirements:

1. Use several genuinely different hosted providers and models when valid keys are available—target
   OpenAI, Anthropic, Google Gemini, Cohere, NVIDIA NIM, and another retained provider. Do not waste
   quota merely to increase a count; each demo should show a distinct useful capability.
2. After hosted API testing, run at least one real app-managed local model on the NVIDIA GPU and
   keep a useful local-model chat/project in the profile. Verify VRAM offload, RAM fallback or
   graceful fit refusal as appropriate, streaming, stop, restart persistence, unload, and recovery.
3. Include a few coherent showcase projects, for example a research/project-planning workflow, a
   coding or data-analysis workflow with an artifact, a long-context or document-grounded workflow,
   and a privacy-first local workflow. Each should contain high-quality multi-turn chats and useful
   saved artifacts/tasks/memory where the feature truly works.
4. Label demos clearly, make demo seeding idempotent, and keep it limited to the owner test profile.
   A fresh ordinary user profile must not receive fabricated conversations or projects.
5. Record the provider, model identifier, route type, date, and redacted outcome for each demo. If a
   credential is absent, invalid, quota-limited, or a model is unavailable, report that honestly and
   use another real route; never substitute fixture output while calling it live.
6. Reopen the packaged application and visually confirm that the demo chats/projects/artifacts are
   persisted, understandable, and pleasant to explore.

## Local-machine operating rules

- Keep every development command, server, build, diagnostic, and test terminal hidden/headless. The
  owner does not want console windows opening on the primary display.
- Prefer headless Playwright/CDP for visual work. When a real GUI launch is unavoidable, use a
  second monitor if available and leave unrelated windows untouched.
- `C:` is low on space. Put model weights, runtime downloads, build caches, screenshots, benchmark
  outputs, disposable worktrees, and other large artifacts under `E:\temp`. Do not let Tauri/Cargo,
  Python, or model caches silently refill `C:`.
- Before any AI-model GPU load or benchmark, read:

  `C:\Users\akshi\Desktop\Code Palace\gpu use.txt`

  If it is `yes`, do other work or wait. If it is `no`, atomically set it to `yes`, use the GPU,
  fully unload/stop the model processes, and restore it to `no` even on failure. Ordinary UI GPU use
  does not require this lock. The owner specifically wants local GPU testing after API testing.

- Do not push, publish, deploy, distribute, production-sign, create a release, or enable an updater
  without explicit owner approval. Local builds and local commits are authorized.
- Make small, reversible, working commits directly on `master`. Stage only owned files. Never
  discard someone else's changes to clean the tree.

## Verification standard

Do not claim completion because unit tests pass. Exercise the product and inspect the result.

- Run formatting, type, unit, Python, Rust, contract, security, and integration suites appropriate
  to every changed subsystem.
- Drive the real rendered UI at narrow, standard, high-DPI/zoom, and ultrawide sizes in light/dark
  themes and multiple wallpapers. Test keyboard, focus, reduced motion, high contrast, overflow,
  long chats, loading, empty, offline, rate-limit, cancellation, retry, and error states.
- Open and inspect screenshots rather than treating screenshot creation as visual acceptance.
- Run the actual packaged `CupcakeAI.exe` with private sidecars, not only Vite/browser fixtures.
- Verify startup-to-interactive, memory use, close latency, no visible console windows, process-tree
  shutdown, restart recovery, and optional close-to-tray behavior.
- Test real in-app provider conversations and one app-managed CUDA local-model conversation. Redact
  and scan logs.
- Rebuild the executable after source changes. Test the installer lifecycle only if doing so cannot
  affect ordinary user data; otherwise state the exact open gate.
- Keep current evidence separate from historical evidence. Record commit, executable hash, profile,
  Windows/GPU/runtime versions, models, timings, screenshots, and remaining limitations.

## Last known candidate snapshot (revalidate before relying on it)

The previous agent reported the following at `6ad5004`; these are useful starting points, not proof
for a changed build:

- Recent commits:
  - `87f4807 feat(ui): carry wallpapers across the workbench`
  - `6ad5004 docs: record wallpaper and direct-open acceptance`
  - `c69178d feat(ui): personalize immersive chat workspace`
  - `406459d feat(security): make workspace lock opt-in`
- Candidate executable: `apps\desktop\src-tauri\target\release\CupcakeAI.exe`
- Reported SHA-256: `E41D23C143A36FBA76D75187F39755CC4486D61F80802ABA57B569BCF9960896`
- Large Tauri target junction: `apps\desktop\src-tauri\target` -> `E:\temp\cupcakeagi-tauri-target`
- Owner test launcher: `Launch CupcakeAI Test.vbs`
- Owner test profile: `E:\temp\cupcakeai-owner-test-20260902`
- Reported checks: 126 Vitest tests, 27 Rust tests, 48 Playwright wide/narrow checks, and a hidden
  native smoke.
- Reported visual evidence: `E:\temp\cupcake-wallpaper-qa-20260904`
- Reported direct-open smoke: `E:\temp\cupcakeai-direct-open-smoke-20260904-v2`
- The owner test profile reportedly has no startup workspace-lock record and should open directly.
  Background content encryption reportedly remains enabled.

Recompute every artifact hash and rerun relevant evidence after modifying source. Do not hand the
owner an old executable under a new claim.

## Definition of done

This assignment is complete only when all of the following are true:

- The current methods have been independently audited against current research and weaker choices
  have been replaced or explicitly justified.
- The old version has been inspected and useful product ideas/migration needs have been accounted
  for.
- The visual and interaction overhaul is coherent across every major screen and has been inspected
  in real renders, not only asserted from code.
- The app is fast to enter, prompts for no password by default, loads expensive systems on demand,
  closes according to the selected setting, and opens without visible terminal windows.
- Models/providers are understandable, correctly branded, discoverable, selectable, and honest about
  availability, publisher, serving route, quality evidence, fit, RAM/VRAM behavior, privacy, and
  cost.
- The owner test profile contains real, persisted, clearly labeled, attractive demos produced
  through several hosted providers plus at least one local CUDA model.
- A fresh executable is built, hashed, smoke-tested, and handed off with a one-click hidden
  launcher.
- Tests, opened screenshots, native lifecycle checks, real model/API evidence, and known limitations
  are documented at the exact final commit.
- No secrets were leaked, unrelated changes overwritten, GPU lock left at `yes`, model process left
  running, or large artifact left consuming `C:`.
- Changes are committed atomically on local `master`; nothing is pushed without the owner's
  approval.
- The final owner message says where to launch the app, what demos to inspect, what CupcakeAI can
  do, what was proven, and what—if anything—still remains unproven.

## Prompt the owner can send with this file

> Open `C:\Users\akshi\Desktop\Code Palace\Cupcakeagi` on local `master` and read
> `SEE_NEXT_AGENT.md` completely. Execute that brief end to end. You are expected to independently
> audit the current implementation and research better methods rather than trusting previous agents.
> Inspect the preserved `v1.0.0` product, overhaul the UI/UX from the current state, verify the real
> packaged Windows/NVIDIA app visually and functionally, and leave polished real multi-provider and
> local-CUDA demo chats/projects in the owner test app. Keep terminals hidden, large files under
> `E:\temp`, obey the GPU lock file, work in reversible commits directly on local `master`, preserve
> unrelated changes, and do not push or publish without my approval. Do not stop at a progress
> report; finish the acceptance list or report only genuine blockers with evidence.
