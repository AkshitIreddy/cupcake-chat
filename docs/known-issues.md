# Known issues and unfinished gates

CupcakeAI 2.0 is undergoing a corrective Tauri overhaul. The source tree is not an accepted release
candidate and no new artifact should be distributed.

## Current blockers

- The Tauri host, target-triple sidecars, verified resources, executable, and unsigned NSIS bundle
  pass local integrity smoke. Clean-machine Windows installation and lifecycle coverage remain open.
- Fresh packaged in-app NVIDIA NIM and Cohere conversations passed with disposable profiles and the
  credentials were removed. The broader provider error/cancellation matrix is not fully accepted.
- No app-managed Cupcake Local model has completed the required packaged download/load/chat/restart
  flow or benchmark.
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
- No voice or automatic model routing.
- No model weights in the installer.
- No production signing or updater.
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
