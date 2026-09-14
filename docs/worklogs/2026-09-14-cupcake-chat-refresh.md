# Cupcake Chat refresh: local owner candidate

The owner-requested rebrand, clearer conversation styling, everyday demonstration collection,
navigation repairs, additional generated scenes, and Full freedom default are implemented in local
product commit `4ed13795f383cf9513bbf247a831cdc632ab50da`. The Windows executable and unsigned NSIS
installer were built to completion and the actual packaged owner app was tested through Playwright
over its WebView2 debugging connection. No push, publication, ordinary-profile installation, VM,
zoom testing, or foreground UI automation was performed.

## Delivered behavior

- Cupcake Chat name and new cupcake/chat mark. The custom title strip no longer repeats the brand.
  The stable binary name, storage identifier, and credential paths preserve profile compatibility.
- Human messages use a light, accent-tinted surface and dark text; assistant replies use a darker
  surface matched to the scene. Avatars and speaker names share the same alignment. Chat body text
  is 17 px with more line spacing and wider message areas.
- Slimmer New chat, rounded Recent highlights, and All chats across projects beside Recent. Unsaved
  New chat drafts and opening/cancelling Add Cupcake create no database conversations.
- Full project-card hit area and atomic artifact-project updates. The selected document's content
  follows its identity, preventing old content beneath a new title.
- Larger Models typography and a simpler current-model row.
- A normal Send, retry, edit, or continuation performs its necessary preflight internally without
  asking for a second cloud-send confirmation. Valid group sends follow the same principle.
- Full freedom is the default and existing legacy defaults migrate once. The permission-policy
  chooser is removed. Credential isolation, OS sandboxing, project boundaries, and explicit
  compatibility API denials are retained.
- Three scenes generated with the image-generation tool: Lavender cloud parlour, Ember rain café,
  and Citrus solar studio. Their final wallpaper assets total approximately 669 KB. All seven
  wallpaper choices after Copper workshop now persist through the runtime whitelist.

## Everyday collection and provenance

The active owner profile contains **10 chats, 6 projects, and 16 artifacts**. Six new everyday chats
contain **30 complete real Groq/Cohere replies**: cooking from fridge ingredients, texting a
landlord, rescuing a Saturday, packing lightly, understanding percentages, and splitting dinner
costs. The final artifact in each new conversation matches the saved assistant reply's SHA-256 and
source message ID. Natural follow-ups correct overly formal or invented details; assistant history
was not rewritten to hide those mistakes. These are scripted demonstration prompts with real
provider responses, not actual customer histories.

Four existing feature demonstrations remain: donor CSV validation, spreadsheet formulas, a named
Cupcake group with branches, and the real app-managed Qwen3 CUDA budget conversation. Earlier staged
projects, outgoing chats, failed incomplete attempts, and abandoned empty drafts were archived. The
additional one-turn UI Send verification chat was also archived after readback.

`scripts/create-owner-everyday-v2.mjs --phase verify --port 10131` is a read-only provenance check.
Creation and named cleanup require explicit execution modes, so verification does not issue new
provider requests or alter the collection. Ordinary new profiles are not seeded.

## Verification observed on this package

| Check                            | Observed result                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop unit suite               | 93 tests in 13 files passed; typecheck, lint, and formatting passed.                                                                                           |
| Broker and migration checks      | 123 library tests passed, 1 ignored; 10 main, 7 process, and 3 contract tests passed.                                                                          |
| Runtime theme/personality checks | 7 wallpaper cases and the personality case passed.                                                                                                             |
| Native bridge                    | Packaged Windows app at `https://tauri.localhost/`, 1440 × 920 CSS pixels, scale 1.                                                                            |
| Packaged UI helper               | All 25 checks passed.                                                                                                                                          |
| Draft behavior                   | Four New chat/navigation cycles and Add Cupcake cancellation left the 10-chat inventory unchanged.                                                             |
| Global chat navigation           | Displayed count matched runtime; opening chats from two projects kept title and project coherent.                                                              |
| Project card                     | Clicking the top of a non-active card selected its project.                                                                                                    |
| Artifact transitions             | 284 normal-switch and 433 rapid-switch frames; no blank, loading, error, or mixed-project frames.                                                              |
| Speaker distinction              | Different rendered backgrounds and matching avatar/name geometry.                                                                                              |
| Themes                           | All seven post-Copper scenes activated and persisted; actual chats in all three new scenes were visually inspected. Original Pistachio settings were restored. |
| Real UI Send                     | Clicked Send once; a complete `openai/gpt-oss-120b` reply returned through the selected Groq compatible route, with finish reason `stop` and zero dialogs.     |
| Full freedom                     | Clicked Run tests on saved `validate_donors.py`; 18 tests passed without entering approval state.                                                              |
| Restart                          | Provenance check passed again: 10 chats and their artifacts persisted; original NVIDIA NIM model selection remained.                                           |
| Package                          | Sidecar verification, bundle smoke, and local release-candidate audit passed.                                                                                  |
| Shutdown                         | All 11 owned processes exited in 1.739 seconds and 1.685 seconds on the two observed closes; no owned local model remained. GPU marker stayed `no`.            |

