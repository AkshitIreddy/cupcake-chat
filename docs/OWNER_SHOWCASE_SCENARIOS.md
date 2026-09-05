# Owner showcase scenarios (staged draft)

**Profile:** `E:\temp\cupcakeai-owner-test-20260902`

**Harness:** `scripts/create-owner-showcase.mjs`

**Evidence root:** `E:\temp\cupcakeai-owner-showcase-20260905`

This showcase is created only in the owner test profile through the packaged Tauri renderer. The
harness attaches to an existing WebView2 CDP port; it never launches the app, changes the GPU lock,
or seeds a normal user profile. Provider keys are parsed only into process memory, submitted through
the app's masked provider sheet, and then discarded. The harness records provider/model IDs, route
type, timestamps, result status, response hashes, persisted entity IDs, and screenshots. It does not
record prompts returned by providers, raw response content, credentials, key hints, or
secret-derived identifiers outside the encrypted app profile.

## Why the showcase is staged

Hosted work runs first. The local phase begins only after hosted API work is complete and the
coordinating operator has acquired `gpu use.txt`, loaded an app-managed CUDA model, and confirmed
the lock is still `yes`. A final verification phase runs after the packaged app has been closed and
reopened. This division keeps provider quota deliberate, leaves app lifecycle ownership in one
place, and makes restart persistence observable.

The authorized key file currently exposes complete safe labels for Cloudflare Workers AI, Cohere,
Google Gemini, Groq, Mistral, NVIDIA NIM, and OpenRouter. Label presence does not prove
authentication, model access, quota, or billing state. The parser recognizes colon, equals, spaced,
underscored, and the owner's retained `cloudfare` label spelling without copying or printing any
value. OpenAI, Anthropic, and xAI labels were absent on 2026-09-05. An absent, incomplete, or
rejected credential is recorded honestly; the harness never substitutes fixture output.

The scenario selector follows the current qualified catalog IDs: `gpt-6-astra`, `claude-sonnet-5`,
`gemini-3.8-flash`, `command-a-plus-05-2026`, `mistral-medium-3-5`, and `grok-4.6`. NVIDIA NIM
prefers `nvidia/nemotron-3-super-120b-a12b`, with `nvidia/nemotron-3.5-lightning-30b-a3b`,
`deepseek-ai/deepseek-v4-flash-0731`, and `moonshotai/kimi-k3` as task-aware alternatives. These are
preferences, not availability claims: the harness selects only a chat-capable candidate returned by
the live configured-provider catalog and records the exact chosen ID.

## Named compatible routes and free-only gates

Groq, OpenRouter, and Cloudflare use named provider sheets backed by fixed first-party endpoints.
They do not borrow another endpoint's credential or accept a user-editable URL. The app stores each
key under its named provider ID; Cloudflare also requires a validated 32-hex account ID to construct
its account-scoped Workers AI endpoint. Their returned model descriptors stay isolated as
`openai-compatible:<named-route>/<native-model>` so equal native model names cannot carry continuity
across endpoints.

