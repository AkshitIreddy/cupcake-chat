# Group chat adversarial QA plan

## Product invariants

1. A group, its project boundary, ordered members, and member route identities survive reload.
   Display names are presentation only; persisted membership and mention targets use stable IDs.
2. A user submission is written once. Each assistant message records the exact group member, model
   route, provider, and triggering user turn. Reload restores the same attribution.
3. One user action creates one bounded response plan. The default plan selects only members relevant
   to the prompt. A member response cannot recursively trigger another member, and a reload cannot
   resume or duplicate an already running plan without an explicit user action.
4. An explicit valid mention overrides automatic speaker selection for that member. Unknown `@text`
   stays ordinary prompt text so emails and code remain usable; it never resolves to a member ID
   implicitly. Duplicate display names require unique-handle disambiguation and never resolve by
   list order.
5. Cloud members require the existing point-of-use preflight before any outbound request. The
   confirmation is bound to the group, user turn, exact selected member IDs/routes, project, files,
   references, memories, and tools. Adding or changing a speaker invalidates the confirmation.
   Local-only selection never invokes cloud preflight.
6. Unavailable, unconfigured, incompatible, downloading, or offline-blocked members cannot be
   selected silently. The UI identifies skipped members and the reason. If no member is available,
   the user turn is not claimed as sent.
7. Stop applies to the current group response only, is idempotent, and settles every started speaker
   truthfully. A second response in the same group exposes a fresh Stop control. Partial text
   remains attributed to its speaker.
8. Reload during a turn reconstructs persisted user and assistant state without duplicating
   messages, inventing `Starting response`, clearing an uncommitted draft, or starting another
   provider request.
9. At 390 px, member attribution, mention suggestions, disclosure, composer, and Stop remain visible
   without horizontal document overflow. Keyboard focus never escapes an open mention list or
   disclosure dialog.
10. Another model's generated output never gains system-message authority when provided as group
    context. It remains attributed assistant material or a clearly delimited, low-authority
    transcript record.
11. A roster may contain one to eight active Cupcakes. A one-member roster is a valid direct group;
    an empty roster blocks preflight and cannot claim a turn was sent.

## Contract questions to close before E2E implementation

- Stable group/member IDs, CRUD methods, bootstrap fields, and project-scoped list behavior.
- Send/preflight method names and exact input/output DTOs.
- Whether the runtime selects one speaker or a bounded ordered set; the maximum and the persisted
  selection explanation.
- Event names and correlation fields for group run, speaker start/delta/complete/cancel/failure.
- Durable message metadata for group ID, member ID, provider route, triggering user message ID, and
  selection reason.
- Mention wire format and duplicate-name validation behavior.
- Cancellation result when the user turn committed versus cancellation before commit.
- Recovery behavior for a process exit or reload while a speaker is running.

## Agreed runtime contract

- Smart mode uses the user-configured lead model only after a no-I/O preflight discloses and binds
  the selector plus every possible candidate route. Explicit mentions bypass selector calls.
- Default and hard bounds are two and three selector/responder calls, with zero selector retries.
  Each completed reply may trigger one bounded reevaluation; null, failure, Stop, an output limit,
  or budget exhaustion terminates the turn.
- Mention chips contain participant ID, persona ID, source start/end offsets, and the exact token.
  Runtime validation checks the current `@handle` slice, ordering, overlap, enabled membership,
  roster revision, branch head, and readiness.
- One confirmation token binds the whole ordered route/resource/call-cap authorization. Send
  atomically revalidates the digest and rejects drift before any model call.
- Prior Cupcake output remains attributed assistant-role history and is explicitly delimited as
  low-authority generated evidence. It is never promoted to a system message.
- Exactly one user message is persisted. Speaker snapshots are stored before calls. Nonterminal
  turns become interrupted after restart and never resume automatically.

## Required automated scenarios

| Scenario                 | Required evidence                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Create and reload        | Group title, project, member order, stable member IDs, and conversation history match after reload.                                     |
| Mention keyboard         | `@` opens suggestions; arrows move the active option; Enter inserts a stable mention; Escape closes and restores composer focus.        |
| Unknown mention          | Text remains literal; no member ID is bound from it; normal selective routing remains explicit and deterministic.                       |
| Duplicate names          | Both choices show route/provider disambiguation; plain ambiguous text does not silently pick one.                                       |
| Selective local response | Only the chosen local member receives the turn; no cloud preflight or second autonomous response occurs.                                |
| Cloud selection          | Preflight includes exact group/member/route/project bindings; send occurs only after explicit confirmation.                             |
| Changed selection        | Stale confirmation cannot authorize a different member set.                                                                             |
| Unavailable member       | Member is visibly unavailable and cannot be selected; automatic selection reports skip/fallback truthfully.                             |
| Stop then send again     | First speaker settles cancelled with partial text; draft/user persistence is correct; second run shows Stop and uses one fresh request. |
| Reload midturn           | Persisted state rehydrates once; no automatic send, no duplicate user row, and no blank response shown as active.                       |
| Narrow attribution       | 390 px view has no document overflow and every assistant turn exposes member, model/provider, and state.                                |

