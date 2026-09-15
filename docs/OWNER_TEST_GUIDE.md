# Local Cupcake Chat workspace

Development files live inside this checkout. The installed application's data stays in its normal
Windows application-data location and is separate from developer cleanup.

- Development profile: `out/profiles/test/` (opened by `Launch Cupcake Chat Test.vbs`).
- Optional recording profile: `out/profiles/demo/` (opened by `Launch Cupcake Chat Demo.vbs`).
- Native executable: `apps/desktop/src-tauri/target/release/CupcakeAI.exe`.
- Current installer: `apps/desktop/src-tauri/target/release/bundle/nsis/`.
- Current recording and evidence: `out/demo/replay/`.
- Review MP4: `out/demo/cupcake-chat-review.mp4`.
- Published README animation and banner: `docs/media/`.

The previous local demo chats and test profiles were cleared at the owner's request. Launchers
create fresh profiles; they do not restore examples or provider keys. Prepare real conversations and
update the recorder's saved IDs before filming a new tour. See [the storyboard](demo-storyboard.md).

Use `pnpm clean:preview` to inspect the cleanup scope, `pnpm clean:generated` to remove disposable
QA/recording/packaging output, or `pnpm clean:profiles` to also reset development profiles after
closing the app. Build caches, source, published media, and installed-app data are retained.

The checkout now uses local directories. Old migration/archive launchers have been removed. Rust
target directories are disposable compiler caches; removing them saves disk space at the cost of a
fresh compile on the next build. Keep the source, artwork and clean sidecar inputs.
