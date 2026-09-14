# Cupcake Chat product demo

This is a 151-second guided scene recorded from the real packaged Windows app at its existing 1440 ×
920 CSS viewport and DPR 1.5. The 1.12× review playback is expected to land near 135 seconds. It
uses a disposable clone of the owner test profile under `E:\temp` and records real UI interactions
through WebView2 CDP. The Madara answer, ODM artifact, task evidence, and group discussion must all
be real persisted app records. The recorder does not seed assistant text, edit the profile database,
read credentials, launch the app, change its resolution, or apply browser zoom.

The primary output is a seekable H.264 MP4 for review and video editing. A short historical-still
pipeline test exists only to prove the capture/FFmpeg path; it is visibly labelled and is not
product evidence.

## Storyboard

|     Time | Picture and action                                                                                                                                                                                                                                                                                             | What the viewer learns                                                                                                                                 |
| -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
|     0–4s | Cupcake Chat Home, held long enough to read.                                                                                                                                                                                                                                                                   | The product feels like a calm workspace rather than a bare prompt box.                                                                                 |
|    4–17s | Open **Life, Admin, Done** and the chat **help me text my landlord about this leak**. Scroll through a practical exchange.                                                                                                                                                                                     | Normal, low-effort questions are welcome; human and Cupcake messages are visually distinct and readable.                                               |
|   17–28s | Briefly open **Memory** and **Tools**.                                                                                                                                                                                                                                                                         | The workspace can remember useful context and do more than chat.                                                                                       |
|   28–39s | Open **Models** and scan the provider catalogue.                                                                                                                                                                                                                                                               | Cloud and local choices live in one understandable place.                                                                                              |
|   39–88s | Open **Anime rabbit holes** and start a chat. Switch from the existing hosted NVIDIA NIM route to Cohere, then to Groq GPT-OSS 120B. Type the Madara question in full and press Send. An on-video caption says **Real Groq response · playback 1.12×** while the response finishes. Hold, then read-scroll it. | Provider changes are immediate and visible in the composer. The playful answer is genuinely generated and persisted; the speed disclosure is explicit. |
|  88–106s | Open **ODM toy physics.py**, then scroll its saved artifact.                                                                                                                                                                                                                                                   | A casual anime idea can turn into inspectable work with readable assumptions and code.                                                                 |
| 106–114s | Open **Test ODM toy physics** in Tasks.                                                                                                                                                                                                                                                                        | The artifact was run through the app's real task path and carries durable test evidence.                                                               |
| 114–130s | Open **Neighborhood Repair Cafe** and **Thirty-six broken things, one Saturday**, then read-scroll the group conversation.                                                                                                                                                                                     | Several Cupcakes using at least two real providers can share a chat and exercise judgment about when to speak.                                         |
| 130–147s | Open Appearance. Show Cupcake Dark with the new Burgundy cinema lounge, then Minimal with the new Cherry lacquer atelier. Restore the clone's original theme and wallpaper.                                                                                                                                    | New backgrounds change the full visual system and remain usable across palettes.                                                                       |
| 147–151s | Return to Home and hold.                                                                                                                                                                                                                                                                                       | The clip closes on the same neutral state used for its clean anchor seam.                                                                              |

The exact recorded length can vary with the live Groq response. The scene is encoded at 1.12× and
discloses that speed in the live-generation caption. A finished review copy must remain between 90
and 180 seconds. If provider latency pushes it outside that window, preserve the failed-take
evidence and prepare a fresh clone rather than hiding the delay with synthetic text.

## Required persisted material

The disposable recording clone needs these exact records before capture:

- Project **Anime rabbit holes**.
- Chat **can we make ODM gear into a tiny physics toy?** with a real provider reply.
- Saved artifact **ODM toy physics.py** created from that reply.
- Completed task **Test ODM toy physics**, bound to the saved artifact revision, with real Python
  execution/test evidence.
- Project **Neighborhood Repair Cafe** and group chat **Thirty-six broken things, one Saturday**.
- Existing everyday project **Life, Admin, Done** and chat **help me text my landlord about this
  leak**.
- Available models `cohere:command-a-plus-05-2026` and `openai-compatible:groq/openai/gpt-oss-120b`.
- A ready hosted NVIDIA NIM model selected before recording. The preflight rejects a local starting
  route so capture cannot start local inference or use the GPU.

A good preparation prompt for the ODM chat is:

