# Known issues and unfinished gates

CupcakeAI 2.0 is a local owner-test candidate. Owner acceptance and distribution approval remain
outstanding; nothing has been pushed or published.

## September 8 owner revision

The compact chat header, wider readable responses, consistent Task/Memory scene surfaces, and final
four wallpaper selections are corrected. The owner test profile also contains three additional
everyday projects with four real conversations and saved final plans, including a Groq/Cohere group
and an app-managed local CUDA conversation. See
`docs/worklogs/2026-09-08-reading-and-everyday-showcase.md` and the September 8 package audit for
the exact current build and evidence; package hashes below are retained historical observations.

Actual sample conversations still expose model limitations. The operator narrowed overcomplicated
plans and challenged bad first drafts; failed/truncated setup trials are archived. Stronger model
selection did not guarantee instruction compliance. The final Qwen card still includes an emoji and
imperfect tab-saving advice, and the photo card's “15-minute” heading excludes its return trip. The
model responses remain unchanged and are not represented as actions performed or perfect advice.

Final `c0e08ac` also fixes project memories disappearing from the UI after save/undo; the exact
restored record survived process restart. First opening of the new executable took 28.4 seconds,
while reopening took 5.1 seconds. The first-opening delay's cause is not established. An optional
startup `developer.events` request still returns `INVALID_ARGUMENT` because it omits the required
run ID; historical diagnostics hydration is not verified. This caught request does not block the
verified Home/chat/artifact/Memory flows. See the September 8 ledger for the exact receipts.

## Qualification status and remaining limits

- The Tauri host, target-triple sidecars, verified resources, executable, and unsigned NSIS bundle
  pass local integrity smoke. Local NSIS installation, first run, product uninstall, registration
  removal, and exact retained-project reopening passed again on final `89882fa`, entirely headless.
  On September 7 the owner explicitly limited acceptance to this Windows installation and declined
  VM testing. Cross-machine and two-version upgrade qualification are outside this owner test scope.
- The owner test profile contains real Groq, Cohere, NVIDIA NIM, and local CUDA multi-turn demos.
  They reopened on final `89882fa`, including durable artifact test evidence, two completed local
  replies, and the real group demonstration. This package includes scene-colored controls and
  compact quiet-turn status, alongside the earlier dialogs, archived-recents, scrollbars, startup,
  and live local-readiness corrections. Google returned provider-unavailable; Mistral returned
  rate-limit. Cloudflare's first trial hit a local output limit; its token-field repair has not been
  retried against the service. OpenRouter's short trial was incomplete. Failed trials remain
  archived and are not successful demos.
- App-managed Qwen3 8B CUDA load, streaming interruption, fresh follow-up, direct offline group
  response, and unload passed again on `626f890`; an earlier actual restart preserved the original
  local conversation. Earlier fit refusal and a 64.76-token/second short benchmark are separately
  recorded. The first `1a7e2d7` load was safely refused for insufficient available RAM after
  reserves; it launched no model. The subsequent safe load succeeded without reducing reserves.
  Post-unload group readiness previously retained a cached loaded flag. The corrected `7583199`
  package passed exact-model ready/preflight, one real Offline Juniper response, unload, and
  non-sendable `local_not_loaded` preflight. Pause/Resume after unload passed without loading
  weights or changing history. The benchmark is not a general throughput guarantee.
- The actual frozen AppContainer worker succeeds after `294437e`. The owner profile's Guarded
  saved-artifact flow passes with runtime `4ad18e1`: the original Groq draft ran eight tests with
  one error, and a clearly manual coding-agent review revision passed ten tests. Cancellation and
  source privacy passed on a disposable provisional package. The reviewed artifact passed ten tests
  again on `1a7e2d7`, with an inspected Local Python sandbox result and durable task provenance. The
  original model drafts are not claimed to pass.
- Configurable Cupcake group conversations passed real packaged two-provider Smart selection, direct
  addressing, and a quiet closing turn. The first successful routing trial contained an invented
  critic section inside the planner's response. Strengthened single-speaker guidance passed the
  rebuilt live retake. That draft still needed an operator review of timing and data handling; its
  real revision follows the preserved draft. Model compliance and Smart selection remain fallible.
  Structured mentions and Mentions only provide explicit control, and Stop ends the bounded turn.
  Group chats do not run tools.
- Native group dialogs, scrollbars, message actions, and fresh Models have inspected wide/narrow
  renders. Forced colors, reduced motion, and larger effective layouts have browser-emulated
  evidence. Native zoom shortcuts now work and bounded 200–400% layout evidence exists. The owner
  explicitly stopped further zoom testing and required all subsequent UI work to remain headless; no
  additional zoom or foreground-window test is an owner acceptance gate. OS-wide DPI changes,
  audible Narrator/NVDA streaming, and final visible tray hide/show remain unqualified.
- Owner startup on `626f890` took 29.8 seconds. A direct differential traced about 12.6 seconds of
  runtime startup to rehashing completed local-model downloads. `ae7f0bc` defers that metadata
  recovery work while retaining checksum validation at registration, installation, and execution.
  The final `7583199` package reaches owner Home in 3.8–3.9 seconds with its existing WebView
  directory. An initial post-build launch with a new WebView took 21.6 seconds; a second new-WebView
  differential reached Home in 3.6 seconds. The first outlier remains unexplained and is not omitted
  from the timing record. No model weights are loaded just to open history.
- Final `89882fa` headless owner restart reached Home in 3.649 seconds with no browser errors. Its
  eleven-process tree exited completely; the close audit observed 2.100 seconds including helper
  attachment overhead. All four showcase projects reopened and no model was loaded.
- The optional Developer inspector shows live events from the current renderer session. Its
  redundant startup history request lacks the run identifier required by the backend and is rejected
  with `INVALID_ARGUMENT`; the handled error does not affect startup or product work. Prior-run
  diagnostic browsing is not implemented. Existing per-run records remain available through the
  runtime contract, and the live subscription continues to work.
- Owner acceptance is outstanding.
- The obsolete pytest archive was moved and verified earlier, but the final read-only check found
  `E:\uesless` empty. Its move/verification receipts remain unchanged; the payload is no longer
  available to the restore script. This task did not remove it after verification. Current product,
  profile, model, and acceptance evidence paths are intact.

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
- Compatible external servers use an explicitly configured remote endpoint. The app does not install
  or administer vLLM; Cupcake Local owns the managed local runtime.

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