The first send-polling helper mistakenly checked `message.status` instead of `message.state` and
timed out after the response had already completed. Independent readback in
`real-ui-send-verified.json` records the real complete response, finish reason, and zero observed
dialogs; the helper was corrected. This was a verifier defect, not a failed or synthetic send. The
first bundle smoke found both old and renamed installers. The obsolete installer was moved to
`E:\uesless\cupcake-pre-rebrand-installer-20260914`, after which smoke and audit passed.

First launch after replacement reached the helper's home-ready point in 16.088 seconds; the next
native restart took 3.490 seconds. Both had zero captured browser errors. These timings are
observations, not a startup-performance guarantee.

## Package identity and recovery

| Artifact                                            |      Bytes | SHA-256                                                            |
| --------------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| `CupcakeAI.exe` (visible ProductName: Cupcake Chat) | 13,480,448 | `CF6ED808072AA638D560F0C05A1526800EE71985FB9A43DAB9535801D2B76A28` |
| `Cupcake Chat_2.0.0-rc.1_x64-setup.exe`             | 83,186,237 | `77C6D1AB529388956E8FA911527E3EAAB30056F4F6D317CE1248AB28457C05C6` |
| Frozen runtime, source `fbb4088`                    | 28,674,683 | `ED6D1F63E9833BD2889441B2F34BC52CC6475BFBD6D9616CC3F8B5E15B3F11E0` |
| Tool broker, source `dafbd04`                       | 10,750,464 | `8ADA2FEB099AFFE2004B71B30513A3C509C8451D6AA728759C254E753AA4127F` |

The runtime's 820 support files and manifest were verified before staging. The manifest hash is
`6392848F7F3B2B56D29B7020E1096A4704104D80F1EBA29B263D8ACC9965A09A`. Runtime source is unchanged
between its freeze and product commit; subsequent product changes affect frontend presentation.

- Launch: repository-root `Launch Cupcake Chat Test.vbs` (previous launcher also works).
- Executable: `E:\temp\cupcakeagi-tauri-target\release\CupcakeAI.exe`.
- Installer:
  `E:\temp\cupcakeagi-tauri-target\release\bundle\nsis\Cupcake Chat_2.0.0-rc.1_x64-setup.exe`.
- Owner profile: `E:\temp\cupcakeai-owner-test-20260902`.
- Verified closed-profile backup: `E:\temp\cupcake-owner-backups\cupcake-chat-verified-20260914`.
- Pre-migration collection backup:
  `E:\temp\cupcake-owner-backups\cupcake-chat-everyday-20260914-complete`.
- Package, screenshots, transitions, Send, tool, restart, and shutdown receipts:
  `E:\temp\cupcake-chat-rebrand-20260914`.
- Everyday reply/artifact hashes and archive receipts: `E:\temp\cupcake-chat-everyday-v2-20260914`.
- Generated icon evidence: `E:\temp\cupcake-chat-brand-20260914`.

## Scope of evidence and remaining limitation

The CUDA conversation and successful multi-provider group demonstration are retained from earlier
real runs; no fresh GPU inference was necessary for this UI refresh. Smart group's automatic
quiet-closing remains unreliable in earlier live provider trials (invalid selector responses and a
provider error); it is not claimed as verified here. Group mode remains chat-only. Earlier installer
lifecycle and broader overhaul evidence are in
[the previous ledger](2026-09-05-independent-overhaul.md). This renamed NSIS installer was built and
audited, while functional testing used its matching packaged executable on this machine.

The state changes were checked against React's guidance on deriving view state and avoiding
post-render prop adjustment
([React documentation](https://react.dev/learn/you-might-not-need-an-effect)). The rebrand preserves
the stable identifier and binary while changing the visible product name, following the independent
fields in [Tauri configuration](https://v2.tauri.app/reference/config/).
