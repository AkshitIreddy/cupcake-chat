# Interactive onboarding UX research and implementation record

- Date: 2026-09-05
- Scope: CupcakeAI first-run and replay onboarding
- Research basis: 24 first-party platform, accessibility, and interaction-design sources
- Current implementation evidence: renderer fixture on the shared Vite development build
- Native baseline evidence: preserved packaged executable captured before this change

## Decision

CupcakeAI now uses an optional eight-chapter **workbench map** instead of a passive slide deck. The
dialog remains centered while a spotlight identifies the real navigation target behind it. The
chapters offer real choices for profile identity, assistant portrait, theme, wallpaper, providers,
local-memory fallback, permission policy, and the next workbench destination. They read the current
profile state and distinguish a saved/customized setup from a safe default or an unfinished optional
connection.

This design deliberately does not load a model, warm the GPU, download a runtime, request a
credential, or enable password protection on its own. Those effects begin only after an explicit
user action. The tour can be skipped, is not presented again after completion, and remains available
from Settings > General.

## Source synthesis

Apple's onboarding guidance favors an optional, fast flow shown after launch, teaching through real
interaction, contextual tips near the relevant interface, deferred nonessential setup, and no large
download gate. Microsoft's current TeachingTip guidance similarly treats instruction as transient
and noncritical, supports both targeted and untargeted teaching moments, recommends short topics,
and discourages showing too many tips at once. CupcakeAI applies these recommendations by making the
tour optional and replayable, keeping runtime and provider setup on demand, and breaking the product
into selectable chapters rather than requiring a linear setup wizard.

WAI-ARIA's modal-dialog pattern requires the underlay to be inert, initial focus inside the dialog,
Tab and Shift+Tab containment, Escape dismissal, a visible close control, and focus restoration.
WCAG 2.2 adds practical constraints relevant to a tour: keyboard parity, logical focus order,
visible and unobscured focus, minimum target size, reflow without horizontal scrolling, text-spacing
resilience, sufficient text and non-text contrast, programmatic status announcements, and an option
to suppress interaction-driven motion. The implementation follows those behaviors rather than
marking an interactive overlay modal while leaving the app underneath keyboard-accessible.

## Primary source ledger

