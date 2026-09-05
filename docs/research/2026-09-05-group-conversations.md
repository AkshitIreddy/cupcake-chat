# CupcakeAI group conversations: v1 product and architecture brief

- **Date:** 2026-09-05
- **Repository snapshot inspected:** `f9741c5d7948e9f5dc0836338f4b33e5b74dae14`
- **Scope:** configurable, attributed multi-model conversations using the existing provider-neutral
  runtime
- **Evidence boundary:** source and documentation review only; no model inference, provider request,
  GUI automation, or GPU work was performed

## Recommendation

Ship **Cupcakes** as a conversation mode with a small roster of named assistants. A user adds a
Cupcake with a name, role, and exact model. They can call one or more members with structured
`@mentions`, or let **Smart** mode choose who can add the most value. Every response remains a
normal, visible, immutable conversation message attributed to the member and exact model that
produced it.

Use a hybrid, sequential coordinator owned by the CupcakeAI runtime:

1. Structured mentions select members deterministically and make no selector request.
2. An unmentioned message in Smart mode goes to one explicitly configured **lead selector** model.
3. The selector returns one validated member ID or `pass`, plus a short reason code. It never writes
   the user-facing answer.
4. After every response, while routing and reply capacity remains, the lead reevaluates the updated
   visible transcript and chooses one unused member or `pass`.
5. The default limit is two visible responders; the supported v1 range is one to three.

This is a manager/router mechanism, but the product is not a hidden supervisor-and-workers flow. The
selected Cupcakes speak directly and visibly. The selector's decision is short operational metadata,
never hidden reasoning or a substitute answer.

This shape follows the useful common ground in current frameworks while avoiding their unsafe or
ill-fitting defaults:

- OpenAI distinguishes manager-controlled agents-as-tools, handoffs, and deterministic code
  orchestration, and recommends code control where predictable cost and speed matter
  ([Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)).
