# Known issues and unfinished gates

CupcakeAI 2.0 is undergoing a corrective Tauri overhaul. The source tree is not an accepted release
candidate and no new artifact should be distributed.

## Current blockers

- The Tauri host, target-triple sidecars, verified resources, executable, and unsigned NSIS bundle
  pass local integrity smoke. Clean-machine Windows installation and lifecycle coverage remain open.
- The owner test profile contains real Groq, Cohere, NVIDIA NIM, and local CUDA multi-turn demos.
  The final package must reopen them and verify the completed group-conversation implementation.
  Google returned provider-unavailable; Mistral returned rate-limit. Cloudflare's first trial hit a
  local output limit; its token-field repair has not been retried against the service. OpenRouter's
  short trial was incomplete. Failed trials remain archived and are not successful demos.
- App-managed Qwen3 8B CUDA load, chat, streaming, interruption, follow-up recovery, graceful fit
  refusal, benchmark, and unload passed on provisional package `BF706D1F`. Final package restart
  persistence and the corrected stopped-message UI remain open. A short benchmark measured
  64.76 generated tokens/second; it is not a general throughput guarantee.
- The actual frozen AppContainer worker succeeds after `294437e`. Full packaged saved-artifact
  execution, test failures, exact cancellation, and source-privacy evidence remain open. Model
  generated Python drafts have known test defects; no passing execution is claimed for those drafts.
- Configurable Cupcake group conversations and bounded semantic speaker selection are newly
  authorized work in progress. They are not available in the provisional package.
- The full titlebar, scrollbar, theme, width, DPI, zoom, high-contrast, keyboard, screen-reader, and
  reduced-motion matrix is not yet accepted.
- Startup-to-interactive was observed in disposable packaged profiles, but a repeatable final
  startup distribution, steady-state working set, and local tokens/second are not all reported yet.
- Windows 10/11 clean-machine install, two-version upgrade, uninstall, and data-retention behavior
  remain unverified for the new NSIS installer.
- Owner acceptance is outstanding.

## Deliberate boundaries

- Windows 10/11 x64 only.
- Local single-user application; no Cupcake account or sync.
- No voice or implicit provider fallback. Group speaker selection may choose only explicitly
  configured members and disclosed routes within the confirmed turn budget.
- No model weights in the installer.
- No production signing or updater.
- Backup recovery is tied to the same Windows user and computer. It prepares an isolated recovery
  profile; it does not switch the active workspace. Content encryption can be disabled, while
  provider credentials remain protected by Windows DPAPI.
- External vLLM, if retained after review, is a remote/user-managed endpoint and never an installed
  local manager.

## Release blockers

Block handoff for renderer access to raw native primitives, plaintext or leaked secrets, project
scope leaks, undisclosed Local/Cloud or cost changes, approval mismatch/replay, duplicate recovery
effects, sandbox escape, unapproved repository writes, unsafe migration, corrupt backup acceptance,
unusable required layouts/accessibility states, fixture data presented as live, generic provider
credential UI, an empty fresh model catalog, titlebar overlap, native-looking scrollbars, or a
package that cannot launch its verified runtime and broker.

## Reporting

Include commit, Windows build, WebView2 version, app/package type, disposable profile, reproduction,
expected/actual behavior, redacted event identifiers, and opened screenshots. Never attach API keys,
tokens, environment dumps, private content, raw databases, or unreviewed diagnostics.
