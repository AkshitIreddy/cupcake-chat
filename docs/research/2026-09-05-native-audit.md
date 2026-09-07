# Packaged Windows workbench audit and startup research

**Initial audit:** 2026-09-05

**Final qualification update:** 2026-09-07

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

### Final packaged candidate — 2026-09-07

The final local candidate is built from production source 89882fa91b34b7581061e0b07b4c188aa5ba3922.
Its Python runtime source froze at 60cbc47; the intervening commits change the renderer and Tauri
configuration only. They add real group-chat UX, exact live local-route readiness, wallpaper palette
and contrast repairs, high-zoom reachability, quiet-turn presentation, and native WebView zoom
hotkeys without changing the already validated runtime or broker.

| Artifact                             |      Bytes | SHA-256                                                          |
| ------------------------------------ | ---------: | ---------------------------------------------------------------- |
| CupcakeAI.exe                        | 12,779,520 | E0B36BA64BA277AF6611AFA6EBDC1A06F894A849EC34D1629F936383E4424FFA |
| CupcakeAI 2_2.0.0-rc.1_x64-setup.exe | 82,458,955 | E2DC0E04FC7DFAEA68EFA51BA7F3DED2535D5B041F9CE3AB46B0A073B71C390F |
| cupcake-runtime.exe                  | 28,674,525 | AF89CF95BED9F26148E9EE3AE614EE172DB9F783B301DB5634C8C72D036FB19F |
| cupcake-tool-broker.exe              | 10,749,440 | 6AE4A22F42B5D7B2AD5DB2670C31091E15273F05EF9BA6128E5C3B298E9E9CAC |
| sidecars.manifest.json               |    161,448 | 4283994C1D7225CAB0B62427D60D78AA71737C45DD90713FADC5BD226E2CE461 |

The exact source archive is
E:\temp\cupcake-overhaul-20260905\immutable-final-89882fa-20260907\cupcakeagi-89882fa.tar
(12,247,040 bytes, SHA-256 39FDC565D38D68589B7AE3EB1FE29C3708A1846E25AACEDA1E68909737FC5388). The
runtime manifest binds 820 support files totaling 87,338,636 bytes. Package construction checks
passed for OpenAI, Anthropic, Google, xAI, Mistral, and Cohere without sending provider traffic. The
broker-to-runtime encrypted-protocol smoke, exact manifest/tree validation, Tauri package smoke, and
release-candidate audit all passed. The installer is intentionally unsigned. No signing, publishing,
pushing, or release action occurred.

The runtime validation associated with the final runtime collected 525 tests: 524 passed and one was
skipped. Pyright reported zero errors and warnings, mypy checked 121 source files, and the scoped
Ruff and formatting checks passed. The signed model catalog is enforced at explicit integrity status
and every managed load. Group readiness reads the live managed endpoint and exact loaded model ID,
so an unloaded or replaced local route cannot be presented as ready.

#### Startup diagnosis and final distribution

The owner-profile regression had two independent causes. One-folder PyInstaller packaging removed
repeated _MEI extraction. The later 13–15 second runtime gate came from CheckedDownload._recover,
which rehashed 6.24 GB of completed retained downloads on every startup: a 5,027,783,488-byte Qwen
model and 1,214,386,338 bytes of runtime archives. Recovery now accepts an exact saved checkpoint,
destination, existence, and byte length as metadata only. Full signed digest verification still runs
at install, registration, explicit integrity status, and load. Tests cover completed recovery,
wrong-size reset, same-size model tampering, and same-size runtime-archive tampering.

An exact owner-profile direct health probe improved from 13,951 ms on the old frozen runtime to
5,805 ms on the new cold runtime, an 8,146 ms or 58.4% reduction. Its immediate warm repeat was
1,543 ms. Repeated full desktop starts on the final-runtime candidate separated page, Home, and
route hydration:

| Owner-profile run                              | Tauri page | First Home | Stable selected route              |
| ---------------------------------------------- | ---------: | ---------: | ---------------------------------- |
| New WebView directory, first post-build access |  not timed |  21,604 ms | 22,644 ms, Groq openai/gpt-oss-20b |
| Same WebView directory, repeat 1               |   1,952 ms |   3,972 ms | 4,578 ms, Groq openai/gpt-oss-20b  |
| Same WebView directory, repeat 2               |   1,813 ms |   3,891 ms | 4,565 ms, Groq openai/gpt-oss-20b  |
| Same WebView directory, repeat 3               |   1,825 ms |   3,833 ms | 4,373 ms, Groq openai/gpt-oss-20b  |
| Existing owner/VBS WebView directory           |   1,750 ms |   3,798 ms | 4,354 ms, Groq at first Home       |
| Second new WebView directory after warm-up     |   1,639 ms |   3,635 ms | 4,319 ms, Groq openai/gpt-oss-20b  |

The first 21.6-second start remains a cold-path outlier and is not described as fast. It did not
recur with the existing owner WebView directory or a second fresh directory, so the evidence does
not support recurring WebView initialization as its cause. No phase trace exists for that one
pre-page delay, and this audit does not attribute it to antivirus. Stable app.bootstrap times were
1,226–1,374 ms and models.list took 45–64 ms.

