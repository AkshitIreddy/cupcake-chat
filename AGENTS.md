# Working on Cupcake Chat

- Keep all project-owned generated files inside this checkout. Use `scripts/lib/workspace.mjs` and
  its fixed `out/` paths; do not create dated/versioned working folders on E: or elsewhere.
- Reuse build caches and download caches. Replace the current QA/demo output instead of making
  `final`, `final2`, timestamped, or copied build trees. Keep finished public media in
  `docs/media/`.
- Use a workspace job lock before resetting shared output. Remove temporary recording frames and
  staging directories in `finally`; preserve the last complete build during atomic promotion.
- Reuse `pnpm clean:generated` for disposable output. Development profiles are opt-in cleanup with
  `pnpm clean:profiles`; do not apply developer cleanup to installed-app data or credentials.
- Keep Windows commands and helper processes hidden and UI automation headless.
- Honor the shared `../gpu use.txt` lock before GPU work. Preserve unrelated Git changes and use
  focused local commits on `master`. Push or publish only when the user has authorized it.
