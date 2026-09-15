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

If this checkout still has old E: junctions, run `Consolidate Cupcake Chat.bat` once. It copies and
verifies the project directories before removing their old locations. It does not rename this
checkout or move release credentials.
