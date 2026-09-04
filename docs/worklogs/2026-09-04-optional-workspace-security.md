# 2026-09-04 optional workspace security

## Product decision

Normal CupcakeAI startup is frictionless. A fresh or ordinary profile opens directly without a
password, a security choice, or a lock setup page. Workspace password protection is an explicit
opt-in under Settings > Privacy.

The optional workspace lock is separate from background credential hygiene. Provider API keys
continue to use the Windows credential vault and are never stored as readable text; this safeguard
does not add a prompt or startup step.

## Implementation

- An absent workspace-lock record now means `unlocked`, not `needs_setup`.
- Legacy version 2 passwordless quick-open records are removed on load and migrate to the normal
  Off state.
- Empty setup remains a compatibility no-op for older renderer/host pairings and writes no lock
  record.
- A password created from Privacy settings writes the Argon2id lock record and becomes required on
  subsequent launches.
- The authenticated disable command removes the lock record and returns the profile to direct
  opening.
- `Lock now` stops the runtime only when protection is actually enabled.
- First-run profile customization remains in onboarding instead of being coupled to security.

## Verification

- Red-capable Playwright regression reproduced the old forced setup behavior before implementation.
- The final lifecycle passed at desktop and narrow widths: direct fresh-profile opening, Off by
  default, explicit enable, On state, authenticated disable, and return to Off.
- Full Playwright suite: 44/44.
- Renderer Vitest: 52/52.
- Rust desktop host: 27/27.
- TypeScript and ESLint passed.
- Visual evidence inspected at desktop and 390 px widths:
  - `E:\temp\cupcake-security-desktop-home.png`
  - `E:\temp\cupcake-security-desktop-settings.png`
  - `E:\temp\cupcake-security-desktop-detail.png`
  - `E:\temp\cupcake-security-narrow-home.png`
  - `E:\temp\cupcake-security-narrow-settings.png`
  - `E:\temp\cupcake-security-narrow-detail.png`

Native packaged acceptance passed against two hidden profiles. A fresh profile at
`E:\temp\cupcakeai-default-open-20260904` reached Home with `unlockMode: null` and created no
workspace-lock record. The owner profile at `E:\temp\cupcakeai-owner-test-20260902` migrated its
legacy `WindowsDPAPI` record to no record, retained its existing chats/projects, and also reported
`unlockMode: null`. Both runs reached a ready broker runtime with no visible or browser errors.
Evidence is under `E:\temp\cupcakeai-default-open-native-20260904` and
`E:\temp\cupcakeai-owner-optional-security-20260904`.

No GPU work was performed. The shared marker changed from `no` to `yes` during this CPU/UI task,
indicating another task acquired it; this task did not modify that ownership marker.
