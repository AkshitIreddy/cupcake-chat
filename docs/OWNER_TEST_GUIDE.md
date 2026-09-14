# Cupcake Chat owner test guide

Double-click **Launch Cupcake Chat Test.vbs** in the repository root. It opens the packaged Windows
app with the existing owner profile and no terminal. The previous launcher still works.

## A workspace that feels used

The demo collection has **10 chats across 6 projects**, with **16 useful artifacts**. Your own chats
appear alongside these. Six new everyday conversations contain 30 real Groq/Cohere replies,
including normal corrections and follow-ups. Their final artifacts come directly from real
responses. The user prompts are scripted demo scenarios; these are not recordings of real customers,
and no external messages were sent.

| Project                  | Chat                                                    | Useful result                                                                              |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Life, Admin, Done        | what can i make without going shopping?                 | An egg-free dinner using what's in the fridge, adjusted for a flatmate and next-day lunch. |
| Life, Admin, Done        | help me text my landlord about this leak                | Two short, copyable texts; the user catches and corrects an invented detail.               |
| Life, Admin, Done        | my saturday is already getting away from me             | A realistic plan that leaves a free evening instead of optimizing every minute.            |
| Life, Admin, Done        | what do i actually need to pack?                        | A minimal two-bag checklist, refined when the first answer overpacks.                      |
| Make It Click            | percentages have never made sense to me                 | A patient lesson, practice before answers, and a small cheat sheet.                        |
| Friends & Money          | who owes what after dinner?                             | Dinner and cab costs reconciled into the fewest transfers and a group-message draft.       |
| Data Cleanup Workshop    | The donor CSV that lies                                 | A reviewed Python artifact with a real 18-test sandbox result.                             |
| Data Cleanup Workshop    | Teach me the orders sheet without making me feel stupid | Spreadsheet formulas explained gradually, plus a reference artifact.                       |
| Neighborhood Repair Cafe | Thirty-six broken things, one Saturday                  | Three named Cupcakes, mentions, a successful Smart turn, branches, and practical handouts. |
| Private Money Reset      | Where did my salary go?                                 | A real app-managed CUDA conversation with a budget artifact and project memory.            |

The earlier staged projects and abandoned empty chats have been archived. Recovery copies remain
outside the app. The four retained feature demonstrations include earlier user/editor artifact
revisions; those are visibly distinct from model-authored output.

## Suggested video path

1. Toggle **All chats** beside Recent to expand every project's chats inside the sidebar, then open
   the landlord or Saturday chat. Human messages use compact bubbles tinted from the current theme;
   Cupcake replies use its raised surface. Toggle All chats off to return to the current project's
   recent chats.
2. Open the recipe or packing artifact to show a useful result that survives the chat.
3. Open the percentages chat to show teaching that responds to the user's actual attempt.
4. Show the repair-cafe group's named Cupcakes and **Event run sheet** branch. Use the successful
   two-reply Smart turn; automatic quiet-closing remains unreliable and is not a verified claim.
5. Open the donor CSV artifact and its Task with **18 passing tests**, then the local budget chat
   and Memory panel. The local model is unloaded; saved replies still show its name.

## Changes in this build

- Cupcake Chat name and new cupcake/chat icon; a title strip without duplicate branding.
- Slimmer New chat button, rounded Recent highlights, and All chats beside Recent.
- All chats expands the sidebar itself. Tooltips appear after 150 ms, or immediately on keyboard
  focus; Escape dismisses them. The new icon was made with the image-generation tool.
- New chat stays a draft until a message is sent. Dismissing Add Cupcake also creates no chat.
- Send, retry, edit, and continue no longer ask for a second cloud confirmation. Model selection
  remains explicit. Enabled tools use Full freedom by default; the permission-policy screen is gone.
- Project cards respond across their main surface. Artifacts switch project identity and loaded
  contents together, avoiding blank or mismatched intermediate frames.
- Larger Models text and a simpler current-model row.
- Three new image-generated scenes: **Lavender cloud parlour**, **Ember rain café**, and **Citrus
  solar studio**. Existing scenes remain in Appearance.

## Evidence and recovery

- Current UI/package evidence: `E:\temp\cupcake-sidebar-polish-20260914`.
- Current verification: [Cupcake Chat acceptance](worklogs/2026-09-15-sidebar-polish.md).
- Everyday chat provenance and cleanup: `E:\temp\cupcake-chat-everyday-v2-20260914`.
- Verified closed-profile snapshot: `E:\temp\cupcake-owner-backups\cupcake-chat-verified-20260914`.
- Previous collection: `E:\temp\cupcake-owner-backups\video-showcase-20260914-complete`.
- Earlier CUDA and sandbox receipts: `E:\temp\cupcake-video-showcase-20260914`.

The profile stays at `E:\temp\cupcakeai-owner-test-20260902`. The executable remains named
`CupcakeAI.exe` internally to preserve existing paths and storage identity. The visible app and
installer are Cupcake Chat. No push or publication is part of this local candidate.
