# Packaged Windows workbench audit and startup research

**Date:** 2026-09-05  
**Scope:** Existing packaged CupcakeAI candidate, owner test profile, Tauri/WebView2 lifecycle,
packaged runtime startup, and major-screen visual baseline.  
**Evidence type:** Direct observation unless a paragraph is explicitly labeled **Inference** or
**Recommendation**.

## Candidate and method

The audited executable was:

- `apps/desktop/src-tauri/target/release/CupcakeAI.exe`
- SHA-256: `E41D23C143A36FBA76D75187F39755CC4486D61F80802ABA57B569BCF9960896`
- owner profile: `E:\temp\cupcakeai-owner-test-20260902`
- WebView2: `152.0.4191.62`
- viewport set: 1440 x 920 and 390 x 844

The audit launched the real packaged executable with hidden child windows and a private WebView2
data directory, attached through its enabled CDP port, navigated by accessible roles, and closed
through the app's own close button. The reusable command was:

```powershell
node .\scripts\audit-packaged-workbench.mjs --profile 'E:\temp\cupcakeai-owner-test-20260902' --output 'E:\temp\cupcake-overhaul-20260905\baseline' --webview-data 'E:\temp\cupcake-overhaul-20260905\baseline-webview2-r3' --port 10107
```

The structured result is `E:\temp\cupcake-overhaul-20260905\baseline\audit.json`. It recorded no
browser errors and no horizontal document overflow at 390 x 844. `99-failure.png` is a retained
diagnostic from an earlier incomplete pass and is excluded from the completed audit result.

Before staging a replacement, the audited executable, release sidecars, resource-sidecar tree,
target-triple external binaries, and hidden launcher were copied to
`E:\temp\cupcake-overhaul-20260905\rollback-baseline-e41d23c1`. Its `rollback-manifest.json`
contains per-file byte lengths and SHA-256 digests for 22 source files totaling 270,980,903 bytes.

The harness did not send provider requests, start local inference, read credentials, or change
product records. It only navigated, opened reversible view state, replayed then skipped onboarding,
and closed the process it started. The owner profile's connected-provider labels were visible, but
no credential values were exposed.

## Lifecycle measurements

| Measurement                            |             Observed result |
| -------------------------------------- | --------------------------: |
| Process start to DevTools availability |                      642 ms |
| Process start to usable Home           |                   20,890 ms |
| Native close result                    |                     success |
| Native close latency                   |                      153 ms |
| Browser console/page errors            |                           0 |
| Narrow document width                  | 390 px in a 390 px viewport |

At Home readiness, the process tree contained the Tauri executable, one broker, the PyInstaller
runtime bootloader plus its child, two hidden console hosts, and the expected WebView2 browser,
renderer, GPU, and utility processes. All owned app processes were absent after close.

The 642 ms CDP attachment and visible loading surface show that WebView2 creation was not the main
20.9-second blocker in this run. The loading surface remained on “Bringing your history into view”
while the private runtime became ready.

Microsoft documents that WebView2 uses Edge's multi-process model, so the observed browser,
renderer, GPU, and utility process group is expected rather than evidence of leaked windows.
Microsoft also recommends the Evergreen Runtime, a fast local user-data folder, a light initial
payload, deferred heavy components, minimal host/web communication, and testing the actual content
on target hardware. See
[WebView2 performance best practices](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance),
[the WebView2 process FAQ](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/end-user-faq),
and
[WebView2 Runtime distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution).