Three stable runs held 11 owned processes each: host, broker, one-folder runtime, two hidden console
hosts, and six normal WebView2 processes. Their total working set was 745.9–757.6 MiB. No _MEI
runtime child appeared. Host close took 1,257–1,381 ms; the complete tree was absent after
2,339–2,537 ms. These distribution measurements use the same frozen runtime and renderer family,
before the final bounded CSS and Tauri zoom-setting commits. Exact final-package lifecycle timings
are recorded below.

#### Exact final NSIS lifecycle

The exact 89882fa installer was tested only after a clean current-user uninstall-registry query, an
absent %LOCALAPPDATA%\CupcakeAI 2 directory, and zero owned process check. The harness used an
isolated profile under E: and kept every app window headless.

Silent install succeeded and the installed app reached Home in 5,073 ms. The harness created project
sentinel 01a07b40-7cde-732f-86bc-41a0e668bfaa, closed through the app, and invoked the product's own
silent uninstaller. The uninstall record and install directory were absent afterward. The same final
portable executable reopened the retained isolated profile in 3,169 ms and returned the exact
sentinel. Final cleanup found no CupcakeAI, broker, runtime, or llama process; no listener on ports
10131 or 10141; no uninstall record; and no install directory.

The receipt is E:\temp\cupcake-overhaul-20260905\final-nsis-lifecycle-89882fa\lifecycle-result.json
(SHA-256 53DBF2523E95786D298F0CBDE995AD0D39615659E6F12D699D0C74B28DB4A74F). This qualifies clean
install, uninstall, profile retention, and hidden launch/close on the owner's current Windows
machine.

A provisional lifecycle invocation earlier treated an unsupported --help flag as read-only. It was
interrupted after installation and immediately reversed with the product's own silent uninstaller.
Registry, install-directory, process, and port checks were clean before the accepted final run. That
excluded attempt is recorded at
E:\temp\cupcake-overhaul-20260905\provisional-lifecycle-interruption-20260907.json and is not part
of the acceptance result.

#### Final visual, group, and accessibility evidence

Direct final-package WebView screenshots show the real three-person council, two active hosted
members, paused local Juniper, the retained conversation, and the exact-route Persona editor. The
quiet council state renders one compact composer-attached “No reply needed” row. Opening and closing
its “Why?” disclosure did not change transcript history or invoke a model. The route receipt still
reports one of two routing checks. Evidence is under
E:\temp\cupcake-overhaul-20260905\final-native-89882fa.

The final renderer's 27-surface palette matrix covered eight wallpapers, four base themes, group
settings, Persona editor, Home, and Models. It reported zero Axe contrast findings; the minimum
measured warning contrast was 5.946:1. Copper and the other artwork scenes now use their own solid
surface colors instead of neutral translucent boxes. The conversation scrollbar is a thin,
scene-colored treatment, message actions have an opaque backplate and keyboard-focus reveal, and the
paused local-model warning clears normal-text contrast. Quiet-state tests at 390 by 844 and 360 by
230 retained keyboard disclosure, composer reachability, zero horizontal overflow, unchanged
history, and zero model or send calls.

The clean-vault retake redirected product data and LOCALAPPDATA to isolated paths on E: and injected
no keys, fixtures, or provider calls. Wide and 390-pixel Models views showed four local
recommendations and no ready hosted route. The narrow first viewport includes Qwen3 14B's complete
card and Install action. Evidence is under
E:\temp\cupcake-overhaul-20260905\final-clean-vault-7583199-r2; the subsequent final commits do not
change Models or onboarding layout.

Reduced-motion and Forced Colors emulation retained structure without horizontal document overflow.
Native WebView zoom hotkeys were added through Tauri's Windows WebView2 setting. On the final host,
guarded owned-window input verified reset, Ctrl+=, Ctrl+Shift+=, numpad add, Ctrl+-, numpad
subtract, and Ctrl+0 while the composer was focused. Exact 200% and 400% DOM measurements showed the
high-zoom repair keeping transcript content, composer, Persona editor, and Save action reachable
through vertical scrolling instead of collapsing the transcript to zero height. The test restored
Ctrl+0 and the ordinary owner window geometry.

Further zoom captures and visible-window checks stopped immediately when the owner said the repeated
zoom work was not useful and required all UI testing to run headlessly. The bounded measurements and
already captured frames are retained as diagnostic evidence; additional zoom, DPI, and visible tray
qualification are outside the final owner-directed scope. The audit did not alter global display or
accessibility settings.

The final headless owner restart reached Home in 3,649 ms. All four real showcase projects
persisted; the artifact project retained one proof, and both local assistant turns remained complete
with the local runtime stopped. Keyboard Enter and Space opened and closed the quiet explanation
without changing the history or turn hash; the retained route counters were selector 1 and
responder 0. Final close removed the 11-process owned tree in 2,100 ms, including harness
observation overhead, and left zero models and no GPU lock. Receipts are under
E:\temp\cupcake-overhaul-20260905\final-owner-restart-89882fa and
E:\temp\cupcake-overhaul-20260905\final-owner-showcase-89882fa, with close state in
E:\temp\cupcake-overhaul-20260905\final-owner-close-89882fa.json.

The final exact package therefore completed hidden owner restart, saved-demo verification, close,
install, uninstall, and retained-profile reopening. Cross-machine and VM qualification are outside
this owner test scope by explicit direction; they are not reported as blockers for the current
Windows acceptance.
