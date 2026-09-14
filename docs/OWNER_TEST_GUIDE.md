# Owner test guide

Double-click `Launch CupcakeAI Test.vbs` in the repository root. It opens the packaged Windows test
app with the owner showcase profile, without opening a terminal. The launcher does not install,
publish, or update the app.

## What is in this workspace

The owner profile was cleared before this collection was created. Its conversations use scripted,
fictional source bundles designed around ordinary problems a person might actually bring to the app.
The assistant replies were produced through the real configured Groq, Cohere, and local CUDA routes.
No reply is a fixture pasted in as an assistant message.

The conversations sometimes correct a weak first answer. Those corrections remain in the chat so a
video can show useful iteration rather than a perfect one-shot demo. Saved outputs that needed fact
checks received later, clearly recorded **user/editor** revisions. The original model-authored
revisions remain in artifact history; editor revisions are not represented as model responses.

No email, refund, cancellation, order, application, support action, supplier confirmation, or other
real-world action was sent or performed. Names, organizations, towns, tickets, finances, and records
in the source bundles are fictional.

## Showcase projects and conversations

| Project                    | Conversation                                                | Route                     | Feature beat                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Community Pantry           | **Grant report due at five**                                | Groq + Cohere follow-up   | References a project source, audits rows and totals, reconciles corrections, and saves a report with revision history.                                                                                   |
| Small Business, Less Panic | **One tiny change, again**                                  | Cohere                    | Compares signed scope with new requests, separates estimates from unapproved time, calculates a proposed add-on, and drafts a warm approval email.                                                       |
| Study Rescue               | **Can I still pass this semester?**                         | Groq + Cohere follow-up   | Turns weighted grades and real availability into minimum targets, deadline priorities, a small study plan, and a lecturer email.                                                                         |
| Private Money Reset        | **Where did my salary go?**                                 | Cupcake Local on CUDA     | Keeps a fictional budget local, protects work tools and family money, calculates exact planned savings, and uses a project memory.                                                                       |
| Neighborhood Repair Cafe   | **Thirty-six broken things, one Saturday**                  | Cohere + Cloudflare group | Gives Mara, Quill, and Remy distinct roles, preserves 12 real persona replies, includes one successful bounded Smart turn with two replies, and saves a reviewed run sheet. Quiet closing is not proven. |
| Next Job, Honestly         | **One CV, two very different jobs**                         | Cohere                    | Branches one source-grounded CV into operations and customer-success directions while keeping unsupported skills explicit.                                                                               |
| Small Business, Less Panic | **The support inbox is on fire**                            | Groq + Cohere follow-up   | Sorts a fictional queue by impact and SLA, assigns a bounded first wave, applies the refund-review rule, and drafts reusable replies.                                                                    |
| Data Cleanup Workshop      | **The donor CSV that lies**                                 | Groq + AppContainer       | Produces a standard-library Python validator, preserves the model draft, and records a reviewed user/editor revision whose saved-code Task passed 18 tests.                                              |
| Plans That Survive Reality | **A rainy Saturday in Mosswick**                            | Cohere                    | Plans from a supplied fictional timetable, compares two routes, honors mobility and rain constraints, and keeps estimated travel buffers explicit.                                                       |
| Data Cleanup Workshop      | **Teach me the orders sheet without making me feel stupid** | Groq + Cohere follow-up   | Teaches ordinary and Excel-table formulas one step at a time, checks expected row results, and creates a one-page reference.                                                                             |
| Private Team Notebook      | **What did we actually decide?**                            | Cupcake Local on CUDA     | Extracts decisions, named owners, unknowns, budget and timing dependencies, then remembers how tentative dates should be handled.                                                                        |
| Small Shop Control Room    | **What do I reorder before Monday?**                        | Cohere                    | Applies pack rounding and incoming-stock rules, chooses the highest-risk order under budget, and leaves pasteable Excel formulas.                                                                        |

The final persisted-profile audit records **10 active projects**, **12 featured conversations**, and
**103 complete unique assistant replies** across their branches. The workspace has **26 current
artifacts**, **two project memories**, and **two code-execution Tasks**. The accepted
donor-validator Task is the run with 18 passing tests; the earlier compatibility failure remains
visible as useful history.

## A short video route

