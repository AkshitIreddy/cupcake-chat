from __future__ import annotations

from datetime import UTC, datetime, timedelta

from cupcake_runtime.observability import (
    DeveloperTrace,
    DeveloperTraceStore,
    TraceKind,
    TraceRecorder,
    TraceRedactor,
    new_span_id,
    new_trace_id,
)


def test_redactor_removes_secrets_paths_and_private_reasoning() -> None:
    result = TraceRedactor().redact(
        {
            "api_key": "sk-super-secret-key",
            "nested": {"authorization": "Bearer abcdefghijklmnop"},
            "message": "Read /home/alice/private/project.txt with token=letmein",
            "provider_error": "NVIDIA rejected nvapi-synthetic-redaction-canary-123456",
            "chain_of_thought": "private scratch work",
            "bytes": b"secret bytes",
        }
    )
    serialized = repr(result)
    assert "super-secret" not in serialized
    assert "abcdefghijklmnop" not in serialized
    assert "/home/alice" not in serialized
    assert "private scratch work" not in serialized
    assert "synthetic-redaction-canary" not in serialized
    assert result["chain_of_thought"] == "[PRIVATE_REASONING_OMITTED]"
    assert result["bytes"] == "[BYTES:12]"


def test_trace_store_redacts_before_persisting_and_uses_otel_ids(tmp_path) -> None:
    store = DeveloperTraceStore(str(tmp_path / "traces.sqlite"))
    recorder = TraceRecorder(store)
    saved = recorder.record(
        "run-1",
        TraceKind.TOOL,
        "provider.call",
        {"token": "secret", "latency_ms": 12, "path": "C:\\Users\\Alice\\private.txt"},
    )
    loaded = store.list_run("run-1")[0]

    assert len(saved.trace_id) == 32
    assert len(saved.span_id) == 16
    assert loaded.payload["token"] == "[REDACTED]"
    assert "Alice" not in loaded.payload["path"]
    assert loaded.payload["latency_ms"] == 12


def test_default_retention_is_thirty_days_and_expired_rows_are_purged(tmp_path) -> None:
    store = DeveloperTraceStore(str(tmp_path / "traces.sqlite"))
    now = datetime.now(UTC)
    normal = store.record(
        DeveloperTrace(new_trace_id(), new_span_id(), "run-1", TraceKind.RUN, "normal", {})
    )
    store.record(
        DeveloperTrace(
            new_trace_id(),
            new_span_id(),
            "run-1",
            TraceKind.FAILURE,
            "expired",
            {},
            created_at=now - timedelta(days=2),
            expires_at=now - timedelta(days=1),
        )
    )

    assert normal.expires_at is not None
    assert normal.expires_at - normal.created_at == timedelta(days=30)
    assert [trace.name for trace in store.list_run("run-1")] == ["normal"]
    assert store.purge_expired(now=now) == 1
    assert [trace.name for trace in store.list_run("run-1")] == ["normal"]


def test_caller_cannot_extend_trace_beyond_retention_policy(tmp_path) -> None:
    store = DeveloperTraceStore(str(tmp_path / "traces.sqlite"), retention_days=30)
    now = datetime.now(UTC)
    saved = store.record(
        DeveloperTrace(
            new_trace_id(),
            new_span_id(),
            "run-1",
            TraceKind.RUN,
            "bounded",
            {},
            created_at=now,
            expires_at=now + timedelta(days=365),
        )
    )
    assert saved.expires_at == now + timedelta(days=30)


def test_trace_span_is_idempotent_but_cannot_be_reused(tmp_path) -> None:
    store = DeveloperTraceStore(str(tmp_path / "traces.sqlite"))
    trace = DeveloperTrace(new_trace_id(), new_span_id(), "run-1", TraceKind.RUN, "start", {"x": 1})
    assert store.record(trace).span_id == trace.span_id
    assert store.record(trace).span_id == trace.span_id

    changed = DeveloperTrace(
        trace.trace_id,
        trace.span_id,
        "run-1",
        TraceKind.RUN,
        "start",
        {"x": 2},
    )
    try:
        store.record(changed)
    except ValueError as exc:
        assert "reused" in str(exc)
    else:
        raise AssertionError("changed span content must be rejected")