1. [Apple Human Interface Guidelines: Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
   — optional, interactive, contextual onboarding after launch; postpone nonessential setup and
   downloads.
2. [Microsoft WinUI: Teaching tip](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/dialogs-and-flyouts/teaching-tip)
   — targeted or untargeted contextual teaching, explicit or light dismissal, succinct topics, and
   restrained frequency.
3. [WAI-ARIA APG: Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) —
   inert underlay, initial and restored focus, contained Tab sequence, Escape, visible close
   control, and correct modal semantics.
4. [WCAG 2.2: Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum)
   — overlays must not hide the keyboard's active component.
5. [WCAG 2.2: Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
   — at least 24 by 24 CSS pixels or sufficient spacing.
6. [WCAG 2.2: Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html) —
   visible focus with sufficient area and contrast.
7. [WAI-ARIA APG: Developing a Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
   — platform-conventional focus movement and one logical tab stop for composite controls.
8. [WAI-ARIA APG: Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) — selected state,
   arrow-key expectations, and predictable panel relationships.
9. [WAI-ARIA APG: Disclosure Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) —
   explicit expanded state and keyboard-operable disclosure.
10. [WCAG 2.2: Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) —
    announce status changes without unexpectedly moving focus.
11. [WCAG 2.2: On Focus](https://www.w3.org/WAI/WCAG22/Understanding/on-focus.html) — focus alone
    must not trigger an unexpected context change.
12. [WCAG 2.2: On Input](https://www.w3.org/WAI/WCAG22/Understanding/on-input.html) — changing a
    setting should not unexpectedly change context without advance explanation.
13. [WCAG 2.2: Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) — all
    functionality needs a keyboard path without timing-dependent input.
14. [WCAG 2.2: Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) —
    sequential focus must preserve meaning and operability.
15. [WCAG 2.2: Headings and Labels](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html)
    — labels and headings must describe their topic or purpose.
16. [WCAG 2.2: Consistent Help](https://www.w3.org/WAI/WCAG22/Understanding/consistent-help.html) —
    repeated help entry points should remain predictably placed.
17. [WCAG 2.2: Redundant Entry](https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html) —
    reuse already supplied information instead of demanding it again.
18. [WCAG 2.2: Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)
    — interaction-driven nonessential motion must be suppressible.
19. [WCAG 2.2: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
    — readable text contrast.
20. [WCAG 2.2: Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
    — perceivable control boundaries, icons, and states.
21. [WCAG 2.2: Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) — narrow content
    must reflow without two-dimensional scrolling.
22. [WCAG 2.2: Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html) —
    content must tolerate increased line, paragraph, letter, and word spacing.
23. [WCAG 2.2: Content on Hover or Focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html)
    — transient supplemental content must be dismissible, hoverable, and persistent where
    applicable.
24. [Microsoft: Responsive design techniques](https://learn.microsoft.com/en-us/windows/apps/design/layout/responsive-design)
    — adapt the layout to the window rather than assuming a fixed desktop width.

## Baseline audit

The prior packaged tour is preserved at:

- `E:\temp\cupcake-overhaul-20260905\baseline\20-onboarding-step-{1..8}.png`
- `E:\temp\cupcake-overhaul-20260905\baseline\20-onboarding-step-{1..8}--dialog.png`
- `E:\temp\cupcake-overhaul-20260905\baseline\32-onboarding-step-1-narrow.png`
- `E:\temp\cupcake-overhaul-20260905\baseline\33-onboarding-step-2-narrow.png`

Observed defects in that executable:

- Steps 3–5 allowed underlying chat, project, and model text to bleed through the tutorial surface;
  step 5 was particularly dense.
- At 390 pixels wide the panel sat against and clipped at the right viewport edge instead of keeping
  equal gutters and its corner radius.
- The profile-name field appeared blank even though the saved profile name was Akshit, and the
  narrow avatar choices were too small.
- The Full Freedom explanation claimed routine confirmations were removed while the Tools surface
  separately said high-impact actions always ask.

## Current rendered evidence

Renderer captures are under `E:\temp\cupcakeai-onboarding-qa-20260905`:

- Wide 1440 by 900: `wide-welcome.png`, `wide-identity.png`, `wide-appearance.png`,
  `wide-providers.png`, `wide-runtime.png`, `wide-projects.png`, `wide-tools-memory.png`, and
  `wide-security.png`.
- Narrow 390 by 844: corresponding `narrow-*.png` captures.
- Reduced motion at 1024 by 700: corresponding `reduced-*.png` captures.
- Readable close inspections of the final chapter: `close-map.png`, `close-copy-top.png`,
  `close-copy-middle.png`, and `close-copy-footer.png`.

Observed after the implementation:

- The dialog remained mathematically centered at wide and reduced-motion sizes. The narrow layout
  kept equal 7-pixel side gutters and preserved both corner radii.
- Body scroll width matched viewport width at 1440, 1024, and 390 pixels; no horizontal overflow was
  present.
- The original six-scene onboarding atlas remained crisp, square-cropped, and unsquashed. Profile
  and assistant avatar choices were readable at narrow size.
- The target spotlight clearly identified the real Models, Projects, Tools, Settings, and profile
  navigation controls while the opaque dialog surface prevented text bleed.
- Programmatic initial focus landed inside the dialog. An explicit narrow-width focus-loop check
  confirmed both last-to-first Tab and first-to-last Shift+Tab wrapping; Escape closed the dialog,
  and focus restoration was enabled. No page or console errors occurred during the three capture
  runs.
- The renderer typecheck passed after the concurrent integration settled.
- The focused Windows Chromium flow passed all eight chapters, Finish, replay visibility, centering,
  square artwork, and the titlebar search contract (`tests/e2e/app.spec.ts`, "first-run tour").

The screenshots above are renderer evidence. The packaged executable still needs to be rebuilt and
the same onboarding states must be captured from that fresh executable before native acceptance is
claimed.
