# Product proposal: Quiet Confectionery Workbench

**Status:** Accepted **Audience:** A single person doing serious local knowledge and development
work who wants explicit control over models, data destinations, tools, and durable background tasks.

## Product promise

CupcakeAI 2.0 is a text-first desktop workbench: calm enough for ordinary conversation, capable
enough for multi-step local work, and legible about what it remembers, sends, changes, and resumes.
It is not a voice assistant, autonomous model router, cloud account, or multi-user collaboration
service.

The successful corrective candidate lets a user attach a repository, keep chatting while a durable
analysis runs, inspect sources and tool activity, edit/export an artifact, preserve scoped
decisions, switch explicitly between cloud and local models, manage memory, restart, and resume
without duplicated side effects.

## Information architecture

The persistent shelf contains Home, Chats, Projects, Tasks, Artifacts, Memory, Models, Tools,
Search, and Settings. Developer Mode adds inspection views; it never replaces or crowds normal chat.

- **Home:** large composer, Continue, Working, Projects, and at most one opt-in “Cupcake noticed…”
  suggestion.
- **Chat:** the primary surface for prose, attachments, citations, tools, approvals, tasks,
  memories, and artifacts.
- **Projects:** explicit privacy scopes for conversations, files, memories, retrieval, and tool
  grants.
- **Tasks:** durable work with state, progress, queued follow-ups, approvals, recovery, and
  cancellation.
- **Artifacts:** documents, code/configuration, tables, images, diagrams, webpages, and reports with
  immutable revisions.
- **Memory:** review, edit, confirm, expire, tombstone, or remove scoped records and candidates.
- **Models:** manual selection, capability/privacy/cost disclosure, provider setup, and local
  runtime management.
- **Tools:** native and MCP inventory, schemas, destinations, grants, audit, and connection health.
- **Search:** lexical-first results across all product-owned records, then optional semantic
  enrichment.
- **Settings:** themes, accessibility, defaults, privacy, budgets, data lifecycle, backup, and
  opt-in proactive behavior.

## Conversation contract

- Assistant responses are open readable prose; user prompts are quiet tinted slips rather than
  alternating speech bubbles.
- The multiline composer accepts files, pasted images, `@` references, project context, tools, a
  manually chosen model, and supported reasoning effort.
- Enter sends and Shift+Enter inserts a newline. Every keyboard action has a visible
  pointer-accessible equivalent.
- Streaming Markdown, code, math, tables, and citations remains structurally stable; stop preserves
  the partial response and exposes Continue/Retry.
- Copy, Retry, Edit, Branch, Continue, Save, memory, task, and export actions are available without
  permanently cluttering each turn.
- Editing or regenerating creates a sibling branch. It never overwrites a message or artifact
  revision.
- Tool calls render as compact status cards. Expanded cards show redacted inputs, declared
  destinations, sources, duration, outputs, errors, and generated files.
- The Context Inspector shows active project, selected model, visible instructions, file references,
  retrieved memory, tools, token contribution, and outbound destination. It never exposes private
  chain-of-thought.

## Signature design

The visual direction is “Quiet Confectionery Workbench,” not a generic dashboard and not a
candy-themed toy.

- Light tokens: Crumb `#F6F2EB`, Paper `#FFFCF7`, Cocoa `#2A2322`, Berry `#9F3E62`, Pistachio
  `#5D724F`, and Blueberry `#536594`.
- Package subsetted Bricolage Grotesque for restrained display use, Atkinson Hyperlegible for
  UI/conversation text, and IBM Plex Mono for code/data, including their licenses.
- The **Frosting Thread** is a narrow conversation spine marking turns, tasks, tools, artifacts,
  memories, and visible branch forks. It expands into a long-chat outline and is fully keyboard
  operable.
- Themes are Cupcake Light, Cupcake Dark, Minimal, and Classic. Classic selectively retains the
  original glossy mascot and rainbow; the default mark is simplified and flat.
- Motion is functional and 120–240 ms, with one restrained completion sprinkle. Reduced motion
  removes translation, flourish, smooth scrolling, and cursor animation.
- Full shelf/context panes appear at 1280 px and above, a compact rail below 1280 px, a navigation
  drawer below 960 px, and full-screen tabbed artifacts below 640 px.

## Accessibility and quality gates

- Meet WCAG 2.2 AA, keyboard-only operation, semantic landmarks and live regions, persistent visible
  focus, non-color state indicators, and 200–400% zoom/reflow.
- A screen reader receives coherent streaming updates rather than token-by-token noise; focus is not
  stolen by new content.
- Virtualize 500-message conversations without breaking selection, search targets, focus
  restoration, or the Frosting Thread.
- Validate all interactive behavior in Playwright and inspect rendered screenshots at 360, 768,
  1024, 1440, and ultrawide widths in all four themes.
- Empty, loading, offline, partial, permission, provider, corruption, and recovery states are
  designed states, not raw exception screens.

## Intentional exclusions

- No voice input/output, automatic model routing, bundled model weights, CupcakeAI account, cloud
  sync, team workspace, or multi-profile UI.
- No silent fallback across model, provider, cost, or privacy classes.
- No unsolicited Thoughts/Dreams: they are disabled by default, quiet when enabled, reviewable, and
  never injected as hidden instructions.
