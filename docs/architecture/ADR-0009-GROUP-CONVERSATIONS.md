# ADR-0009: attributed Cupcakes with bounded turn selection

- Status: accepted design; packaged qualification remains tracked in the implementation worklog
- Date: 2026-09-05
- Extends: ADR-0003, ADR-0004, ADR-0005, and ADR-0006

## Context

The owner requested configurable Cupcakes in a shared conversation, an add button, `@mentions`, and
assistants that know when to contribute or remain quiet. Sending every prompt to every model would
repeat answers and multiply cost. A hidden supervisor that merges worker output would also obscure
the distinct participants the owner wants to converse with.

## Decision

Persist reusable personas, conversation memberships, group settings, and durable group turns in the
existing content store. Each persona binds one exact catalog model and its own presentation,
communication instructions, and role. The same model may serve several personas. Configuring a
persona does not require loading its model; readiness is enforced when sending.

The runtime owns a sequential, bounded coordinator using the existing provider engine. There is no
new orchestration service or automatic provider fallback. A roster can contain one to eight members.
The user can allow one to three replies per submission; the default is two.

Structured mentions select only the addressed members, once each, in mention order. They bypass
Smart selection entirely. Mention identity uses stable participant IDs and validated text spans;
display names, arbitrary `@text`, and model output cannot create membership or authorize routing.

For unmentioned messages in Smart mode, the explicitly configured lead model selects one remaining
member or passes. After a reply, it may make another selection within the same limit, taking the new
answer into account. Passing returns control to the user without fabricating a chat response.
Malformed selection, an unavailable lead, provider failure, or an output limit stops the exchange
with an explicit status. There is no arbitrary first-member fallback, selection retry, repeated
speaker, or bot-triggered conversation after the bounded user turn ends.

## Privacy and authority

Preflight performs no model I/O. Its authorization binds the conversation and branch head, content,
explicit resources, roster revision, exact possible recipient routes, selector route, and call
limits. Smart disclosure explains both selection calls and possible replies. Direct local mentions
cannot call a cloud selector. Send revalidates authorization and current offline policy before
outbound work; drift or replay fails before another recipient is contacted.

The selector receives bounded visible transcript material and member role descriptions. It receives
no private persona instructions, attachment bodies, retrieved document bodies, or memory contents.
Explicitly selected context is resolved for each actual speaker within the existing project
boundary. Other assistants' output stays attributed generated evidence and never gains
system-message authority. Group calls disable provider-native continuity so two personas sharing a
model cannot inherit each other's opaque state. Every persisted reply includes the speaker snapshot
and actual model route.

The initial group feature is conversational. It does not execute tools or inherit solo generation
actions that could bypass its recipient plan. Ordinary solo workbench tools remain separate.

## Interruption and recovery

The complete turn, including selection and gaps between replies, owns a cancellation handle. One
user submission is persisted once. Stop preserves completed and partial messages, stops queued work,
and records cancellation truthfully. A process restart marks unfinished turns interrupted and never
automatically repeats model requests. Reload reconstructs member attribution and turn status from
durable data. Late events are scoped to their conversation and cannot appear in another open chat.

## Consequences and qualification

Smart mode adds explicit selection latency and usage: by default at most two selection calls and two
responses. Direct mentions incur no selection calls. Semantic selection is a model judgment, not a
correctness guarantee; users retain direct addressing and a whole-turn Stop control.

Qualification requires contract, runtime, and interaction tests for exact routing, silence, reply
bounds, Unicode mentions, authorization drift, cancellation, and restart. A real packaged owner demo
must additionally show two attributed providers, a direct mention, and a quiet closing turn. Fresh
ordinary profiles receive no fabricated personas or conversations.

The dated [research brief](../research/2026-09-05-group-conversations.md) compares the
primary-source AutoGen, Pydantic AI, LangChain, and other orchestration patterns that informed this
decision. Product acceptance remains separate from that research and from deterministic test
fixtures.
