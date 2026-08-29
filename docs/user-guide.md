# CUPCAKEAGI 2.0 user guide

CUPCAKEAGI is designed around a simple loop: open the app, type naturally, add the context and tools
you want, and keep chatting while larger work continues. There is no Talk/Task switch and no voice
setup.

This guide describes the 2.0 release-candidate behavior. Builds made while the branch is still under
construction may expose deterministic sample data or incomplete integrations; check
[known issues](known-issues.md) and the
[implementation ledger](architecture/IMPLEMENTATION_CHECKLIST.md) for the exact build state.

## First run

On first run:

1. Choose Cupcake Light, Cupcake Dark, Minimal, or Classic. The app follows the operating-system
   theme until you override it.
2. Connect a cloud provider or add a local model runtime. You can skip this and explore the
   interface with fixtures.
3. Review the Local/Cloud explanation. CUPCAKEAGI has no account and does not sync your workspace to
   a Cupcake service.
4. Start a chat from Home.

Cloud providers require their own API credentials and may charge for use. A local model avoids
provider data transfer, but may still need a model download from the catalog source.

## Navigate the workspace

The shelf keeps the main destinations in one place:

- **Home** starts new work and shows a restrained list of recent chats, active work, projects, and
  at most one optional Cupcake suggestion.
- **Chats** contains pinned, recent, and archived conversations.
- **Projects** groups related files, chats, memories, tasks, artifacts, instructions, and
  permissions.
- **Tasks** shows work that is running, waiting for input, completed, failed, or cancelled.
- **Artifacts** collects substantial outputs such as documents, code, tables, diagrams, and reports.
- **Memory** lets you inspect and manage what Cupcake retains.
- **Models** configures cloud providers and local runtimes.
- **Tools** manages native tools, custom tools, and MCP connections.
- **Search** finds conversations, files, projects, memories, tasks, and artifacts.
- **Settings** controls appearance, conversation behavior, privacy, storage, shortcuts, and
  Developer Mode.

At narrower window sizes the shelf becomes a rail or drawer. The conversation, current draft,
selected branch, and open artifact should survive resizing.

## Chat naturally

The composer supports multiline text, files, pasted images, `@` references, project context, enabled
tools, model selection, and provider-supported reasoning effort.

- Press **Enter** to send and **Shift+Enter** for a new line.
- Select **Attach** or press **Ctrl/Cmd+U** to add files.
- Type `@` to reference a file, project, artifact, or supported agent explicitly.
- Open the model picker or press **Ctrl/Cmd+M** to select the model for the next message.
- Use **Stop** or **Ctrl/Cmd+.** to stop a response or active task phase.

Assistant responses use readable open text. User prompts use quiet tinted slips. Markdown, code,
tables, equations, citations, files, artifacts, tool cards, and task cards remain part of the same
conversation.

Message actions include Copy, Retry, Edit, Branch, Continue, Save, Add/remove memory, Create task,
and Export. Secondary actions appear on hover, keyboard focus, or the context menu.

### Editing and branching

Editing an earlier prompt or branching from a message creates a new path. It does not erase the
original response or later messages. The Frosting Thread—the narrow spine beside the
conversation—shows turns, artifacts, tool groups, tasks, memories, and visible branch forks. Press
**Ctrl/Cmd+J** to expand it into a long-chat outline.

### Streaming and interruption

Text, tool progress, and task events stream independently. Stopping a response keeps settled content
and marks an interrupted turn rather than inventing a completed answer. Use Retry to make a sibling
attempt or Continue to proceed from the retained canonical history.

If the interface disconnects from the runtime, CUPCAKEAGI replays journaled events by sequence.
Duplicate text or duplicate tool cards indicate a defect and should be reported with Developer Mode
diagnostics.

## Choose a model

CUPCAKEAGI never chooses a model automatically. The selected model is visible near the composer and
recorded with the response.

The model picker shows:

- provider and model family;
- Local, Direct cloud, or Custom endpoint route;
- capabilities such as Reasoning, Vision, Tools, Web, Coding, and Long context;
- supported reasoning levels;
- context and output limits;
- relative speed and cost classes;
- availability and provider health.

Provider-specific controls only appear when supported. CUPCAKEAGI disables unsupported reasoning
settings rather than silently substituting another value. Failure fallbacks are off by default. If
you configure one, crossing a privacy or cost class requires confirmation.

