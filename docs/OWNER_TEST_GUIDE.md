# Owner test guide

Double-click `Launch CupcakeAI Test.vbs` in this repository. It opens the local Windows test app
with the existing owner workspace, without a terminal or password prompt. It does not install,
publish, or update anything.

## Explore the saved work

| Project                      | What to open                                                                                                      | Real route                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Harbor Data Reliability Lab  | Sensor quality repair with reviewed tests; open `harbor_quality_checked.py`, its two revisions, and **Run tests** | Groq GPT-OSS 20B, followed by an explicitly manual review; local Python AppContainer |
| Northstar Launch Studio      | From research brief to 14-day launch plan; saved plan artifact                                                    | Cohere Command A+                                                                    |
| Atlas Grounded Decision Room | The grounded memo discussion, pinned artifact, and remembered decision                                            | NVIDIA NIM                                                                           |
| Private Studio Notebook      | Private notes to a practical action brief; saved local action brief                                               | App-managed Qwen3 8B on CUDA                                                         |

The conversations contain actual model responses. Archived checks preserve failed provider attempts
and implementation diagnostics. Model-generated code is a draft: the Harbor artifact's original
version's eight-test run had one error, while its clearly manual review revision passes ten tests.
The separate NVIDIA code trial has a review notice rather than a fabricated passing result.

The coding agent prepared the review messages and manual code revision during testing. They are
clearly separate from the hosted models' original output; the council prompt's “human review” label
describes the review step and does not mean the owner personally wrote it.

Models lists the model publisher separately from the service that runs it. Provider setup includes
connection testing and discovered availability. Groq, Gemini, Mistral, OpenRouter, and Cloudflare
are supported options, but a free allowance does not guarantee that a particular model is currently
available. The saved successful hosted demonstrations use Groq, Cohere, and NVIDIA NIM; archived
quota or provider errors are not advertised as working demonstrations. Each person supplies their
own credentials.

## Configure a small group

Use **Add Cupcake** in a conversation to create or add a named assistant with its own role,
instructions, personality, and exact model. The lead's model makes bounded Smart decisions about who
can add value. Each member speaks at most once per turn, with a configurable one-to-three reply cap.
The conversation never continues indefinitely on its own.

Open the group response settings to pause a Cupcake without losing its configuration, then resume it
when needed. A paused member is excluded from new turns and mention choices. Juniper is configured
for the installed local Qwen model; loading that exact model in Models is required before it can
answer. Configuring or resuming a Cupcake does not load model weights.

Type `@` and choose a Cupcake from the menu to direct a turn. A selected mention bypasses Smart
selection and reaches only those mentioned members. Plain pasted `@name` text is not a verified
mention. **Mentions only** is available when you want complete control over who responds.

Before cloud group work, the app discloses the possible destinations and limits. Offline mode blocks
cloud traffic. Group chats currently have no tools. Stop cancels the whole current turn; committed
text and partial responses remain saved.

A quiet Smart turn can still use a selector call to decide that nobody should speak. The default
two-reply cap allows at most two selector calls and two replies; it is not a zero-cost background
presence detector. Members never start another round without a new user submission.

Open **A small launch council** in Harbor to see Mara's Groq plan, Quill's separate Cohere critique,
a direct `@Quill` follow-up, and a quiet closing turn. A later operator review challenges the first
plan's timing and data handling; Mara's actual revision follows it. Both drafts remain visible, and
the final closing message also receives no reply. These are proposed plans, not evidence that a
deployment or data-quality test happened. Juniper is saved in this council and left paused.

## Local model and privacy

The installed Qwen3 8B model is left unloaded when testing finishes. Open Models to load it for
another private conversation, then unload it when finished. Its weights and runtime are under the
owner profile on E. Loading a model uses real GPU/RAM capacity; opening saved history does not load
it.

Workspace password protection is optional. Content encryption is a separate setting. Provider
credentials remain protected by Windows DPAPI and are shared with this Windows user's Cupcake
workspaces. Backup recovery requires the same Windows user/computer and prepares a separate recovery
profile.

## Evidence and limits

See `docs/worklogs/2026-09-05-independent-overhaul.md` for the acceptance ledger,
`docs/research/2026-09-05-native-audit.md` for exact package and lifecycle evidence, and
`docs/known-issues.md` for remaining limitations. No push, publication, production signing,
distribution, or updater activation is authorized.
