# Sidebar, message bubbles, tooltips, and generated icon

Local product commit `90085b0` implements the owner's corrections to the previous refresh:

- All chats is a pressed/unpressed toggle in the Recent heading. It expands the scrollable sidebar
  to include active chats from every project, without changing the main page. Switching it off
  restores the current project's three recent chats. Opening a cross-project chat still switches its
  project context correctly.
- User bubbles derive their background, border, and text from the selected theme, replacing the
  fixed cream palette. Content-sized width, reduced padding, and an action toolbar outside normal
  layout remove excess area. Speaker names and avatars remain aligned with assistant messages.
- App tooltips appear after 150 ms on hover and immediately on keyboard focus. Escape dismisses
  them. Sidebar tooltips sit beside the list; all tooltips let clicks reach controls underneath. The
  first packaged probe caught pointer interception, which was fixed and rebuilt before the final
  acceptance run. The tooltip role, keyboard behavior, and description relationship follow
  [WAI's tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/).
- The built-in image-generation tool made the replacement cupcake icon. The same selected image
  supplies the UI, Windows executable, installer, and tray sizes. See
  [asset and exact prompt](../brand/cupcake-chat-icon.md).

## Observed verification

- 93 desktop tests passed. Typecheck, lint, package smoke, and local candidate audit passed.
- All **30 checks** passed against the final packaged Windows app, including sidebar toggling
  without navigation, all 11 current chats matching runtime inventory, cross-project opening,
  hover/focus tooltips, compact bubbles, previous draft behavior, and artifact transitions.
- The measured hover-to-tooltip interval was **219 ms**, including Playwright interaction overhead.
- Copper, Pistachio, Lavender, Citrus, plain light, and plain dark were rendered and visually
  inspected at the normal window scale. User-message text contrast ranged from **8.45:1 to
  12.59:1**. The inspected paragraph bubble measured 705 × 113 CSS px against a 1,074 px assistant
  column; the owner's existing two-letter message measured **210 × 85 CSS px**.
- The six everyday demo scenarios and their artifact provenance passed readback again. The
  owner-added conversation was preserved. No provider requests or local inference were needed.
- The current Ember theme was restored. All 11 owned app processes exited in 1.672 seconds on the
  final main check and 1.649 seconds after the short-message restart check; no owned model remained.

Evidence: `E:\temp\cupcake-sidebar-polish-20260914`. `final-native` and `theme-bubbles.json` contain
the final checks; `diagnostic` is explicitly the earlier CSS-injection diagnosis, not final package
proof. The final package was tested without injected styles.

| Package                                 |      Bytes | SHA-256                                                            |
| --------------------------------------- | ---------: | ------------------------------------------------------------------ |
| `CupcakeAI.exe`                         | 13,428,224 | `C9A6E3325D2C8C9EB9A41B178CF31CF2E6DAFF295AA6F56BFB3BA4721320DB04` |
| `Cupcake Chat_2.0.0-rc.1_x64-setup.exe` | 83,370,732 | `6D64AB50D896DF3BC8E3E12D1031F0E92814DB0BEE71BBA9236F87565917C55D` |

Use repository-root `Launch Cupcake Chat Test.vbs`. The test profile and stable internal executable
name are unchanged. Work remains on local master, with unrelated edits preserved and no push or
publication.
[Previous acceptance and remaining group limitation](2026-09-14-cupcake-chat-refresh.md).
