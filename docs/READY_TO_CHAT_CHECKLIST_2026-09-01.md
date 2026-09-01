# CupcakeAI ready-to-chat test-app checklist - 2026-09-01

The normal packaged app profile, not a fixture or disposable acceptance profile, is the target.

- [x] Replace the Windows-session-only gate with CupcakeAI-owned password creation and unlock.
- [x] Require password confirmation, support lock/restart unlock, and provide a password-change path.
- [x] Keep password material out of logs, screenshots, renderer persistence, Git, and provider data.
- [x] Detect the exact normal Windows application-data profile used by `CupcakeAI.exe`.
- [x] Import authorized API credentials from `Commonly used Keys.txt` without printing them.
- [x] Test every recognized text-model credential and preserve only working provider connections.
- [x] Install and verify CPU, Vulkan, CUDA 12, and CUDA 13 Cupcake Local runtime packs.
- [x] Keep CUDA 13 active on this NVIDIA device while retaining other packs as ready fallbacks.
- [x] Install at least one recommended local model and leave it loaded/default for immediate chat.
- [x] Expand the signed local-model catalog with a broad, useful Hugging Face GGUF selection.
- [x] Show accurate device fit, license, size, capabilities, context, source, and quantization data.
- [x] Run a real hosted chat and a real local chat through the packaged frozen broker/runtime against
      the normal Windows profile.
- [x] Prove app-owned password setup, lock, wrong-password rejection, re-unlock, and restart unlock in
      the hidden packaged app with a disposable profile.
- [x] Inspect screenshots of password setup, immediate lock, and restart lock.
- [ ] Let the owner choose the normal profile password, then capture the resulting Models, Providers,
      and successful-chat screens without storing that password in an automation artifact.
- [x] Restore `gpu use.txt` to `no`, stop task-owned processes, commit locally on `master`, and update
      the handoff.

## Evidence

- Normal-profile readiness: `artifacts/runtime/ready-profile-full-20260901.json`.
- Password lifecycle: `artifacts/screenshots/ready-to-chat-20260901/password-acceptance.json`.
- Inspected packaged screenshots: `artifacts/screenshots/ready-to-chat-20260901/`.
- The normal profile intentionally has no password verifier yet. First launch asks the owner to create
  it; providers, runtimes, the model store, and the selected local default are already configured.
