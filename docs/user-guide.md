# Cupcake Chat 1.8 user guide

Cupcake Chat is a Windows workspace for AI conversations that can grow into organized projects,
tasks, files, memories, and versioned artifacts. You choose the model for each chat: a hosted
provider you connect or an optional local model managed by the app.

## First-run setup

Onboarding maps the real app and can finish setup without forcing every optional choice. Close it at
any time, jump directly to a chapter, or replay it later from **Settings → General → Welcome tour**.

1. Set your display name and choose the portraits shown beside you and Cupcake Chat.
2. Pick one of the four interface themes and an illustrated workspace wallpaper.
3. Connect a hosted model provider, set up Cupcake Local, do both, or skip model setup for now.
4. Review the device scan before installing an optional local runtime or model.
5. Look through the starter Cupcake advisors and edit, archive, or create any roles you want.
6. Create a project for work that should stay together, or start with an unfiled chat.

The setup map shows which areas are ready without treating skipped optional steps as failures.

## Chats and model switching

Choose a model from the model chip above the composer, write a message, and press **Enter** to send.
Use **Shift+Enter** for a new line. The current provider and model stay visible; Cupcake Chat does
not silently send a turn through a different route.

Stop a streaming answer, retry it, continue after an output limit, or edit an earlier message to
create a sibling branch. The original branch remains available in the Frosting Thread. An untouched
new-chat draft is discarded when you leave it, so empty chats do not fill Recent.

The **All chats** toggle beside Recent shows conversations from every project in the same sidebar.
Opening one also switches to its project, keeping retrieved files and memory in the correct scope.

## Cupcake advisors and group chats

A Cupcake advisor is a reusable character with a name, role, detailed instructions, portrait, and
exact model route. The included set covers several common kinds of work and is meant to be edited.

Use **Add Cupcake** in a conversation to add an existing advisor or create a new one. A group can
contain up to eight Cupcakes.

- Type `@name` or use **Mentions only** when specific Cupcakes should answer.
- Use **Smart** when the roster should decide who has something useful to add. A useful member may
  speak; the others can stay quiet.
- Limit the number of replies when a short answer matters more than a round-table discussion.
- Open the participant tray to inspect, reorder, edit, disable, or remove members.

Each response keeps its real speaker and model route. Group conversations currently focus on chat;
run tool-heavy work through a regular single-Cupcake turn.

## Projects, tasks, artifacts, and memory

Projects keep related chats, attachments, tasks, artifacts, and memory together. The selected
project controls which saved context Cupcake Chat can retrieve.

Tasks show durable progress and keep their results after you leave the page. Artifacts preserve
revisions, so editing a useful answer does not erase the earlier version. A saved Python artifact
can run its exact revision in the contained Windows sandbox, with completed tests, failures,
infrastructure errors, and cancellation shown as different outcomes.

In a project chat, a completed Python code block also has **Run tests**. It saves the code as an
artifact, runs its `unittest` suite locally, and displays the actual result below the code. You can
keep talking in the same conversation; the artifact and task remain in their project sections.

Memory is inspectable. Review what was saved, correct it, pin it, disable it, change its scope, or
remove it. Search finds work across chats, projects, artifacts, tasks, and memory without merging
the projects themselves.

## Hosted providers

Open **Models → Add provider** or the provider area in **Settings**. Choose a provider, paste a key,
test the connection, review the discovered models, and save it. The connected card shows a masked
identity and last test result; use **Reconnect** to replace the key or **Remove** to delete it.

Cupcake Chat supports OpenAI, Anthropic, Google Gemini, xAI, Mistral, Cohere, NVIDIA NIM, Groq,
OpenRouter, Cloudflare Workers AI, and generic OpenAI-compatible endpoints. Availability, quotas,
model lists, prices, and provider terms can change. The README's free-options table links directly
to each provider's current official documentation.

Keys are protected for the current Windows user with DPAPI and are not stored in chat or the main
product database. Prompts, selected attachments, retrieved context, and model responses are still
processed by the hosted provider you selected.

## Cupcake Local

Cupcake Local is optional and managed entirely in **Models**. It detects CPU, RAM, disk, Windows
version, and NVIDIA GPU/VRAM, then explains whether each signed catalog model is Recommended, Fits
with reduced context, CPU-only/slow, Hybrid, or Incompatible. Model weights are downloaded only
after you choose one and accept its license.

On compatible NVIDIA systems, the app chooses between its supported CUDA packs using the installed
driver. Vulkan is the portable GPU fallback and the bundled CPU runtime is the baseline. Download,
pause, resume, cancel, checksum verification, load, benchmark, unload, update, and removal all stay
inside Cupcake Chat.

Once the required runtime and model are installed, supported local chat works without a provider API
charge and can run offline. The model's own license, storage, memory/VRAM, download bandwidth, and
electricity still apply.

## Tools and workspace freedom

Tools use **Full freedom** by default, so enabled capabilities can act without repetitive permission
dialogs. Turn individual tools off in **Tools** when a project does not need them. Credentials,
project boundaries, application sandboxing, and Windows security boundaries remain enforced.

Tool and task activity appears in expandable cards rather than interrupting the conversation with
extra route-confirmation popups. Developer mode can show redacted traces, checkpoints, costs, and
subagent details when deeper inspection is useful.

## Appearance, motion, and accessibility

**Settings → Appearance** combines Cupcake Light, Cupcake Dark, Minimal, or Classic with the
wallpaper you choose. Message surfaces, controls, scrollbars, and the Cupcake icon tile adapt to
that palette.

Fresh workspaces start with **Roman cupcake camp**: a living Roman cupcake, rose-cream panels, and
dark berry text. Existing saved appearance choices are preserved. Six historical worlds and other
illustrated scenes expand the red, pink, green, blue, amber, and violet options.

Small transitions, streaming cues, and playful entrance animations keep the workbench feeling alive.
Turn on **Reduce motion** to remove movement and smooth scrolling. Keyboard navigation, visible
focus, semantic streaming regions, responsive layouts, and Windows high-contrast behavior remain
part of every theme.

## Updates, backups, and the optional app password

Release builds check the project's signed update feed. When a newer approved release is available,
Cupcake Chat shows its version and release notes before installation. Update packages must pass the
Tauri signature check; Windows publisher verification is a separate code-signing layer.

The app opens directly by default. If you want an additional startup gate, create a workspace
password in **Settings → Privacy**. Password-protected profiles keep local models, tools, and hosted
provider sidecars stopped until the password is accepted. The password is separate from DPAPI
protection and can be changed or turned off later.

Backups can be prepared and verified from Settings. Keep a recent backup before a major upgrade or
moving work between profiles.

## Getting help

When reporting a problem, include the Cupcake Chat version, Windows version, the page and action
that triggered it, and the exact visible error. Redact keys, personal files, prompts, provider
responses, and private paths before sharing screenshots or diagnostics.

## Historical companions and workshop

The 24 historical advisors span six eras, four companions each: New Kingdom Egypt, Classical and
Hellenistic Greece, Rome, the Viking Age, the Mongol Empire, and medieval Europe. Filter them by era
in Add Cupcake. Their model, instructions, speaking rules, and portrait remain editable.

Open **Tools → History workshop** for a map-based travel estimate, siege supplies, or horse forage.
Change the inputs and save the resulting explanation to the current project. Coastlines are modern,
settlement coordinates are approximate, and dashed lines are distance guides rather than verified
historical routes. The calculations are transparent teaching scenarios, not campaign
reconstructions. [Asset and map provenance](design/history-companions.md).
