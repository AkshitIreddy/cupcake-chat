# CUPCAKEAGI runtime

This package is the authoritative local product runtime for CUPCAKEAGI 2.0. It owns stable product
contracts, the encrypted product database, immutable conversation and artifact graphs,
content-addressed encrypted objects, the private framed protocol, and portable integrity-checked
backups.

Provider adapters, memory policy, ingestion workers, tools, and durable task workflows integrate
with these interfaces but remain separate subsystems.

## Security defaults

- Production callers should construct `DatabaseConfig` with `require_sqlcipher=True` and supply the
  key obtained from the native broker.
- Plain SQLite is supported only when `require_sqlcipher=False`, primarily for hermetic tests and
  developer fixtures. Merely issuing `PRAGMA key` to regular SQLite is not treated as encryption.
- Object bytes are encrypted with AES-256-GCM. Object identifiers are SHA-256 digests of plaintext,
  enabling deterministic integrity checks and deduplication without placing plaintext in filenames.
- Protocol frames are length bounded, canonically encoded, and authenticated with HMAC-SHA256.
  Sequence tracking rejects duplicates and reordering.

## Development

```bash
python -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/pytest
```

The schema is migrated transactionally on open. DBOS owns a separate checkpoint database; runtime
rows contain only durable task references and event lineage, never DBOS-native serialized objects.

## Retrieval accelerator

`SearchIndex` is the always-available, project-scoped FTS5 baseline. Semantic vectors are optional
derived data in the same SQLCipher connection and never replace product records, citations, or
lexical results. Integrations construct a `SemanticVectorIndex(connection, provider)`, pass it as
`SearchIndex(connection, async_semantic_index=semantic)`, asynchronously enrich with
`enrich_documents`, `enrich_in_background`, or `rebuild`, then call `search_async`. The SQL
project/source filters run before semantic scoring.

Production embedding adapters implement `EmbeddingProvider`; local providers need no outbound
approval, while cloud providers require a matching `CloudEmbeddingDisclosure` for every project
before document or query text is sent. `DeterministicEmbeddingProvider` is a network-free fixture,
not a production semantic model.

The 100,000-record FTS budget is an opt-in hardware benchmark so ordinary CI is not timing-flaky:

```powershell
$env:CUPCAKE_RUN_PERF = "1"
python -m pytest tests/retrieval/test_fts_performance.py -s
```

### NVIDIA NIM retrieval

NVIDIA hosted retrieval is optional and catalog-driven. The embedding adapter uses
`https://integrate.api.nvidia.com/v1/embeddings`, sends indexed documents as `input_type: passage`,
and sends searches as `input_type: query`. Rerank models use a versioned `cupcake.rerank.v1`
interface and an allowlisted NVIDIA retrieval endpoint supplied by current catalog metadata; the
runtime does not assume any specific model remains free or available.

Both adapters require an exact project/provider/model disclosure before an outbound request. Their
transport receives only the broker vault account `provider.nvidia-nim.api-key`, allowing the Rust
broker to attach the credential without persisting or returning it to Python or the renderer.
Recorded fixtures cover normal validation; ordinary development and CI do not call NVIDIA.
