# CupcakeAI ready-to-chat handoff - 2026-09-01

## Owner experience

- Run `apps/desktop/src-tauri/target/release/CupcakeAI.exe`.
- The normal profile intentionally has no password verifier yet. First launch asks the owner to
  create a 15-128 character CupcakeAI password; no automation chose or stored it.
- Models, tools, and provider sidecars do not start until password setup/unlock succeeds.
- Settings > Privacy supports changing the password and locking the app immediately.
- After the first unlock, the normal profile already contains working Cohere and NVIDIA NIM
  connections, all runtime fallbacks, and Qwen3 8B as the local default.

## Normal Windows profile

- Profile: `C:\Users\akshi\AppData\Roaming\com.cupcakeagi.desktop\runtime`.
- Large local-model data is junctioned to `E:\temp\CupcakeAI\normal-profile\local-models`.
- Cohere and NVIDIA NIM credentials were imported without printing or storing their values in Git.
  Repeated broker restarts reported both providers as persistent and ready.
- The signed runtime ladder contains verified llama.cpp b10679 CPU, Vulkan, CUDA 12.4, and CUDA
  13.3 packs. CUDA 13 is active.
- Verified Qwen3 8B Q4_K_M is installed, loaded successfully on CUDA 13, and selected as the local
  default. A real hosted Cohere chat and a real local Qwen chat both completed.
- `gpu use.txt` was restored to `no` after inference acceptance.

The unreadable empty-profile databases encountered during setup were moved, not deleted, to
`E:\temp\CupcakeAI\quarantine\normal-profile-key-mismatch-20260901T1934Z`. An incomplete copied
CUDA 13 directory is quarantined beneath the same location. Fresh encrypted databases and a full
signed CUDA 13 install replaced them.

The 44 MB pre-migration local-model backup was also moved off C: into that recoverable quarantine;
the live normal-profile junction remains on E:.

## Catalog

The signed public catalog now contains 11 direct-download GGUF choices across Qwen3, IBM Granite,
Mistral Ministral 3, and Microsoft Phi-4, from 0.6B through hybrid 30B-A3B. Entries pin immutable
upstream revisions, exact sizes, SHA-256 values, licenses, context choices, capabilities, and task
tags. Gated models remain excluded until CupcakeAI has an explicit license/authentication flow.

## Acceptance evidence

- Normal-profile readiness: `artifacts/runtime/ready-profile-full-20260901.json`.
- Password lifecycle record and inspected screenshots:
  `artifacts/screenshots/ready-to-chat-20260901/`.
- Research and primary-source map: `docs/research/ready-to-chat-windows-2026-09-01.md`.
- Checklist: `docs/READY_TO_CHAT_CHECKLIST_2026-09-01.md`.

Verified gates:

- Production `tauri build --no-bundle` succeeded.
- Password setup, sidecar blocking, wrong-password rejection, lock/re-unlock, and restart lock passed
  against the hidden production Tauri app.
- Rust host: 23 passed; rustfmt passed.
- Renderer/contracts: 113 passed; TypeScript passed.
- Focused runtime/catalog: 48 passed.
- Authenticated frozen sidecar protocol passed with the 11-entry local catalog.
- Build-mode package smoke passed for `CupcakeAI.exe`, both sidecars, and the CPU baseline.

The remaining visual acceptance is owner-driven: after choosing the real normal-profile password,
capture Models, Providers, and successful hosted/local chat screens without recording the password.
