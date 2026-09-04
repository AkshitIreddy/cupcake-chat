# 2026-09-04 workspace wallpaper and direct-open acceptance

## Scope

- [x] Apply the selected wallpaper image and adaptive palette to every workbench route.
- [x] Keep the artwork visible while giving text, controls, cards, and desktop chrome readable glass
      surfaces.
- [x] Preserve the existing no-wallpaper theme when Quiet paper is selected.
- [x] Keep the app password optional and expose a control that returns protected profiles to direct
      opening.
- [x] Keep encrypted local storage and Windows-vaulted credentials automatic and independent of the
      optional password prompt.
- [x] Pass full renderer, host, and packaged Windows verification.

## Visual acceptance

The desktop and narrow browser compositions were inspected from fresh renders. Home, Models,
Settings, Artifacts, and Search all retain the selected Blueberry observatory scene while their
headers and working surfaces adapt to its palette. The route-level regression also covers Chats,
Projects, Tasks, Memory, Tools, About, and Chat.

Temporary visual evidence is stored outside the repository at
`E:\temp\cupcake-wallpaper-qa-20260904`.

## Security acceptance

The app still opens directly for an ordinary profile. Settings → Privacy can add a password prompt,
change it, lock immediately, or remove the prompt after authenticating. Removing the prompt does not
decrypt the user's files or provider keys; those safeguards remain automatic and add no startup
step. The owner test profile at `E:\temp\cupcakeai-owner-test-20260902` has no workspace-lock record
and therefore starts in direct-open mode.

## Verification

- TypeScript, ESLint, and all 126 Vitest tests passed.
- All 27 Rust desktop-host tests passed with Cargo output redirected to `E:\temp`.
- All 48 Playwright flows passed across the 1440 x 900 and 390 x 844 projects.
- The release-mode Windows executable built successfully at
  `apps\desktop\src-tauri\target\release\CupcakeAI.exe`; the target directory is a junction to
  `E:\temp\cupcakeagi-tauri-target`.
- A hidden native startup smoke test used a fresh direct-open profile at
  `E:\temp\cupcakeai-direct-open-smoke-20260904-v2`. The desktop host remained responsive, started
  its broker and runtime children, and created no workspace-lock record.
- SHA-256: `E41D23C143A36FBA76D75187F39755CC4486D61F80802ABA57B569BCF9960896`.