The showcase hard-allowlists `openai/gpt-oss-20b` for Groq, `nvidia/nemotron-3.5-lightning:free` for
OpenRouter, and `@cf/meta/llama-3.1-8b-instruct-fp8` for Cloudflare. If the exact item is absent
from the live catalog, the provider's demo is skipped as unavailable. It never selects another
catalog item. Groq's current free-plan limits include GPT-OSS 20B. OpenRouter's public catalog
reports the exact Nemotron 3.5 Lightning variant at zero prompt and completion price; the app
deliberately avoids `openrouter/free` because that router chooses an underlying model dynamically.
Cloudflare currently includes a daily Workers AI free allocation while naming some other models as
paid-plan-only. These terms can change; the live account remains the billing authority. See
[Groq rate limits](https://console.groq.com/docs/rate-limits),
[OpenRouter's free-variant contract](https://openrouter.ai/docs/guides/routing/model-variants/free),
and [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

## Coherent owner projects

| Project                                | Real conversations                                                                                 | What it proves                                                                                    | Saved output                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `[LIVE] Northstar Launch Studio`       | Cohere launch plan; OpenRouter free decision card; optional Anthropic audit                        | Planning, critique, a bounded one-pass smoke, owner/project organization, explicit hosted routing | Actual model-produced planning outputs |
| `[LIVE] Harbor Data Reliability Lab`   | Preserved NVIDIA review failure; Groq incident runbook; Groq reviewed sensor repair                | Honest failure history, pinned-artifact review, code generation, sandbox evidence                 | Reviewed Groq code and runbook         |
| `[LIVE] Atlas Grounded Decision Room`  | NVIDIA NIM pinned decision; Gemini and Mistral grounded variants; Cloudflare free-allocation smoke | Revision-pinned reasoning, explicit hosted-route constraints, persisted response provenance       | Source memos, decisions, and checklist |
| `[LOCAL CUDA] Private Studio Notebook` | Cupcake Local action brief                                                                         | Explicit offline route, app-managed NVIDIA CUDA inference, two-turn continuity, local persistence | Final local-model action brief         |

The main live conversations have two substantive user turns and two awaited assistant responses. The
OpenRouter and Cloudflare quota-light smoke conversations have one short prompt, cap output at 200
tokens, and disable automatic recovery retries. The already observed incomplete OpenRouter trial is
archived and remains historical evidence; the harness will neither unarchive nor retry it. Artifact
creation requires an assistant message whose persisted state is `complete` and whose canonical
finish reason is exactly `stop` or `end_turn`. A response ending in `length`, a streaming or
cancelled message, or a message without a canonical terminal reason cannot create an artifact or
satisfy verification. Grounding scenarios save the first completed response, pin that exact artifact
revision in cloud-disclosure preflight, and pass the same bound reference into the second request.
The NVIDIA NIM grounded response ends with an explicit decision sentence; the harness saves that
exact model-produced sentence as project-scoped decision memory and binds its provenance to the
persisted assistant message ID.

The reviewed Groq Harbor scenario pins the latest NVIDIA artifact revision for an independent defect
brief, then creates a separate `harbor_quality_checked.py` replacement. The NVIDIA attempts remain
visible as failed quality evidence and are never described as tested code. The Groq scenario also
creates one real durable code-execution task for its separate saved artifact. A `succeeded` task row
alone is not proof. Verification requires the persisted terminal checkpoint to identify `python.run`
and `native.sandbox.python`, bind the exact immutable revision sourced from the completed Groq
response in the same project, report exit status 0, report successful tests, and contain non-empty
sandbox provenance. Task lookup follows that persisted artifact/revision binding rather than relying
on prompt wording, so a UI-created “Run tests” task is recognized without accepting a task for a
stale or different artifact.

## Intended low-quota run

1. Start the freshly packaged `CupcakeAI.exe` hidden with
   `CUPCAKE_TEST_DATA_DIR=E:\temp\cupcakeai-owner-test-20260902`, a dedicated WebView2 directory
   under `E:\temp`, and a chosen remote-debugging port.
2. Create only the new Groq reviewed coding scenario. The existing Groq incident runbook is reused
   idempotently, so this makes two new Groq calls without repeating its earlier prompts. Keep task
   creation for the visible artifact workflow:

   ```powershell
   node scripts/create-owner-showcase.mjs --port 10071 --phase hosted --providers groq --skip-tasks
   ```

3. Open `harbor_quality_checked.py` in Artifacts, choose **Run tests**, and retain the real task
   only if its exact immutable revision finishes with sandbox evidence. Make no further NVIDIA code
   calls.

4. Do not rerun OpenRouter during the current acceptance pass. Its incomplete 200-token response is
   retained and archived as historical evidence. Cloudflare's earlier attempt failed during catalog
   parsing before any inference; after validating the repaired connection, it may make its first and
   only bounded 200-token inference. Do not retry that inference if it fails. Cloudflare setup
   requires both the labeled token and account ID.

   ```powershell
   node scripts/create-owner-showcase.mjs --port 10071 --phase hosted --providers cloudflare
   ```

5. Inspect every `owner-showcase-hosted-*-evidence.json` and screenshot. The provider set is part of
   each evidence filename, so staged runs do not overwrite one another. Do not add provider runs
   merely to increase the count.
6. Close the app, acquire `gpu use.txt`, reopen the same owner profile, install/load the selected
   app-managed CUDA model, and confirm measured NVIDIA/CUDA evidence.
7. While the coordinator still owns the lock, create the private local project:

   ```powershell
   node scripts/create-owner-showcase.mjs --port 10071 --phase local --gpu-marker "C:\Users\akshi\Desktop\Code Palace\gpu use.txt"
   ```

8. Exercise stop, unload, restart recovery, and reload through the packaged local-model acceptance
   lane. The showcase harness intentionally does not seize those lifecycle controls from the
   coordinating operator.
9. Reopen the packaged app without a model loaded and run:

   ```powershell
   node scripts/create-owner-showcase.mjs --port 10071 --phase verify
   ```

10. Visually inspect the reopened Projects screen plus each saved chat and artifact. Scan the
    profile, evidence JSON, screenshots, and Git changes for accidental credential exposure before
    handoff.

## Idempotency and failure behavior

Projects, conversations, and artifacts use stable exact names. A rerun reuses them and skips only a
turn with a strictly completed assistant response. If a provider fails after persisting the user
turn, one request-specific recovery turn is allowed; its stable request hash prevents one failed
turn from being mistaken for another. A second unresolved interruption stops the scenario instead of
stacking duplicate prompts. The NVIDIA analysis, expansion, and two bounded replacements remain in
immutable chat history. Owner review found the replacements still had incorrect row expectations,
silent malformed-row handling, unsafe assertions, and an undefined CLI name. The harness preserves
that scenario with `quality_review_failed_preserved` and cannot send it another request or promote
its artifact as quality proof. The separate Groq review pins the latest NVIDIA revision as evidence,
but only the final completed Groq implementation can source `harbor_quality_checked.py`. Archived
conversations stay archived and never trigger inference. Duplicate stable names are treated as an
error because the harness cannot safely guess which owner item to keep.

The verification phase evaluates only scenarios that actually exist. A missing, failed, partial, or
archived provider conversation is recorded as an observed outcome and does not become a mandatory
scenario merely because its project exists. For a completed scenario, verification requires every
declared prompt, a strictly completed source and final response, an artifact revision sourced from
the right persisted assistant message, and exact memory provenance when the scenario saves a
decision. Partial assistant messages are counted separately and never increase the completed-turn
count.

The hosted phase requires an explicit comma-separated provider list. This prevents an old configured
credential from silently consuming quota. The local phase refuses to run unless the coordinator has
already set the GPU marker to `yes`; it reads but never changes the marker. Every screenshot and
manifest path must be a child of `E:\temp`.

The visible renderer and harness now use the same `artifacts.create` contract: `title`, `kind`,
`mimeType`, and actual generated `content`, with a persisted assistant source message when the
artifact came from a model turn.