### Cloud providers

The 2.0 contract includes direct adapters for OpenAI, Anthropic, Gemini, xAI, Mistral, Cohere, and
NVIDIA-hosted NIM, plus generic OpenAI-compatible endpoints. Add credentials from Models so the
Windows per-user DPAPI vault can protect them; do not paste keys into chat, project instructions,
files, or environment files.

Changing providers during a conversation recompiles the visible canonical history for the new
provider. Opaque continuity state is reused only within the same provider/model family. Hidden
provider reasoning is never copied or shown.

NVIDIA NIM is the multi-model developer option: connect one NVIDIA Developer API key through the
Windows credential prompt, then let CUPCAKEAGI refresh the current hosted model catalog and choose a
specific model. Non-chat catalog entries are filtered, while unknown compatibility is labeled
instead of being advertised as a feature. NVIDIA-hosted developer access is for prototyping,
development, and testing; review the selected model's terms and move to an appropriate production
service or entitlement before deploying it.

### Local models

The Model Manager can work with:

- **Cupcake Local:** an app-managed llama.cpp runtime for verified GGUF models;
- **Ollama:** discovery, health, installed-model management, and inference through its local API;
- **LM Studio:** discovery, download/load/unload management, and its local OpenAI-compatible
  endpoint;
- **vLLM:** a user-managed external endpoint; CUPCAKEAGI does not install vLLM or its weights.

Model weights are not bundled. Downloads show source, license, quantization, expected RAM/VRAM,
size, progress, checksum state, and available controls. For a machine with about 12 GB VRAM, the
default guidance favors 7–9B Q4_K_M models. A 12–14B model needs tighter context and memory
headroom; larger models should be labeled hybrid or unsuitable instead of being optimistically
recommended.

Local is a data route, not a guarantee that every attachment or connected tool remains local. Check
the destination shown for each model and tool.

## Projects, files, and search

A project is an authorization and context boundary, not just a label. Project-scoped memories,
files, instructions, and retrieval results must not appear in another project.

You can use a normal one-off chat without creating a project. For continuing work, create a project
and attach a folder or repository. Live repositories are read-only by default, respect `.gitignore`,
and require an exact approval before a staged patch is applied.

Attachments appear as rich objects with name, type, size, parse/index status, and Local/Cloud
destination. CUPCAKEAGI parses and retrieves relevant sections instead of blindly sending a whole
file to every model request. Citations use stable locators such as PDF pages, spreadsheet ranges,
code lines, archive entries, or media timestamps.

Global search uses lexical search as its always-available baseline. Semantic enrichment may appear
afterward when an embedding model is configured; its index is derived and can be rebuilt.

## Artifacts

Substantial output becomes an artifact while staying linked to the message that created it.
Supported categories include rich documents, code/configuration, tables and spreadsheets, images,
diagrams, webpages, and reports.

Open an artifact to preview it, edit applicable formats, ask Cupcake for a revision, compare
history, or export it. A revision is append-only: editing advances the artifact head without
destroying earlier content. If two edits conflict, CUPCAKEAGI asks you to choose or merge rather
than silently overwriting one.

## Memory

Memory is separate from raw conversation history. Records are typed as preferences, facts,
instructions, decisions, events, task state, or temporary context. Each record includes scope,
source, confidence, revision history, and optional expiry.

Common chat commands are enough:

> Remember that I prefer concise README files.

> Forget the deployment decision for this project.

> What do you remember about the chess project?

> Do not use this conversation as memory.

An explicit “remember” request writes immediately and offers Undo. An inferred stable preference
becomes a reviewable candidate. Sensitive facts and instructions require confirmation; secrets must
never become memories.

In Memory, you can search, edit, pin, disable, or delete a record. Deletion creates a tombstone so
an old derived index cannot quietly restore it. Temporary records show their expiry.

### Context Inspector

The optional Context Inspector explains the input state for a request:

- active project;
- attached files and selected excerpts;
- retrieved memories and instructions;
- enabled tools;
- selected provider/model and token contribution;
- outbound destination.

It does not expose private chain-of-thought or hidden provider reasoning.

### Thoughts and Dreams

Thoughts and Dreams are quiet, disabled-by-default memory-consolidation suggestions. When enabled,
at most one unobtrusive “Cupcake noticed…” item appears on Home or the shelf. They do not send
messages, run tools, or contact a cloud model without the configured permission and destination
policy.