## Instrumentation rules

- Browser mocks record every runtime request and emitted event. Tests assert exact call counts,
  ordering, and bound IDs rather than only visible labels.
- Every scenario watches `pageerror`, console errors, and unhandled rejections.
- Timing assertions use bounded polling around durable state and never fixed sleeps.
- Stop/reload tests keep authoritative mock history separate from optimistic renderer state.
- Cloud tests fail if any send-like method appears before preflight confirmation.

## Adversarial source findings to lock with regressions

1. The preflight wire shape must distinguish a participant route record from the flat model route
   shown in disclosure. The renderer must never infer the shape through `Record<string, unknown>`;
   contract validation covers every eligible member, ineligible member, selector, disclosure route,
   selector-use record, and persisted member record.
2. Send-time route revalidation compares the same normalized route fields that were bound during
   preflight. Presentation-only fields such as selection reason and attachment compatibility cannot
   make an unchanged route appear stale.
3. Cancelling or timing out during an active member settles that durable member as cancelled and
   keeps any persisted partial message ID. The group turn and member cannot disagree after reload.
4. Runtime startup converts every nonterminal persisted group turn to interrupted before serving
   reads. The renderer never needs an in-memory preflight token to display that recovered truth.
5. Every member failure event includes the exact turn ID, sequence, participant snapshot, and
   persisted message ID when one exists, so one failed speaker cannot settle another speaker's row.
6. An unavailable direct mention yields structured member identity, reason code, and repair action
   without permitting the send. A generic error string alone is insufficient for the repair UI.
7. Runtime mention validation checks token boundaries as well as UTF-16 offsets and exact token
   bytes. A forged chip inside an email address, longer identifier, or code token is rejected.
8. Direct mentions follow the explicit-response cap agreed for the product; changing the Smart
   default cannot silently lower the mention cap.

## Executed renderer QA

`tests/e2e/group-chat.spec.ts` drives the real renderer through a stateful desktop-bridge mock. It
persists authoritative history and group-turn records separately from optimistic UI state and emits
the production event correlation fields (`turnId`, shared `runId`, `sequence`, conversation ID, and
speaker snapshot).

Verified on both the 1440×900 Windows Chromium project and the 390×844 narrow-window project:

- duplicate display names remain distinct by handle, role, participant ID, and persona ID;
- Home/End/Enter/Escape mention keyboard behavior retains textarea focus;
- leading whitespace and an emoji preserve exact UTF-16 mention slices in the preflight payload;
- two speakers sharing one group `runId` render as two separately attributed messages and survive
  reload with the same snapshots;
- an unknown mention remains literal text, an unavailable enabled member cannot be selected, and an
  all-disabled roster remains group-scoped without falling through to solo `chat.send`;
- a cloud member produces no send before explicit confirmation and the send receives the exact
  preflight token;
- Stop reconciles the persisted user and cancelled partial assistant response, clears the submitted
  draft without a false unsent error, and remains available on the second group response;
- an interrupted persisted turn is visible after two loads and never calls `groups.turn.send`;
- Add Cupcake separates ready and repairable saved personas and sends the stable persona ID;
- the narrow page has at most one CSS pixel of document overflow while group settings and the
  mention list remain operable.

Final focused results:

- `E:\temp\cupcake-overhaul-20260905\group-chat-qa\results-wide-final`: 7 passed, 1 narrow-only
  skip.
- `E:\temp\cupcake-overhaul-20260905\group-chat-qa\results-narrow-final`: 8 passed.
- `E:\temp\cupcake-overhaul-20260905\group-chat-qa\narrow-group-controls.png` and
  `narrow-mention-menu.png`: visually inspected at native screenshot resolution.

Runtime-owner freeze results received alongside the renderer evidence: 22 focused group tests and 63
combined group/application/database tests passed; strict Pyright, mypy across 121 source files,
owned Ruff checks, contract schema generation, and all 81 contract tests passed. No known group
runtime or contract blocker remained at that freeze.
