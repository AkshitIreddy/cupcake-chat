# Known issues and release boundaries

This page separates expected release-candidate constraints from defects. The
[implementation checklist](architecture/IMPLEMENTATION_CHECKLIST.md) is the live authority while 2.0
is under construction.

## Current branch status

- CUPCAKEAGI 2.0 is a local release-candidate branch, not a published release.
- A source build may contain deterministic UI/provider fixtures while native integrations are being
  assembled. Fixture content does not prove a provider connection, model installation, durable
  recovery, tool execution, or persistence.
- Until every release gate is checked and owner testing is complete, use only disposable profiles
  and test data.
- No production update feed, general download, package publication, pushed 2.0 release, or GitHub
  release is configured or authorized.

## Expected constraints

### Windows 10/11 x64 only

Windows 10 and Windows 11 on x64 are the sole release-candidate targets. macOS, Linux, Windows on
Arm, and 32-bit Windows have no build, packaging, credential-vault, or sandbox support contract in
2.0. Provider credentials use per-user Windows DPAPI protection. Generated-code execution requires
the broker's restricted-token/AppContainer-style boundary plus a Job Object; it fails closed when
that boundary or its limits cannot be established.

Classic AppContainer process creation inherits the broker's allowlisted bootstrap environment.
Custom bindings and any credential-like ambient name fail closed, so generated code receives no
keys, tokens, cookies, passwords, or vault material. Non-secret Windows and packaged-sidecar path
metadata can remain visible inside the container.

### Unsigned test artifacts

Production signing credentials and a production updater endpoint are not part of the local
candidate. Windows may warn about an unsigned or locally signed installer. Do not bypass
organizational security policy or distribute the artifact as a release.

### Running-app same-version reinstall

A same-version Squirrel silent reinstall attempted while the isolated test app was running did not
complete and had to be terminated. Close CUPCAKEAGI before reinstalling the same candidate. With the
test app closed, a clean reinstall completed normally. This does not establish behavior for a
supported upgrade between different versions, which remains part of owner acceptance testing.

The subsequent isolated `Update.exe --uninstall -s` check exited 0 and removed the installed app and
launcher executables. It left normal Squirrel `.dead`/Update cleanup residue and preserved the
explicit profile-retention database at `out/installer-rc-20260829/profile-retention/cupcake.db`.

### Cloud credentials and cost

Live provider tests require user-supplied credentials and can incur charges. Deterministic fixtures
cover ordinary development and CI, but cannot prove current account permissions, quotas, model
availability, regional behavior, or billing. Configure low test budgets and never commit
credentials.

### Local model weights

No model weights are bundled. Initial local use requires a compatible runtime/model and sufficient
disk, RAM, and possibly VRAM. Performance estimates are guidance until CUPCAKEAGI records a
benchmark on the actual machine.

### External runtimes and tools

Ollama, LM Studio, vLLM, and MCP servers have their own security, update, license, and availability
boundaries. CUPCAKEAGI manages or connects only as described in the UI; it cannot make an untrusted
endpoint safe. vLLM is connection-only.

Web search is intentionally disabled until the owner configures a credential-free public HTTPS
search origin with `CUPCAKE_WEB_SEARCH_ENDPOINT`; web fetch remains available. This keeps an
unspecified third-party search service from receiving queries silently.

### No account or sync

There is no Cupcake account, cloud synchronization, or multi-profile interface. Use encrypted
backup/export for portability and protect the resulting files.

### Deliberate omissions

Voice and automatic model routing are not planned for 2.0. Thoughts and Dreams are disabled by
default. These are product choices, not missing controls.

The 1.x `write-the` MkDocs generator is preserved in Git history and at the `v1.0.0` tag only. It is
not migrated, bundled, or supported as a 2.0 documentation/package generator.

## Cleared during final validation

- Strict Pyright passes under `services/runtime/pyproject.toml`; the verification script uses that
  declared project configuration.
- Frozen sidecar replacement is atomic and rollback-tested, and the seeded authenticated protocol
  smoke reaches bootstrap plus local-model discovery.
- The packaged NVIDIA NIM chat rendered its exact-format response without exposing a thinking trace.
- The packaged LM Studio route completed a real local Gemma GPU chat. The coordination flag was
  restored to `no`, the model was unloaded, and the server was stopped afterward.
- Isolated clean silent install, closed-app reinstall, and silent uninstall passed. The uninstall
  removed app/launcher executables and retained the disposable profile database; the running-app
  same-version reinstall limitation is documented above.

## What must block approval

Treat any of the following as a release blocker:

- renderer access to Node.js, `ipcRenderer`, credentials, arbitrary paths, processes, or
  unrestricted network requests;
- plaintext credential storage or secrets in logs, events, traces, screenshots, crash output,
  backups, or migration reports;
- project-scoped files, search results, instructions, or memories appearing in another project;
- a provider or fallback sending data across a Local/Cloud or cost boundary without confirmation;
- an approval executing different resources, effects, destinations, arguments, or limits from its
  preflight;
- repeated external side effects, tool cards, artifacts, or message deltas after task recovery;
- generated code receiving network or credentials by default, escaping its staging area, or leaving
  child processes alive;
- a repository write without an exact staged diff and fresh approval;
- migration importing or executing old keys, tokens, generated scripts, bytecode, or unsafe state;
- backup/restore silently losing reachable data or accepting corrupt encrypted objects;
- unreadable or inoperable UI at required widths, themes, zoom, keyboard-only operation, high
  contrast, or reduced motion;
- fixture data presented as live state;
- an installer that cannot launch the bundled runtime/broker on clean Windows 10 or Windows 11 x64
  machines.

## Reporting an issue

Include the commit, operating system, application/package type, reproduction steps, expected and
actual behavior, and whether the problem occurs with deterministic fixtures, a cloud provider, or a
local runtime. Add redacted Developer Mode event IDs and screenshots when useful.

Never attach API keys, access tokens, full environment dumps, private file contents, raw application
databases, or unreviewed diagnostic exports. For durability problems, note the last visible task
phase and whether an external side effect had already occurred.

Use the full [local testing guide](local-testing.md) when evaluating a candidate rather than
sampling only the happy path.