- Pydantic AI distinguishes delegation, programmatic handoff, and graph control, and supports
  different models under shared usage accounting
  ([Multi-agent applications](https://pydantic.dev/docs/ai/guides/multi-agent-applications/)).
- AutoGen's selector group chat demonstrates context-aware speaker choice, candidate filtering,
  repeated-speaker control, and explicit termination
  ([SelectorGroupChat](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/selector-group-chat.html)).
  Its documented implementation may fall back to a previous or first participant after selector
  failures. CupcakeAI must fail explicitly instead of allowing an arbitrary assistant to speak
  ([AutoGen selector source](https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_selector_group_chat.py)).
- LangChain's current taxonomy includes subagents, handoffs, routers, and custom workflows. The
  router mechanism is useful here, while hidden subagent output is inconsistent with CupcakeAI's
  visible, attributed conversation goal
  ([Multi-agent patterns](https://docs.langchain.com/oss/python/langchain/multi-agent/index)).
- Google ADK likewise separates deterministic sequential/parallel/loop workflows from dynamic LLM
  routing
  ([ADK announcement](https://developers.googleblog.com/agent-development-kit-easy-to-build-multi-agent-applications/)).
- Microsoft Semantic Kernel orders each cycle as user-input check, termination check, and then next
  agent selection. That ordering is the right failure-safe loop for CupcakeAI
  ([Group chat orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/group-chat)).

## User-visible v1 semantics

### Roster

A group conversation has 1–8 enabled Cupcakes. A one-member roster is valid while the user builds
the group. Each member has:

- a stable opaque participant ID;
- a unique mention handle, 2–32 lowercase ASCII letters, numbers, underscores, or hyphens;
- a display name, 1–40 characters, which may duplicate another member's display name;
- one exact canonical `modelId` from the model catalog;
- a concise role description used for selection;
- optional user instructions, treated below product safety and project instructions;
- an enabled/disabled state and display order.

The same model or display name may appear more than once under different roles. Handles remain
unique and are shown whenever duplicate names need disambiguation. Editing or removing a member
affects future turns only. Historical messages retain their original participant and model
snapshots.

One enabled member is the lead selector. The selector is a configured model choice, not a hidden
vendor service. The UI always shows its route. Smart mode is unavailable if that exact model is not
currently usable; explicit mentions remain available.

### Adding and mentioning Cupcakes

The conversation header gets **Add Cupcake**. Its sheet reuses the existing model picker, then asks
for a name and role. In a roster-backed conversation, typing `@` opens one accessible listbox with
two labelled sections:

- **Cupcakes in this chat** — group members;
- **Project context** — the existing project, artifact, task, and memory references.

Selecting a member inserts its visible unique `@handle` and an opaque `{participantId, range}`
mention in the send payload. Selecting project context adds context without creating a speaker
mention. The runtime trusts only the opaque participant ID after verifying that it belongs to the
current conversation and is enabled. Raw text resembling `@handle` is ordinary user content. This
prevents ambiguous names, renamed members, and prompt text from changing routing.

Mention behavior is deterministic:

- one mention: only that member is asked to respond;
- two or three mentions: those members respond sequentially in mention order;
- more mentions than the configured responder cap: sending is blocked with a clear edit prompt;
- a disabled, deleted, unavailable, or cloud-blocked member: sending is blocked before any model
  call;
- mentions bypass Smart selection and selector cost entirely.

There is no implicit `@everyone` in v1. A user may select up to the configured responder cap.

### Smart mode

For a normal unmentioned message, the lead sees only:

- the latest user text;
- a bounded recent visible transcript;
- trusted participant IDs, names, role descriptions, and current availability;
- opaque labels and kinds for selected context, never attachment bytes or retrieved document bodies.

Each structured routing result is:

```json
{
  "decision": "speak",
  "participantId": "opaque-member-id",
  "reasonCode": "best_fit",
  "reason": "Can compare the trade-offs in this request."
}
```

For a pass, `decision` is `pass` and `participantId` is null. A pass is valid when a message is only
an acknowledgement, the user asks the group to wait, or no remaining member can add useful content.

For `speak`, `participantId` must be one of the supplied unused candidates. `reasonCode` is an enum
such as `best_fit`, `direct_request`, `specialist`, `cross_check`, `distinct_perspective`,
`acknowledgement`, `user_asked_to_wait`, or `no_distinct_value`. `reason` is plain and limited to
120 characters. It may be shown as “CupcakeAI invited Mira for a cross-check.” It must not contain
or claim to expose chain-of-thought.

The lead runs before each possible Smart reply. After a member responds, the next routing call sees
that response and returns an unused participant or `pass`. The selector is therefore able to keep
redundant members silent after seeing what was actually said. It cannot select the same participant
twice in one user turn.

A pass before the first reply is a successful, durable group-turn outcome rather than message loss.
The timeline shows a visible neutral status such as “The Cupcakes are waiting — mention one to ask
directly,” with the short pass reason and a retry/mention action. No assistant message is
fabricated.

### Ordering and termination

Responses are sequential. This keeps the timeline deterministic, lets later members see earlier
contributions, avoids simultaneous local GPU requests, and makes cancellation and spend accounting
understandable.

A turn stops when any of these occurs:

- the lead returns `pass`;
- the configured visible-responder limit is reached;
- the user presses Stop;
- a selector or responder fails;
- a responder reaches an output limit;
- a tool call is requested.

Group turns must never recurse, select forever, or continue merely because a member ended with a
question. `maxRoutingCalls` equals `maxReplies`: both default to two and use the supported range one
to three. A routing call occurs before each possible Smart reply; after the final allowed reply the
turn stops at the hard cap without another call. Selector output is capped at 256 tokens; each
responder retains the user's normal output setting subject to the existing model limit.

Anthropic reports that its research agents use roughly four times the tokens of normal chat and its
multi-agent systems roughly fifteen times normal chat. It also finds the approach most useful for
breadth-first work with independent directions, and a poor fit when every agent needs the same large
context or tasks are tightly dependent
([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).
CupcakeAI should therefore default to at most two responses, reevaluate whether the second adds
value, show routing overhead, and never market more speakers as automatically better.

## Privacy and cost contract

Group preflight is runtime-authoritative and occurs before the user message is sent anywhere. The
confirmation digest binds:

- conversation, branch, and current head message IDs;
- exact user content;
- attachment handles, byte hashes, MIME types, and sizes;
- typed references and resolved revision hashes;
- memory IDs and tool policy;
- every enabled candidate's exact model, provider, privacy route, and cost class;
- the lead selector's exact model and route;
- explicit mention IDs, or Smart mode;
- maximum selector and responder calls plus output-token ceilings.

An explicit-mention disclosure lists only the mentioned routes. Smart disclosure lists the selector
and every **possible** cloud recipient because the selected subset is unknowable until after the
confirmed selector call. Copy should say, for example: “This turn may send text to the Groq selector
and up to 2 of these Cupcakes: Local Qwen, Gemini, Mistral.” It must distinguish possible recipients
from calls that ultimately occurred.

The selector receives no file bytes, parsed file bodies, retrieved passages, tool results, or memory
content. A selected responder receives the same resolved context that an equivalent single-model
turn would receive, but only after the group confirmation is validated. Each subsequent provider is
a new disclosure destination, even if another member already saw the data.

The existing cloud confirmation token is single-use and model-specific. Do not weaken it or add a
renderer-supplied bypass flag. Add a server-held `AuthorizedGroupTurn` created after one group
digest is consumed. It contains the exact permitted routes, content/resource digest, and remaining
call counts. Internal member execution can spend only from that object. It is deleted on completion,
cancellation, error, expiry, or restart.

The runtime keeps at most one pending authorization per conversation branch; a newer review evicts
the older one, pending reviews expire after ten minutes, and the profile-wide cache is capped at 64.
Within one review, verified binary attachment bytes are read once per content hash and the same
immutable bytes object is shared by model-specific context views. A running group turn exclusively
owns its branch: another group send on that branch is rejected until the turn finishes or is
stopped, while a different branch may proceed. Appending the user message and creating the durable
group-turn record occur in one database transaction.

Offline mode rejects a mentioned cloud member. Smart mode removes cloud responders only when the
lead is local and at least one local candidate remains; otherwise it fails before selection. It
never silently swaps a member's model or lead. Provider fallback is disabled for every selector and
responder call.

Pydantic AI exposes request, tool-call, input, output, total-token, and cost limits, but request
limits are checked before calls while provider-reported token limits are generally checked after a
response ([Usage limits](https://pydantic.dev/docs/ai/api/pydantic-ai/usage/)). CupcakeAI needs its
own pre-call group ledger as well as Pydantic's per-call limits. Unknown price remains unknown, not
zero. The preflight should show a maximum call count and known upper-bound estimate where pricing is
available; the completed turn shows actual per-member and selector usage.

## Runtime architecture against the current repository

### What already fits

The current product already has several strong foundations:

- `domain/models.py` and `storage/repositories.py` persist immutable messages in a conversation DAG.
- Each assistant message already records model and provider IDs plus canonical metadata.
- `application.py::_resolve_explicit_chat_context` enforces project/conversation ownership for
  attachments, references, and memory.
- `application.py::_prepare_chat` compiles canonical context into a provider-neutral `ModelRequest`.
- `CupcakeAgentEngine.stream` normalizes providers into one event stream, enforces
  request/output/tool limits, and supports cancellation.
- `_execute_prepared_chat` and `_finalize_chat` already preserve streamed text, usage, finish
  reason, and immutable final messages.
- `BudgetLedger` demonstrates reservation and settlement for concurrent bounded work.

The existing `DelegateCoordinator` should not run group conversations. It is a task/subagent service
with role enums, synchronous executors, a different event model, and a production executor that
currently fails closed. Reuse its budget-ledger ideas, not its execution path.

### Required persistent types

Add product-owned records rather than hiding the roster in settings or mutable message metadata:

```text
ConversationParticipant
  id, conversation_id, handle, normalized_handle, display_name
  model_id, role_description, instructions
  enabled, position, created_at, updated_at

ConversationGroupConfig
  conversation_id, mode, lead_participant_id
  max_responders, selector_output_tokens

GroupTurn
  id, conversation_id, branch_id, user_message_id
  status, mode, confirmed_digest, responder_limit
  selector_calls, responder_calls, created_at, completed_at

GroupTurnMember
  turn_id, sequence, participant_id, status, message_id
  selection_reason_code, model_snapshot, usage_snapshot, error_code
```

Messages remain immutable. Every group assistant message also snapshots `groupTurnId`,
`participantId`, `participantName`, `participantRole`, canonical model ID, provider ID, and privacy
route in canonical metadata. A renamed or removed participant therefore cannot rewrite history.

Add matching canonical TypeBox schemas and generated Python bindings. Do not rely only on optional
metadata for live roster validation. Suggested commands are:

- `conversations.participants.list/add/update/disable`
- `chat.group.preflight`
- `chat.group.send`
- `chat.group.turn.get`
- `chat.group.turn.retry-member`

Keep existing `chat.preflight` and `chat.send` unchanged for ordinary conversations.

### Execution path

Factor the single-chat path instead of duplicating provider adapters:

1. Validate the branch head, roster, mentions, member descriptors, offline policy, and group
   confirmation under the runtime state lock.
2. Append one user message and create a durable `GroupTurn` before the first model call.
3. Resolve attachments and typed references once. Retain only app-owned bytes and canonical context.
4. Run the selector through the same `AgentModelFactory`, exact descriptor, error classifier, usage
   accounting, and cancellation token as normal chat, with structured output and zero output
   retries.
5. For each selected member, build a `PreparedChat`-equivalent request with that member's exact
   `modelId`, `fallback_model_id=None`, identity instructions, and the shared resolved context.
6. Stream through `CupcakeAgentEngine`; finalize with participant and group-turn metadata; settle
   the group ledger; then decide whether another selector pass is allowed.

Do not call `_chat_send_stream` once per member: it would append duplicate user messages and consume
model-specific confirmation tokens incorrectly. Instead, extract reusable preparation and execution
primitives that accept a trusted group-turn authorization and a participant snapshot.

The current history compiler requires the final canonical message to be the current user prompt.
After the first Cupcake responds, a second Cupcake cannot use that compiler unchanged because the
branch now ends in an assistant message. Add a group continuation compiler that:

- includes the complete bounded visible turn, including earlier Cupcake responses, as history;
- adds a product-owned current prompt telling the selected member to answer the latest user request
  and add distinct value;
- renders trusted speaker labels into model-visible prior assistant messages;
- never persists that coordination prompt as a user-authored message.

Provider-native continuity must be disabled in v1 group mode. The present preparation path can find
continuity by provider and family; two members using the same family must not accidentally share one
member's opaque server state. The canonical visible transcript is the cross-provider source of
truth. A future implementation may scope continuity by participant ID after dedicated tests.

### Selector output and retries

Use a strict product model for selector output. Reject unknown members, disabled members, repeats,
overlong reasons, and a routing decision that exceeds the turn budget. Pydantic AI can retry invalid
structured output, but each output retry is another billed model request
([Retries](https://pydantic.dev/docs/ai/core-concepts/retries/)). Set selector output retries to
zero in v1. Invalid output leaves the user message and turn durable with `selection_failed`; it does
not pick the first member.

The selector sees participant descriptions as untrusted user configuration inside a clearly marked
data block. The system instruction owns the output schema and allowed IDs. A short reason is logged
and optionally displayed; private reasoning parts remain suppressed by the existing engine.

### Tools and provider capabilities

V1 group turns should be chat/context only. Tool calls currently suspend one assistant response for
broker continuation, while a group turn adds another sequencing layer and a second authorization
scope. If a model nevertheless requests a tool, persist the request, mark the group turn
`awaiting_tool`, and stop selecting more members. Do not let a later member run while a tool result
is unresolved.

Smart mode requires a lead model whose route can produce the validated selector form. Explicit
mentions need only normal chat capability. Images/PDFs remain governed per selected responder by the
existing descriptor and attachment validation; an incompatible mentioned member fails preflight
rather than receiving a lossy substitute.

## Failure and recovery behavior

- **Selector unavailable, rate-limited, invalid, or empty:** no responder runs; retain the user
  message; show “Smart selection could not finish. Retry or mention a Cupcake.”
- **Member unavailable before execution:** stop before that call; never replace its exact model.
- **Member fails before emitting text:** persist the member attempt as failed, stop the group, and
  offer retry for that member.
- **Member fails after partial text:** preserve the partial attributed message using the current
  stopped/error behavior, then stop the group.
- **Output limit:** preserve `finishReason: length`, stop the group, and offer Continue on that
  exact member before any other member may speak.
- **Cancellation:** cancel the active selector/member and the whole group turn; completed earlier
  messages remain. Do not start the next call.
- **Runtime restart:** recover a nonterminal `GroupTurn` as interrupted. Never resume model calls
  automatically because cloud disclosure and local GPU state may have expired.
- **Roster edit during a turn:** execute the immutable participant snapshots already bound to the
  turn or cancel; never reinterpret an in-flight plan against the new roster.

## Verification plan

The feature is ready only after all of these are demonstrated without live-provider fallback:

1. Opaque mentions survive rename, duplicate-looking text, reload, and branch operations.
2. Mention order is deterministic and invokes no selector.
3. Smart selection chooses semantically suitable roles in eval fixtures rather than matching role
   keywords alone, reevaluates after each response, and passes when no additional view is useful.
4. Invalid selector output, unavailable models, rate limits, cancellation, output limits, and
   restart all stop cleanly with durable attributed state.
5. The hard responder/selector/request/token/cost limits hold under retries and concurrent UI
   events.
6. Mixed local/cloud rosters disclose every possible outbound route before Smart selection, while
   the completion record distinguishes possible from actual recipients.
7. Attachment bytes never reach the selector and reach only confirmed compatible responders.
8. Offline mode makes no provider request and never silently changes the lead or mentioned model.
9. Two local Cupcakes run sequentially without simultaneous GPU inference; Stop prevents the next
   run.
10. Every bubble, export, search result, branch, retry, and reloaded transcript retains participant,
    provider, and model attribution.

## Explicitly deferred

- parallel responders;
- autonomous agent-to-agent mentions or recursive delegation;
- automatic provider fallback;
- hidden worker answers synthesized by a manager;
- group tool workflows beyond pausing on the first broker request;
- server-native multi-agent products or provider-managed conversation state;
- `@everyone` and more than three responders per user turn;
- automatic background continuation after restart.

These are not needed for a useful group chat and materially increase cost, privacy surface, ordering
ambiguity, or recovery complexity.