Tauri exposes close requests as an interceptable lifecycle event and force-destroy as a separate
operation. The candidate's prompt close result is consistent with its selected Exit preference.
Close-to-tray still needs final packaged testing after the source overhaul because it is a different
preference path. See
[Tauri window close behavior](https://v2.tauri.app/reference/javascript/api/namespacewindow/) and
[Tauri `WindowEvent`](https://docs.rs/tauri/latest/tauri/enum.WindowEvent.html).

## Startup diagnosis

Three isolated protocol probes separated broker, frozen-runtime, and application work:

| Probe                                      |                                 Handshake / ready | First health response | Process lifetime including shutdown |
| ------------------------------------------ | ------------------------------------------------: | --------------------: | ----------------------------------: |
| Existing packaged broker to frozen runtime | 1,329 ms broker handshake; 9,392 ms runtime ready |     included in ready |                        about 21.7 s |
| Frozen runtime, plaintext fresh profile    |                                          9,107 ms |                 13 ms |          not used for UI acceptance |
| Source runtime, plaintext fresh profile    |                                          5,628 ms |                 17 ms |          not used for UI acceptance |
| Frozen runtime, encrypted fresh profile    |                                          6,568 ms |                  9 ms |          not used for UI acceptance |
| Source runtime, encrypted fresh profile    |                                          4,852 ms |                 12 ms |          not used for UI acceptance |

Results varied between cold runs, but the same conclusion held: once the runtime handshake
completed, `runtime.health` took only 9–17 ms. Most delay occurred before request handling. Frozen
one-file startup added roughly 1.7–3.5 seconds over source startup in these samples, while broad
Python imports, interpreter/process setup, and frozen metadata bootstrap still accounted for much of
the remaining wait.

An import-time trace saved at `E:\temp\cupcake-overhaul-20260905\importtime.txt` measured about 2.58
seconds cumulative for `cupcake_runtime.desktop_protocol` under Python's import tracer. Within the
project imports, the largest groups were local models, artifacts, providers, agents, backup,
ingestion, tools, and retrieval. This trace is diagnostic attribution, not a production startup
benchmark; antivirus, disk cache, process creation, and service construction explain why wall-clock
startup was higher.

A later source profile isolated `RuntimeService` construction at 0.140 seconds, dominated by SQLite
setup. A fresh import trace measured 1.87 seconds and warmed fresh-process repetitions measured
1.50–1.52 seconds, with material cache variance. The source optimization therefore stayed narrow:
diagnostic package-version lookup is deferred until queried, and the six DBOS compatibility exports
remain public but load `tasks.dbos_runtime` only on first access. This avoids pretending that a
0.14-second constructor redesign would solve a multi-second frozen startup.

The existing PyInstaller build used one-file mode. PyInstaller's own documentation says a one-file
program creates a random `_MEI...` directory, uncompresses support files there before Python starts,
and is slower to start than a one-folder bundle. See
[PyInstaller operating modes](https://pyinstaller.org/en/stable/operating-mode.html).

The packaging change therefore uses a one-folder runtime and places its `_internal` directory next
to `cupcake-runtime.exe`. The generated sidecar manifest records every support file's relative path,
size, and SHA-256 digest. The Rust host rejects missing, changed, undeclared, linked, or out-of-root
support entries before launch. The package smoke performs the same exact-set and digest validation
against the staged Tauri resources.

This layout follows Tauri's documented bundle model: `externalBin` supplies target-triple-specific
executables, while `bundle.resources` preserves directory trees in the application resource area.
See [Tauri external binary configuration](https://v2.tauri.app/reference/config/#bundleconfig) and
[Tauri embedded resources](https://v2.tauri.app/develop/resources/).

**Inference:** One-folder packaging should remove repeated archive extraction and materially shorten
the frozen-runtime portion of cold startup. It cannot remove Python import and constructor cost. The
fresh rebuilt executable must be measured before assigning a final improvement number.

### Pre-final one-folder evidence

The first exact-source one-folder candidate was intentionally treated as provisional after later
packaged-route and sandbox findings. It nevertheless isolated useful startup stages:

| Probe                                                                     |           Result |
| ------------------------------------------------------------------------- | ---------------: |
| Broker handshake to one-file runtime health, previous package             |         9,392 ms |
| Broker handshake to one-folder runtime health, same measurement harness   |         4,527 ms |
| One-folder improvement in that isolated cold probe                        | 4,865 ms / 51.8% |
| Fresh-profile one-folder `app.bootstrap`, after candidate files were warm |         4,535 ms |
| Immediate repeated `app.bootstrap` calls                                  |    17 ms / 17 ms |
| Fresh copied sidecar tree and profile, first `app.bootstrap`              |         7,823 ms |
| Immediate repeated calls against the copied tree                          |    30 ms / 31 ms |

The provisional desktop executable exposed CDP in 949 ms, but its first owner-profile Home frame
took 39,750 ms. That one run did not reproduce on a fresh disposable app profile: an independent
security harness reached Settings, including CDP attachment, readiness, onboarding dismissal,
seeding, disk inspection, and navigation, within 12,396 ms; its restart completed the corresponding
work within 11,644 ms. These are upper bounds rather than exact Home timings.

A warm-cache reimplementation of the Rust manifest checks measured 149 ms for the two executables,
1,671 ms for 820 support-file metadata/canonical-path/digest checks, 30 ms for the exact tree walk,
and 165 ms for the 18.1 MB Cupcake Local archive. Together with process creation timestamps from a
later app run, this rules out a persistent 39-second WebView or host-manifest cost. The first owner
result is consistent with non-repeatable first-touch scanning or a transient failed/retried runtime
start, but the retained evidence cannot distinguish those causes. The final package therefore needs
both a pristine-path first launch and a warm restart before the startup gate can be closed.

That owner screenshot also exposed a separate readiness bug: Home painted the default paper scene
and fixture display name, then applied saved settings only after the auxiliary FIFO batch completed.
The source fix now performs the small local settings read immediately after bootstrap, applies saved
appearance, identity, accessibility, onboarding, and offline privacy state before `ready`, and keeps
later auxiliary completion from overwriting user changes made after Home appears.

### Provisional native-execution qualification

The sandbox and durable-task acceptance below used an exact Python runtime snapshot at commit
`4ad18e1`, the already-qualified broker from commit `294437e`, and the pre-final Tauri renderer. It
is retained as behavioral evidence rather than final-package qualification because later renderer,
runtime, contract, and group-conversation work requires a complete rebuild.

| Component                 | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Frozen one-folder runtime | `B1091C05044FD466E885E584419D475528B3B5A157D15B65D51A0DFDB7C454CD` |
| Native tool broker        | `A6E7D7B172E03491EFC7B3FD57F0E9D2EDA55BF6CB5FD649C1855792C428894F` |
| Exact sidecar manifest    | `4B70147ECDD34BB9879104FC3FE1AB9BDDC8CACF3CFB810E68A6B92FB0CF608D` |

The runtime's package-time provider probe constructed the OpenAI, Anthropic, Google, xAI, Mistral,
and Cohere clients and their request models without making network calls. A direct packaged
AppContainer run completed an authenticated Python worker request, printed
`CUPCAKE_PACKAGED_SANDBOX_OK`, returned the value `42`, and left no process or AppContainer-profile
residue. A live infinite worker accepted cancellation and reached `Cancelled` with the same clean
teardown.

The full desktop-host retake in Guarded mode exercised exact approval identity, two successful test
runs, one deliberate failure, and one accepted cancellation. A restart restored all three durable
task rows. Source-sentinel scans, private continuation files, sandbox stages, AppContainer profiles,
browser errors, and remaining CupcakeAI/runtime/broker/llama processes were all zero. The retained
receipts are under
`E:\temp\cupcake-security-native-20260905-provisional-green\final-task-4ad18e1-guarded-r1\evidence`.

Visual inspection of `02-restarted-real-task-outcomes.png` found an additional pre-final renderer
defect: the failed and cancelled rows both appeared as neutral 0% / 0-of-1-step cards with no
visible state label, while the summary exposed only working, waiting, completed, and total counts.
The final renderer must distinguish those outcomes and be recaptured after the aggregate rebuild.

### Request-queue finding

The desktop host already tracks renderer requests by correlation ID, but the broker's main loop
proxies one runtime request synchronously. While a runtime request is active it reads new desktop
frames only to forward cancellation and stores other requests in a FIFO queue. The runtime child
owns one mutable input reader and expects the active correlation. As a result, renderer-side
`Promise.all` calls do not create useful runtime concurrency in the packaged path; a slow request
can delay later local-store reads.

The renderer's startup refresh historically enqueued tasks, memory, provider status, settings,
permission policy, migration, and local-model status together. A click into a saved conversation
could land behind this auxiliary work. During the audit, selecting a recent conversation and then
navigating elsewhere allowed a late conversation response to pull the UI back into that chat. This
was reported immediately and the navigation generation guard was repaired in the source overhaul.

**Recommendation:** Show the local navigation shell and saved conversation index as soon as the
minimal bootstrap returns. Load tasks, memory, provider catalogs, migration discovery, hardware, and
local-model state on their owning screens or in bounded idle work. Do not present `Promise.all` as
parallelism across the current single runtime pipe. A future broker multiplexing design would
require a dedicated runtime writer, a continuously demultiplexing reader, per-correlation channels,
and explicit rules for state-changing requests; it should not be improvised during visual polish.

The host also started the supervisor eagerly for every unlocked profile during Tauri setup. If the
runtime request path is changed to start the supervisor safely on first product read, the loading
copy and retry behavior must be tested for unlocked, password-locked, failed-handshake, and restart
states. Merely deleting the eager start would make the current request path return
`RUNTIME_NOT_READY`.

## Screen inventory

All screenshots below are from the unchanged baseline executable and live owner profile. Every full
image also has `--masthead`, `--upper`, `--middle`, and `--lower` close-ups. Dialog captures add a
`--dialog` crop.

| Surface             | Baseline screenshot                                                  | Observation                                                                                                                                |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Startup             | `00-startup-opening.png`                                             | Cohesive art, but the truthful-sounding history copy masked a 20.9 s runtime wait.                                                         |
| Home                | `01-home.png`                                                        | Strong personalized composition; sparse showcase and appearance changed after late hydration.                                              |
| Chats               | `02-chats.png`                                                       | Five shallow rows, generic previews, little route/model context, tiny bare row actions, duplicate new-chat affordances.                    |
| Active chat         | `03-active-chat.png`                                                 | Selected conversation was empty and did not demonstrate persisted capability.                                                              |
| Projects            | `04-projects.png`                                                    | One project left a large blank workspace.                                                                                                  |
| Tasks               | `05-tasks.png`                                                       | Empty state; no task detail existed to inspect.                                                                                            |
| Artifacts           | `07-artifacts.png`                                                   | Empty state dominated the surface; create flow used a native-looking prompt.                                                               |
| Memory              | `09-memory.png`                                                      | Empty state and native-looking create prompt; no owner-relevant memory example.                                                            |
| Models initial      | `10-models-initial.png`                                              | “Refreshing” appeared with zero matches, contradicting the model shown on Home.                                                            |
| Models settled      | `10-models-stable.png`                                               | Sixteen cards appeared but the page still read as refreshing.                                                                              |
| Model picker        | `12-model-picker.png`                                                | Initially reported no models despite the selected Home model; weak trust signal.                                                           |
| Tools               | `14-tools.png`                                                       | Dense card stack; network classification exposed confusing CLOUD/NATIVE combinations, and Full Freedom copy conflicted with “always asks.” |
| Search              | `15-search.png`                                                      | Empty copper panel had very poor text contrast.                                                                                            |
| Command palette     | `16-command-palette.png`                                             | Useful structure, but visual weight and keyboard behavior needed overhaul verification.                                                    |
| Settings            | `17-settings-personality.png`, `18-settings-*.png`                   | Rich coverage but deep nested navigation, large panels, late theme hydration, and browser-like scrollbar.                                  |
| Provider setup      | `19-provider-dialog-openai.png`                                      | In-app modal existed and preserved credential privacy; hierarchy and state language needed refinement.                                     |
| Onboarding          | `20-onboarding-step-1.png` through `20-onboarding-step-8.png`        | Replayable eight-step tour existed, but several steps were passive or visibly broken.                                                      |
| About               | `22-about.png`                                                       | Best-developed hero surface; product/release hierarchy still competed with the content.                                                    |
| Architecture dialog | `23-about-architecture-dialog.png`                                   | Clean compact modal; useful evidence that an app-owned dialog pattern works.                                                               |
| Narrow Models       | `30-models-narrow.png`                                               | Initial viewport showed title and task filters but no actual recommendation.                                                               |
| Narrow picker       | `31-model-picker-narrow.png`                                         | Fit the viewport, but inherited the empty/transient catalog state.                                                                         |
| Narrow onboarding   | `32-onboarding-step-1-narrow.png`, `33-onboarding-step-2-narrow.png` | Card began at x=28 with width 374.4 in a 390 px viewport, clipping about 12.4 px on the right.                                             |
| Mobile navigation   | `34-mobile-navigation.png`                                           | No document overflow; profile label collapsed into `AkshitLocal profile` without useful spacing.                                           |

Conditional screens absent from this owner state were recorded rather than fabricated:

- no task-detail screenshot because the profile had zero tasks;
- no artifact revision screenshot because the profile had zero artifacts;
- no model-install dialog because no install action was available in the observed initial viewport;
- no Developer screenshot because the owner profile's Developer setting was disabled.

## Highest-priority visual and functional defects

1. **Startup blocks on work the loading message does not describe.** WebView2 was attachable in 642
   ms, while Home took 20.9 seconds. The packaged one-file runtime and eager/serial support work
   were the main measured causes.
2. **The owner app did not demonstrate the workbench.** The profile held only five shallow chats,
   one project, and no tasks, artifacts, or memory. The central product surfaces therefore read as
   placeholders even when their empty-state copy was polished.
3. **Async navigation could override a newer user choice.** A delayed conversation request pulled
   the screen back after the user navigated away. The source overhaul added a navigation epoch
   guard; the new executable still needs packaged regression testing.
4. **Model availability contradicted itself.** Home showed a selected model while Models and the
   picker transiently showed zero usable routes. Narrow Models spent the entire first viewport on
   filters rather than results.
5. **Onboarding broke at real sizes.** Step 5 measured about 968 px high in a 920 px viewport and
   clipped above and below. Steps 3–4 allowed distracting underlying content through. The narrow
   card overflowed right, and step 2's light input nearly disappeared.
6. **Wallpaper hydration visibly changed the app after first paint.** The shell appeared in one
   appearance and then switched to the saved Copper wallpaper, weakening perceived stability.
7. **Several controls looked native or unexplained.** Artifact and memory creation used prompt-style
   interactions. Tiny chat row icons lacked a clear context/action treatment. Tools used technical
   route badges whose combinations did not match the product explanation.
8. **Accessibility contrast and scroll treatment were inconsistent.** Search's empty state was hard
   to read, and the thick default scrollbar fought the custom visual system.

## Acceptance gates for the rebuilt candidate

### Final packaged candidate

The final local candidate combines the production runtime and broker frozen at `5cb86fd` with the
defensive renderer boundary fix at `739f524`. The latter changed only `workspace.tsx`, so the
previously built runtime and broker remain exact for the aggregate production source.

| Artifact                               |      Bytes | SHA-256                                                            |
| -------------------------------------- | ---------: | ------------------------------------------------------------------ |
| `CupcakeAI.exe`                        | 12,777,472 | `E6EA405033BE5AE0746D6A603E919F3E02C99BFB6AC53495A410CD9AFC613CDA` |
| `CupcakeAI 2_2.0.0-rc.1_x64-setup.exe` | 82,447,264 | `C2372C9C6243F4618E6E21DDD86F3725EC72D458CEEA3043712760EF3569108A` |
| `cupcake-runtime.exe`                  | 28,666,511 | `71BB0C6000D5161FAB071F7298E1EAB902101744A9C247B8F91C97D93E88D407` |
| `cupcake-tool-broker.exe`              | 10,746,880 | `083E78A27AA6D73AC505290D79BFB017B5CA064C2809BE2587C9BDF0F430C25D` |
| `sidecars.manifest.json`               |    161,448 | `461FCE6A38804E91B2C58FEE22344000B8056854159AF46C3CC61316BD20193B` |

The exact source archive for `739f5243988fde4a643b788b1dc365cf03c3c829` is
`E:\temp\cupcake-overhaul-20260905\immutable-final-739f524-20260905-150325\cupcakeagi-739f524.tar`
(12,113,920 bytes, SHA-256 `9F7112065AF53336A1C4268B6222523A020F9E29575A190D1506393ECB0620F4`). The
runtime manifest lists 820 support files totaling 87,338,636 bytes. Package-time construction checks
passed for OpenAI, Anthropic, Google, xAI, Mistral, and Cohere without network access. The runtime
help probe, pinned Cupcake Local b10679 verification, manifest verification, bundle smoke, and
release-candidate audit all passed. The installer is intentionally unsigned and no publishing action
occurred.

A pristine packaged profile exposed CDP in 573 ms, reached the ready Home surface in 6,323 ms, and
closed through the app's own Close control in 86 ms. The audit recorded zero renderer errors and no
horizontal document or body overflow at 390 by 844. Direct WebView captures cover Home, Chats,
Projects, Tasks, Artifacts, Memory, Models, Tools, Search, Settings, the OpenAI provider and local
model-install dialogs, all eight onboarding chapters, About, the model picker, and narrow
onboarding/navigation. They are stored under
`E:\temp\cupcake-overhaul-20260905\final-packaged-major-views-739f524-r2`.

Visual inspection found a populated four-card model recommendation set at wide size, three ready
hosted routes in the narrow picker, explicit failed-or-cancelled task summary language, readable
empty states, and narrow onboarding contained within seven-pixel side gutters. The narrow Models
page capture occurred during its bounded refresh and therefore does not independently close the
post-refresh first-card viewport gate; that state remains covered by the source browser matrix and
should be recaptured from the packaged app after the owner showcase releases the singleton.

The NSIS registry inspection still returned no registered CupcakeAI entry and
`%LOCALAPPDATA%\CupcakeAI 2` did not exist. The installer lifecycle was not run after the user added
an exact Windows deletion procedure: an automated NSIS uninstall would remove files outside the
required PowerShell/.NET deletion path. The built installer and clean pre-install state are retained
without mutating the ordinary installation or user data.

The baseline is evidence for comparison, not acceptance of the changed product. The fresh package
must still prove:

- process-to-first-useful-local-state and process-to-fully-hydrated timings, recorded separately;
- one-folder runtime presence and exact manifest verification in installed resources;
- no `_MEI` runtime child/extraction behavior for the new package;
- saved conversation opening while optional provider/model status is still loading;
- no stale async navigation reversal;
- real close, explicit close-to-tray, and full child-process cleanup;
- standard, narrow, zoom/high-DPI, ultrawide, reduced-motion, and high-contrast renders;
- every conditional long-content, task-detail, artifact-revision, install, error, cancellation, and
  offline state that was absent from the baseline profile;
- persisted, owner-readable multi-provider and local-CUDA showcase content produced by real routes.
