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
| `[LIVE] Harbor Data Reliability Lab`   | NVIDIA NIM sensor triage; Groq incident runbook; optional OpenAI analyzer                          | Inline data reasoning, code generation, operational review, provider/model provenance             | Actual model-produced code and runbook |
| `[LIVE] Atlas Grounded Decision Room`  | NVIDIA NIM pinned decision; Gemini and Mistral grounded variants; Cloudflare free-allocation smoke | Revision-pinned reasoning, explicit hosted-route constraints, persisted response provenance       | Source memos, decisions, and checklist |
| `[LOCAL CUDA] Private Studio Notebook` | Cupcake Local action brief                                                                         | Explicit offline route, app-managed NVIDIA CUDA inference, two-turn continuity, local persistence | Final local-model action brief         |

The main live conversations have two substantive user turns and two awaited assistant responses. The
OpenRouter and Cloudflare quota-light smoke conversations have one short prompt, cap output at 200
tokens, and disable automatic recovery retries. Artifact creation occurs only after a non-empty
persisted assistant message is observed. Grounding scenarios save the first response, pin that exact
artifact revision in cloud-disclosure preflight, and pass the same bound reference into the second
request. The NVIDIA NIM grounded response ends with an explicit decision sentence; the harness saves
that exact model-produced sentence as project-scoped decision memory and binds its provenance to the
persisted assistant message ID.

The Harbor scenario also creates one real durable code-execution task asking CupcakeAI to review the
saved Python artifact and run its embedded tests in a sandbox. Its observed runtime status is
recorded as returned. The showcase does not label that task or its generated Python as tested or
complete unless the task system actually reaches that state with execution evidence.

## Intended low-quota run

1. Start the freshly packaged `CupcakeAI.exe` hidden with
   `CUPCAKE_TEST_DATA_DIR=E:\temp\cupcakeai-owner-test-20260902`, a dedicated WebView2 directory
   under `E:\temp`, and a chosen remote-debugging port.
2. Run the main hosted work on the three priority routes:

   ```powershell
   node scripts/create-owner-showcase.mjs --port 10071 --phase hosted --providers groq,mistral,google
   ```

3. If the owner wants the pre-existing Cohere and NVIDIA NIM examples as well, run them explicitly:

   ```powershell
   node scripts/create-owner-showcase.mjs --port 10071 --phase hosted --providers cohere,nvidia-nim
   ```

4. Exercise OpenRouter and Cloudflare only as quota-light smoke routes. Each produces one real,
   short, saved response. Cloudflare setup requires both the labeled token and account ID.

   ```powershell
   node scripts/create-owner-showcase.mjs --port 10071 --phase hosted --providers openrouter,cloudflare
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

Projects, conversations, and artifacts use stable exact names. A rerun reuses them and skips a turn
that already has a persisted assistant response. If a provider fails after persisting the user turn,
one clearly worded recovery turn is allowed; a second unresolved interruption stops the scenario
instead of stacking duplicate prompts. Duplicate stable names are treated as an error because the
harness cannot safely guess which owner item to keep.

The hosted phase requires an explicit comma-separated provider list. This prevents an old configured
credential from silently consuming quota. The local phase refuses to run unless the coordinator has
already set the GPU marker to `yes`; it reads but never changes the marker. Every screenshot and
manifest path must be a child of `E:\temp`.

The visible renderer and harness now use the same `artifacts.create` contract: `title`, `kind`,
`mimeType`, and actual generated `content`, with a persisted assistant source message when the
artifact came from a model turn.
