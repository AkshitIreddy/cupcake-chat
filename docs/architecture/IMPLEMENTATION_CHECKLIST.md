# Corrective Tauri implementation checklist

This is the live completion ledger. Checked means implementation and fresh relevant evidence both
exist. Historical results do not check an item.

## Host and removal

- [ ] Tauri 2 host boots on Windows without a rejected desktop runtime installed or running.
- [x] Typed commands/events, generated capabilities, navigation policy, and sidecar verification
      pass.
- [ ] Custom titlebar passes restored/maximized/narrow/DPI/zoom/keyboard/high-contrast checks.
- [x] Active source, dependencies, tests, fixtures, docs, and packages contain no removed
      local-server integration.

## Provider onboarding

- [ ] All retained providers have in-app disclosure, key entry, test, discovery, save, reconnect,
      and removal.
- [ ] Invalid key, cancellation, rate limit, offline, and secret-redaction states pass.
- [x] Fresh packaged NVIDIA NIM and one direct-adapter multi-turn conversation pass when authorized.

## Cupcake Local

- [x] Fresh no-model profile shows a nonempty device-ranked catalog.
- [x] Hardware/ranking/catalog/download/recovery fixtures pass.
- [ ] Real packaged download, checksum, load, benchmark, chat, unload, removal, offline, and restart
      pass.

## Visual and accessibility

- [x] Deliberate scrollbars cover every container and theme.
- [x] Provider/model empty/loading/success/error states are polished and application-owned.
- [ ] 360/768/1024/1440/ultrawide, 200–400% zoom, DPI, high contrast, reduced motion, keyboard, and
      screen reader pass.
- [ ] Every visual claim has an opened and inspected screenshot from the real Tauri/WebView2 app.

## Core and security

- [x] Contracts, JS, Python, broker, and Tauri-host format/lint/type/test/build gates pass.
- [x] Encryption, migration, backup/restore, object integrity, project isolation, DAG, FTS, and
      indexing pass.
- [x] Forgery/replay, approvals, traversal/junction, prompt injection, secret scans, sandbox limits,
      and process trees pass.
- [ ] Kill/restart matrix and canonical end-to-end scenario pass without duplicate effects/events.

## Package and owner handoff

- [ ] Target-triple sidecars/resources, executable, and unsigned NSIS installer pass integrity
      smoke.
- [ ] Clean Windows 10/11 install, two-version upgrade, uninstall, and retention pass.
- [ ] Startup, steady-state memory, and Cupcake Local tokens/second are measured and reported.
- [ ] README, architecture, known issues, testing guide, and final handoff match only current
      behavior.
- [ ] GPU marker is `no`; no model/runtime remains loaded.
- [x] Nothing was pushed, published, released, distributed, production-signed, or connected to an
      updater.
- [ ] Owner explicitly accepts or rejects the corrective candidate.