> can we make ODM gear into a tiny physics toy? use two fixed anchors, gravity, a cable tension
> limit and a gas-thrust input. simulate 20 seconds, save a csv, and add tests for rope length and
> finite values. keep the equations readable and tell me what you're simplifying — this is just an
> anime toy, not instructions for real gear.

Save the resulting Python as the named artifact, then run the artifact-bound code task from Cupcake
Chat. Do not paste a locally fabricated assistant answer into the profile.

## Gifsmith setup

The demo uses [gifsmith 0.3.5 on npm](https://www.npmjs.com/package/gifsmith) and its official
[Tauri/WebView2 attach adapter](https://github.com/AkshitIreddy/gifsmith#readme). The installed
package is pinned outside the repository:

```powershell
npm install --prefix E:\temp\cupcake-gifsmith gifsmith@0.3.5 --cache E:\temp\npm-cache --no-audit --no-fund
npx --prefix E:\temp\cupcake-gifsmith gifsmith doctor
```

The installed tarball integrity used for this demo is:

```text
sha512-5zLN3NA3CubgoN5L5xZED0T2A/4Qub+tdHT9CjopAAYwg1W96pX5kabNEude+BjLjESOOFDfUcIgtr9ERbbL9w==
```

Gifsmith uses `puppeteer-core`, so it reuses an installed Chromium browser. MP4 output requires
FFmpeg with `libx264`. The local doctor check found Google Chrome and a working H.264 encoder.

The recorder uses screencast capture because it attaches to a real running app and waits on a live
provider. Gifsmith's deterministic mode freezes the attached page clock and requires extra
compositor launch arguments, so it is a poor fit for this network-backed owner-profile take. JPEG
capture at quality 96 keeps the large temporary frame set on `E:\temp`; the final MP4 is 1440 pixels
wide, 30 fps, H.264 CRF 18, and `yuv420p`.

## Safe operating sequence

The normal plan command is local and does not connect to the app:

```powershell
node scripts\demo-cupcake-chat-gifsmith.mjs --phase plan
```

The coordinating operator first clones the required archived chats and supporting records into a
disposable `CUPCAKE_TEST_DATA_DIR` below `E:\temp`. The owner profile stays untouched with zero
active showcase chats. Launch the packaged app off-screen at its normal 1440 × 920 CSS pixels and
DPR 1.5 with WebView2 CDP port 10131, then prepare or verify the required records in that clone. The
recorder only attaches to the already-running app. Add `--remote-allow-origins=*` to
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` only if WebView2 rejects the CDP WebSocket with 403, as
described by gifsmith's adapter documentation.

Run a dry preflight first. It validates packaged-app identity, runtime readiness, the unchanged 1440
× 920 / DPR 1.5 viewport, Groq and Cohere availability, exact project/chat/artifact/task records,
real provider provenance for the chats, successful artifact-bound Python evidence, and that the
one-time Madara prompt is absent:

```powershell
node scripts\demo-cupcake-chat-gifsmith.mjs --phase dry-run --port 10131
```

Record only after preflight succeeds:

```powershell
node scripts\demo-cupcake-chat-gifsmith.mjs --phase render --port 10131 --execute ACTUAL_PACKAGED_APP_RECORDING
```

The script writes under `E:\temp\cupcake-chat-gifsmith-demo`:

- `cupcake-chat-demo.mp4` — the review copy.
- `evidence.json` — packaged/runtime preflight, exact persisted IDs, generated answer provenance,
  render metrics, and restoration result.
- `review\report.md` plus contact strips and machine-readable review data — gifsmith's temporal
  triage.

The script restores the original theme, wallpaper, and selected model in both its normal and failure
paths. It refuses to render without an explicit execution token, refuses a non-packaged runtime or
any viewport other than the actual 1440 × 920 at DPR 1.5, and refuses to create a second copy of the
same Madara prompt.

## Pipeline-only proof

This command renders a five-second MP4 from three historical screenshots. Every frame is labelled
**PIPELINE TEST · historical still**, so it cannot be mistaken for a live product recording:

```powershell
node scripts\demo-gifsmith-pipeline-smoke.mjs
```

The verified proof at `E:\temp\cupcake-gifsmith\pipeline-smoke\pipeline-smoke.mp4` is 960 × 614,
H.264, `yuv420p`, 12 fps, 5.000 seconds, and 807,114 bytes. Its two temporal-review findings are the
intentional slideshow transitions, not claims about app behavior.
