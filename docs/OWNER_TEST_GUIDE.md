# Cupcake Chat 1.8 owner review

Everything is local on `master`. Nothing has been pushed or published.

## Open the app

- **Launch Cupcake Chat Test.vbs** opens the clean owner workspace without a terminal.
- **Launch Cupcake Chat Demo.vbs** opens the populated demonstration workspace.

The owner profile is `E:\temp\cupcakeai-owner-test-20260902`. Provider connections and installed
models are preserved. Old example projects and chats are archived, leaving no active project, chat,
or artifact in the clean workspace. The 39 default advisors remain. Completed task audit history is
retained with the archived projects. The pre-cleanup recovery copy is
`E:\temp\cupcake-owner-backups\before-1.8-clear-20260915` (89 hash-verified files, 10,056,709 bytes,
excluding model weights).

The demo profile is `E:\temp\cupcake-chat-demo-profile-1.8`, with three projects and seven active
chats:

| Project                         | Conversations                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Rome beyond the battlefield     | How did Rome keep an army fed? · Roads or rivers? · When would a Roman fort run out of grain? · Winning battles, losing the war |
| Viking voyages                  | What went aboard a Viking ship? · Three extra days at sea                                                                       |
| Mongols and the moving frontier | How do all those horses eat?                                                                                                    |

Google, Groq, Cohere, Cloudflare, and app-managed local CUDA outputs are saved in this profile. The
film replays saved Google prose and Groq code at a controlled pace. It does not measure API latency.
Earlier examples and rejected attempts are archived, not featured.

## Review files

- [README](../README.md): user and contributor sections, free provider options, and six screenshots.
- Review MP4: `E:\temp\cupcake-chat-review-1.8-forward-loop.mp4`, kept outside the repository.
- [README animation](media/cupcake-chat-demo-preview.gif): the fast public feature tour.
- [Demo notes](demo-storyboard.md): recording and replay provenance.
- Installer: `E:\temp\cupcakeagi-tauri-target\release\bundle\nsis\Cupcake Chat_1.8.0_x64-setup.exe`.
- Executable: `E:\temp\cupcakeagi-tauri-target\release\CupcakeAI.exe`.

Product source is `8016e2b`, including MIT licensing, compact first-release update status, smooth
Markdown streaming with consistent spacing, stable chat headers, full-width paragraphs, reusable
inline Python tests, accurate Home project counts, and display equations. Package and media receipts
are under `E:\temp\cupcake-chat-smooth-demo-1.8`.

## What to try

1. Open Rome's first chat. Its short question has an actual saved Google answer.
2. Open **Winning battles, losing the war** for the Cohere/Cloudflare group. Add Cupcake offers 24
   historical advisors across six eras, alongside 15 everyday advisors. Use an era filter.
3. Open a Viking or horse-forage chat for saved Qwen3 8B CUDA responses. Local inference is unloaded
   after verification; reading a saved chat does not load it.
4. Open **Tools → History workshop**. Change travel pace, siege arrivals, or forage availability.
   Save the result to the active project's artifacts. Tool search remains at the top of All tools.
5. Open **When would a Roman fort run out of grain?** and click **Run tests** on the Python block.
   Its corrected model-generated code passes eight native tests; output stays inside the chat.
6. Try theme-matched portraits and wallpapers. The default is the lively sword-carrying Roman
   cupcake; Strawberry and pink Rose castle garden remain available.
7. Replay onboarding from Settings, visit a provider connection and optional local setup, then skip.
8. Toggle Recent's all-chats button. An empty unsent draft should disappear when you leave it.

## Verification and release boundary

The final packaged build passed native identity, 39 default-advisor checks, onboarding resume,
updater state, and the interactive History workshop checks. The desktop suite passed 129 tests; 67
targeted runtime checks passed. NSIS packaging, bundle smoke, and release-candidate audit passed.
The final installed candidate reached Home in 5.00 seconds. Its silent install/uninstall removed the
test registration and protocol, left the older CUPCAKEAGI install untouched, and preserved all 89
non-model profile files byte for byte. Reopening preserved the clean workspace. These checks use the
current version; they do not establish cross-version production upgrade behavior.

Actual Qwen3 8B CUDA output and NVIDIA process observation are recorded in
`history-local-reviewed.json` and `history-curated-local.json` under the release evidence directory.
The model was unloaded and the GPU lock restored to `no`.

The project uses the MIT License; its notice ships in the installer. The local installer is
unsigned. Production updater keys are intentionally not configured. An isolated signed test-feed
download succeeded and a tampered payload was rejected; production installer upgrade and
cross-version profile retention have not been qualified. The owner waived a VM test. No production
release workflow, push, signing, or publication has been authorized.

Some later hosted requests hit quota or availability failures. They were not presented as success.
The historical chats are real model answers; their prose should not be treated as independently
verified scholarship. Numerical workshop outputs use visible assumptions and tested arithmetic.