## Tools and approvals

Cupcake chooses tools from ordinary language; you do not need to write invocation syntax. A running
tool shows a short status such as “Reading 4 files…” and collapses when complete. Expand the result
for inputs, sources, duration, output, generated files, or errors.

Native tools cover scoped files/repositories, web research, Git inspection and staged patch
proposals, sandboxed Python, model management, and artifacts. The Tools screen also supports local
stdio and remote Streamable HTTP MCP servers plus out-of-process custom tools.

Every tool declares its effects and destination. Policy is evaluated in this order:

1. explicit deny;
2. exact grant;
3. session or project grant;
4. category policy;
5. ask.

An approval is bound to the exact resolved resources, effects, destination, limits, and expiry.
Approval IDs are single use. If the request changes, CUPCAKEAGI asks again.

Generated code runs in a staged Windows restricted-token/AppContainer-style boundary with Job Object
resource and process-tree limits, no credentials, and no network by default. Execution fails closed
if that boundary cannot be established. There is no general raw-shell tool. A tool asking for
deletion, external communication, money, installation, a system change, or unsandboxed execution
always needs fresh approval.

## Background tasks and subagents

A request can become a durable task when you ask explicitly or when preflight finds
repository/document indexing, code execution, artifact generation, several dependent tool stages, or
work expected to take more than about 20 seconds.

The task card stays in the originating conversation while you continue chatting. Tasks survive
navigation and are designed to resume from completed checkpoints after app/runtime restart without
repeating side effects. A task may wait for approval or additional input.

Specialist researcher, coder, reviewer, and document-analyst subagents have isolated histories,
explicit model/tool budgets, shared cancellation, and visible parent lineage. Normal chat shows
concise progress. Developer Mode can show the redacted run tree and intermediate product events.

## Privacy, destinations, and approvals

Before data leaves the computer, look for the destination disclosure:

- **Local** means the CUPCAKEAGI runtime, an app-managed model, or a local tool.
- **Direct cloud** means the selected provider receives the disclosed prompt, files, or context
  under your account with that provider.
- **Custom endpoint** means the configured endpoint operator controls the destination.
- **MCP server** or **Web origin** identifies the external tool destination.

Only grant folders needed for the work. Review expanded tool cards before applying patches. Keep
credentials in the DPAPI-backed provider setup. Backups can contain conversations, memories,
file-derived data, and artifacts; protect and store them accordingly.

CUPCAKEAGI is not a secure enclave. A compromised operating-system account, provider account, local
model runtime, or MCP server can still expose data within its reach.

## Keyboard reference

| Shortcut           | Action                                                       |
| ------------------ | ------------------------------------------------------------ |
| `Ctrl/Cmd+K`       | Open command palette                                         |
| `Ctrl/Cmd+N`       | New chat                                                     |
| `Ctrl/Cmd+Shift+F` | Global search                                                |
| `/`                | Focus composer when not editing                              |
| `Ctrl/Cmd+M`       | Model picker                                                 |
| `Ctrl/Cmd+U`       | Attach file                                                  |
| `Ctrl/Cmd+J`       | Toggle Frosting Thread outline                               |
| `Enter`            | Send                                                         |
| `Shift+Enter`      | New line                                                     |
| `Ctrl/Cmd+.`       | Stop generation or active task phase                         |
| `Alt+Up/Down`      | Previous/next conversation when not editing                  |
| `F6`               | Cycle main application regions                               |
| `?`                | Shortcut reference when not editing                          |
| `Escape`           | Close the topmost transient layer without discarding a draft |

Every shortcut has a visible pointer-accessible equivalent and can be changed or disabled.

## Backups and legacy import

Backup creates consistent snapshots of product data plus reachable encrypted objects. Restore
validates database and object integrity before replacing active state.

The legacy importer recognizes supported 1.x flat-file state and is idempotent. It does not execute
legacy code or import old API keys. Keep the original directory until you have reviewed the import
report and confirmed conversations, tasks, and relevant state were transferred as expected.

## Get diagnostics

Enable Developer Mode in Settings to inspect redacted events, approvals, tool payloads, usage, cost,
latency, retrieval provenance, checkpoints, subagents, failures, and OpenTelemetry identifiers. The
default retention target is 30 days. Export diagnostics only after reviewing them for user content
and file metadata.

For a reproducible verification pass, follow [local testing](local-testing.md).