1. Open **Neighborhood Repair Cafe → Thirty-six broken things, one Saturday**. Show the three
   Cupcake roles, the **Event run sheet** branch, the successful two-reply Smart turn, and the
   reviewed run-sheet artifact. Also open **Printable repair cafe signs.md** and **Volunteer shift
   checklist.md** as practical handouts. Do not present the quiet-closing behavior as verified.
2. Open **Private Money Reset → Where did my salary go?**. Show that the conversation used Cupcake
   Local, reveal totals first, open its project memory, and show that the local model is left
   unloaded afterward.
3. Open **Next Job, Honestly → One CV, two very different jobs**. Scroll to the branch bar at the
   top to switch between Main and Customer success direction, then open the artifact revision
   history.
4. Open **Data Cleanup Workshop → The donor CSV that lies**. Show the model-authored code revision,
   the reviewed editor revision, and the real AppContainer Task result with 18 passing tests.
5. Finish with a practical numbers montage: **What do I reorder before Monday?** for the
   budget-constrained order, then **Grant report due at five** for source references,
   reconciliation, and the final report artifact.

The rainy-day plan, scope-change email, grade rescue, support triage, spreadsheet lesson, and
meeting brief make good alternate clips when a longer video needs variety.

## How to read the evidence honestly

- A chat bubble with provider and model metadata is a real persisted model response from that route.
- A project source artifact begins with `SYNTHETIC FIXTURE SOURCE`; it is fictional input supplied
  to the model, not live customer data or web research.
- An artifact revision marked as user/editor work is a reviewed correction by the testing workflow.
  It must not be described as a model reply.
- Draft messages are copy candidates. They were not sent to customers, lecturers, managers,
  suppliers, or employers.
- Proposed refunds, cancellations, purchases, study outcomes, schedules, and tests are plans until
  the app shows separate evidence that the action occurred.
- The donor validator's first execution attempt rejected an unsupported `__future__` import. The
  reviewed user/editor revision then passed 18 actual AppContainer unit tests. Both revisions remain
  visible; a code-looking chat response alone is never treated as a passing test.
- The repair-cafe group has one verified Smart turn with two completed replies and 12 unique
  assistant messages overall. Five other Smart-selection attempts ended with
  `GROUP_SELECTOR_INVALID`; the quiet closing remains unproven and is not a video acceptance claim.
- Two earlier repair-cafe artifacts shared the run-sheet title. Their current heads were safely
  revised and organized as **Printable repair cafe signs.md** and **Volunteer shift checklist.md**;
  the reviewed **Repair cafe run sheet.md** remains the main output.

The detailed content review and arithmetic checks are in
`docs/worklogs/2026-09-14-video-output-review.md`. Broader package and lifecycle evidence remains in
`docs/worklogs/2026-09-05-independent-overhaul.md` and `docs/research/2026-09-05-native-audit.md`.
Current product limitations remain in `docs/known-issues.md`.

## Local model, providers, and privacy

The installed Qwen3 8B model is left unloaded after testing. Opening its saved conversations does
not load the model. To create another local reply, open **Models**, load the installed model, and
unload it again when finished. Loading uses real GPU and RAM capacity.

Provider credentials remain protected by Windows DPAPI for this Windows account. Hosted demos use
the configured provider connections and each user supplies their own credentials. A provider being
listed in Models does not guarantee that a free allowance or a particular model is currently
available.

Workspace password protection and content encryption are separate optional settings. The showcase
source data is fictional, but the local-only examples still demonstrate the route and project-memory
behavior a private workspace would use.

## Recovery and launch notes

The pre-showcase owner data was moved out of the active profile and can be recovered from:

`E:\temp\cupcake-owner-backups\before-video-showcase-20260914`

A verified recovery copy of the completed collection is also saved at
`E:\temp\cupcake-owner-backups\video-showcase-20260914-complete`. Installed model downloads and the
external credential vault remain separate.

Do not copy that folder back over a running profile. Close the app first and restore only as a
deliberate recovery operation.

If the launcher appears to do nothing, wait for the first packaged start to finish before
double-clicking again. The launcher deliberately keeps helper windows hidden. If the app still does
not appear, check `docs/known-issues.md` and the latest worklog rather than starting several copies.

No push, publication, production signing, distribution, or updater activation is authorized by this
guide.
