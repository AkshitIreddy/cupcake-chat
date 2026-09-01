# ADR-0003: Hosted providers and Cupcake Local

**Status:** Accepted (corrective revision)

**Date:** 2026-08-29

## Provider boundary

Product-owned adapters normalize model descriptors, canonical input, cancellation, streamed events,
usage, citations, tool intents, safe reasoning summaries, finish state, retry metadata, and errors.
Provider SDK objects are never durable product truth.

Retained hosted routes are OpenAI, Anthropic, Gemini, xAI, Mistral, Cohere, NVIDIA NIM, and generic
remote OpenAI-compatible endpoints. Model selection is explicit. Fallbacks are disabled by default;
any provider, Local/Cloud, privacy, or cost boundary change requires confirmation.

NVIDIA NIM is optional evaluation access, not unlimited or default. Mistral's optional free
Experiment mode has lower limits and distinct data-use terms from paid access. Cohere trial keys are
limited to 1,000 calls per month and are not a production entitlement. UI copy links to current
official terms and avoids converting a temporary allowance into a product promise.

## In-app onboarding

Provider setup is an application route or sheet with provider/privacy/cost explanation, obtain-key
link, masked key field, optional genuine endpoint fields, cancellable connection test, model
discovery, diagnostics, review, success, masked saved identity, last-tested time, reconnect, and
removal. The key crosses once to the trusted Tauri/broker boundary and is DPAPI-protected. It never
returns in bootstrap or appears in logs, product databases, screenshots, crash output, or snapshots.

## Cupcake Local

Cupcake Local is the only installed local-model manager. It uses an app-managed, versioned llama.cpp
runtime with a safe CPU baseline and verified optional acceleration packs. GGUF weights are optional
downloads and never bundled.

On native Windows/NVIDIA, runtime selection is a signed compatibility ladder rather than a single
build: CUDA 13.3 for driver 580 or newer, CUDA 12.4 for older supported NVIDIA drivers, Vulkan as
the portable GPU fallback, and CPU as the guaranteed baseline. NVIDIA identity, VRAM, and driver
version come from trusted in-process NVML first so Windows Job containment does not block discovery;
every downloaded pack must also pass its own `llama-server.exe --list-devices` probe before
activation. TensorRT-RTX/Windows ML remains a researched future ONNX lane, not a substitute for the
broad GGUF catalog while its high-level integration and artifacts differ.

Before installation the Models screen detects CPU features, RAM, disk, Windows version, NVIDIA
GPU/VRAM, system RAM, and installed acceleration. The signed catalog contains 11 public GGUF
artifacts across Qwen3, Granite 3.3, Ministral 3, and Phi-4 pinned to immutable Hugging Face
revisions. Verified entries include provenance,
license, parameters, quantization, bytes, checksum, architecture, context choices, capabilities, and
runtime requirements. Rankings explain Recommended, Fits with reduced context, CPU-only/slow,
Hybrid, or Incompatible. Download, pause/resume/cancel/retry, checksum, atomic promotion,
versioning, load, benchmark, chat, unload, and removal are app-owned and restart-safe.

External vLLM may remain only as an explicitly user-managed remote endpoint after architecture
review; it is never installed or presented as Cupcake Local.

## Verification

Use deterministic provider and hardware/catalog/download fixtures in CI. Fresh acceptance requires
real multi-turn hosted chat through the finished in-app flow and a real packaged Cupcake Local
download/load/chat/unload/restart, with secret-safe evidence and measured performance.
