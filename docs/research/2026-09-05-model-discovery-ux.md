# Model discovery and picker review — 2026-09-05

This pass independently reviewed CupcakeAI's model catalog against current Hugging Face Hub and LM
Studio discovery behavior. LM Studio is a comparative UX reference only; CupcakeAI continues to own
its runtime, downloads, policy, and model selection.

## Conclusions applied

1. Recommendations and discovery are separate surfaces. A blank catalog starts with at most four
   task-relevant choices, ranked by route readiness and local device fit. Search still reaches the
   wider catalog.
2. The Hub is paged rather than described by an arbitrary total. CupcakeAI follows Hugging Face's
   opaque `Link: rel="next"` cursor, bounds each response to 100 records and 16 MiB, and loads the
   next page only when requested. On 2026-09-05, a live three-item GGUF request returned an opaque
   cursor link; the old implementation discarded that link and always requested 48 records.
3. A community Hub card is evidence to review, not an installation promise. Cards retain the
   publisher/uploader, license, gated state, download count, likes, and last-modified date when the
   API supplies them. The action remains **View model card** because community weights do not enter
   CupcakeAI's signed model pipeline.
4. Download counts are a popularity clue, not a quality score. Hugging Face documents that every
   GGUF file is counted and a whole-repository clone can double-count, so the UI never turns counts
   into a quality rating.
5. Publisher, serving provider, and privacy route remain distinct. The picker groups by the company
   that released the model; a second line says whether it runs on this computer or which connected
   provider receives the request.
6. Search accepts capability words, publisher/model identifiers, and exact Hub URLs. Task chips and
   ready-route filtering keep the ordinary picker small. Unavailable routes are hidden by default
   and get an explicit setup/install explanation when revealed.
7. Local fit depends on current free VRAM as well as total capacity. The catalog shows both when the
   runtime can measure them, while recommendations use the runtime's fit classification.
8. An exact model stays exact across every hosted route. OpenRouter documents that `openrouter/free`
   randomly selects an underlying free model, so it is never a default model in CupcakeAI. The
   2026-09-05 public models API listed `nvidia/nemotron-3.5-lightning:free` with zero
   prompt/completion pricing; Cupcake pins that exact slug and labels the variable router only as an
   optional expert choice.

## Evidence reviewed

Hugging Face first-party documentation and maintained implementation:

1. [Hub models](https://huggingface.co/docs/hub/models) — model repositories are the unit of
   discovery and distribution.
2. [The Model Hub](https://huggingface.co/docs/hub/models-the-hub) — the Hub spans many tasks and
   serving paths, so a GGUF filter is necessary but insufficient proof of Cupcake compatibility.
3. [Model cards](https://huggingface.co/docs/hub/model-cards) — intended use, limitations, license,
   datasets, and evaluation context belong in the upstream card.
4. [Model card metadata](https://huggingface.co/docs/hub/model-cards#model-card-metadata) — task,
   base-model, license, library, and evaluation metadata drive discovery.
5. [Repository card API](https://huggingface.co/docs/huggingface_hub/package_reference/cards) — card
   metadata and card text are separate structured inputs.
6. [GGUF on the Hub](https://huggingface.co/docs/hub/gguf) — GGUF metadata can be exposed without
   asserting that any quantization fits the current device.
7. [HfApi list models](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api) —
   search, author, task, parameter, sort, and limit filters are first-class.
8. [Search the Hub](https://huggingface.co/docs/huggingface_hub/guides/search) — list operations are
   iterable and filterable rather than a fixed featured dump.
9. [Full-text search](https://huggingface.co/docs/hub/search) — model-card text is indexed, which
   supports capability-oriented queries.
10. [Hub API endpoints](https://huggingface.co/docs/hub/api) — model discovery uses the supported
    Hub API boundary.
11. [Hub rate limits](https://huggingface.co/docs/hub/rate-limits) — API paging must remain
    deliberate and recover cleanly from 429 responses.
12. [Model download statistics](https://huggingface.co/docs/hub/models-download-stats) — GGUF
    download counts can count multiple files and full clones more than once.
13. [Gated models](https://huggingface.co/docs/hub/models-gated) — gated access must be visible
    before any download promise.
14. [Hub security](https://huggingface.co/docs/hub/security) — upstream scanning helps users review
    risk but does not replace CupcakeAI's signed installation boundary.
15. [Downloading models](https://huggingface.co/docs/hub/models-downloading) — repository download
    and file resolution are separate from catalog browsing.
16. [Current pagination limitation](https://github.com/huggingface/huggingface_hub/issues/4257) —
    Hugging Face's maintained client consumes `Link` cursors internally but does not expose a
    one-page model result, supporting CupcakeAI's narrow REST cursor wrapper.

LM Studio first-party comparative references:

17. [Discover and download](https://lmstudio.ai/docs/app/basics/download-model) — keyword,
    `publisher/model`, and full Hub URL search are useful entry paths.
18. [`lms get`](https://lmstudio.ai/docs/cli/local-models/get) — blank discovery uses staff picks;
    explicit queries expose format and quantization controls.
19. [`lms ls`](https://lmstudio.ai/docs/cli/local-models/ls) — installed inventory emphasizes size,
    parameters, architecture, and model type.
20. [`lms load`](https://lmstudio.ai/docs/cli/local-models/load) — estimates depend on context,
    vision, and GPU offload, and can be computed before loading.
21. [Download API](https://lmstudio.ai/docs/developer/rest/download) — an exact catalog identifier
    or Hub URL starts an observable job with a total byte count.
22. [Download status API](https://lmstudio.ai/docs/developer/rest/download-status) — a download is a
    resumable status surface rather than a blocking button label.
23. [List models API](https://lmstudio.ai/docs/developer/rest/list) — downloaded and loaded state
    are separate concepts.
24. [model.yaml](https://lmstudio.ai/docs/app/modelyaml) — a curated model identity can reference
    weight sources and variants without conflating repackaging with the original publisher.
25. [Offline operation](https://lmstudio.ai/docs/app/offline) — bundled recommendations can work
    offline while fresh search, statistics, and downloads require network access.
26. [Idle TTL and auto-evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict) — ready,
    installed, and loaded are distinct lifecycle states.
27. [Headless service](https://lmstudio.ai/docs/developer/core/headless) — runtime lifecycle can
    stay independent from the catalog UI.
28. [Bionic local model discovery](https://lmstudio.ai/docs/bionic/models/download-local-models) —
    format, device fit, destination, and pause/resume/retry belong in the install workflow.

OpenRouter first-party references:

29. [Public models API](https://openrouter.ai/api/v1/models) — the live catalog is the source for
    exact model IDs, current free variants, pricing, context, modalities, and supported parameters.
30. [Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router) —
    `openrouter/free` selects randomly; an exact `:free` variant is required when model identity
    must remain under user control.
31. [Free variants](https://openrouter.ai/docs/guides/routing/model-variants/free) — a specific free
    model keeps its own slug with the `:free` suffix while availability and rate limits may differ.

## Visual direction

The page uses a restrained “model atlas” motif: one route map hero, a four-stop recommendation rail,
and compact route legends. This encodes real topology rather than adding decorative cards. The
picker repeats the same route language in a denser dialog. At narrow widths, intent filters and
recommendations become horizontal rails so a real model reaches the first viewport instead of six
stacked filters consuming the screen.
