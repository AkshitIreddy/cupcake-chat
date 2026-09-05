# Workbench design audit — 2026-09-05

This is an independent review of the `bf689ed` packaged Windows product, followed by source changes.
The baseline was captured from the owner test profile; browser iteration images are separately
labeled and do not prove packaged behavior.

## Observed problems and resulting decisions

- Native Home put the project section below a 1440 × 920 viewport. Its large centered greeting,
  portrait, composer, and vertical gaps dominated the workbench. The revised composition brings a
  compact assistant greeting, composer, and three editable starting prompts above a two-column
  continuation/task/project area. Starting prompts never send a message automatically.
- Every Home recent-conversation button previously navigated to whichever chat was already active.
  Selection now carries the clicked identity. Late asynchronous navigation is ignored after another
  navigation, and overlapping history responses cannot replace a newer selection.
- The command palette advertised arrow/Enter navigation without implementing it. It now supports
  those keys, contains modal focus, restores focus, and actually creates a new conversation.
- Search discarded result identifiers, compared singular backend kinds against plural labels, and
  claimed semantic matches were arriving although the method was lexical only. Result identities,
  project scope, and destination now survive presentation; request generations prevent old queries
  from replacing new ones. The unsupported semantic-progress claim is removed.
- At 390 px, the model name was truncated while the destination text was hidden. The composer now
  gets a separate model/action row and retains its destination text. Offline mode never relabels a
  selected cloud route as Local.
- The Home proactive notice was a hardcoded benchmark claim. It is now shown only for an actual
  reviewable memory state, with a route to Memory. Unexplained recent-chat ordinals and the inline
  title-search shortcut badge are removed.

## Visual system

The existing packaged Bricolage Grotesque display face, Atkinson Hyperlegible body face, and IBM
Plex Mono utility face survive review: they suit a readable, distinctive desktop workspace. Cupcake
identity stays in the assistant portrait, berry accent, and restrained baking language; it does not
justify fictional activity or invented model ratings.

The signature is the assistant's working desk: a compact greeting beside the chosen portrait,
editable starting actions, and visible continuation into projects and saved work. Color tokens stay
scene-specific: cocoa `#2a2322`, warm paper `#fffcf7`, berry `#9f3e62`, pistachio `#5d724f`, and
blueberry `#536594` form the quiet base; selected wallpapers own their foreground and scrim tokens.
The shared title strip is 28 CSS px, with separately reserved window controls. Artwork remains a
continuous scene; translucent content surfaces carry contrast rather than bleaching the image.

This was chosen after inspecting the actual baseline and revised close-ups, not because a particular
framework or old worklog described it as accepted. Reused art is unchanged; new art generation was
unnecessary for the observed layout/behavior problems.

## Primary sources assessed

Retrieved 2026-09-05. These support interaction constraints, not a claim that standards prescribe
CupcakeAI's exact visual style.

| Source                                                                                                        | Relevant evidence and product decision                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [W3C APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)                                | Modal focus enters, remains contained, closes with Escape, and returns to the trigger. Applied to command/forms/onboarding; a modal must really block its underlay.          |
| [W3C APG combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)                                        | Search and selection need an explicit keyboard model. Arrow/Enter behavior must be implemented when advertised; focus semantics cannot be inferred from visual highlighting. |
| [Microsoft navigation basics](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics) | Stable top-level destinations support navigation hierarchy. Keep persistent workbench navigation and carry the selected resource into its destination.                       |
| [Microsoft content layout](https://learn.microsoft.com/en-us/windows/apps/design/basics/content-basics)       | Group related content and use scale/spacing to express hierarchy. Put the next useful action near its content; avoid duplicated page-sized empty states.                     |
| [WCAG 2.2 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)                                    | Content remains operable without two-dimensional page scrolling at narrow equivalent widths. Preserve local table/code scrolling and readable provider disclosure.           |

The broader dated evidence set is in the companion onboarding, provider, local-inference, storage,
catalog, native, and legacy audit documents. Implementation inference is distinguished from measured
native behavior throughout the acceptance ledger.

## Current visual iteration evidence

Baseline: `E:\temp\cupcake-overhaul-20260905\baseline\01-home*.png` (native, opened close-ups and
full frame). Initial revised renderer: `E:\temp\cupcake-overhaul-20260905\studio\light-*.png` and
`narrow-home.png` (fixtures, opened). Review found backward action arrows and hidden narrow route
details; both were corrected before final acceptance. Final packaged images and exact executable
identity belong in the final worklog, not this design rationale.
