from __future__ import annotations

import json
import os
import stat
import struct
import subprocess
import sys
import time
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from cupcake_runtime.ingestion import (
    BrokerSandboxTransport,
    DoclingAdapter,
    IngestionLimits,
    LocalTestSubprocessTransport,
    NetworkPolicy,
    SourceLocator,
    UnsupportedFormatError,
    WorkerFailureError,
    WorkerIsolation,
    WorkerProtocolError,
)
from cupcake_runtime.ingestion.worker_client import (
    DocumentWorkerLaunchSpec,
    DocumentWorkerTransport,
)
from cupcake_runtime.ingestion.worker_protocol import (
    PROTOCOL_VERSION,
    WorkerDocument,
    WorkerEntry,
    WorkerResponseKind,
    decode_single_frame,
    encode_document,
    encode_frame,
    parse_request,
    sha256_hex,
)


def _odt(path: Path, paragraphs: tuple[str, ...] = ("Hello cupcake",)) -> None:
    rendered = "".join(f"<text:p>{paragraph}</text:p>" for paragraph in paragraphs)
    content = (
        '<?xml version="1.0"?>'
        '<office:document-content xmlns:office="urn:oasis:names:tc:'
        'opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:'
        'opendocument:xmlns:text:1.0"><office:body><office:text>'
        f"{rendered}</office:text></office:body></office:document-content>"
    )
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("content.xml", content)


class _RecordingBroker:
    def __init__(self, *, tamper_digest: bool = False, forge_identity: bool = False) -> None:
        self.spec: DocumentWorkerLaunchSpec | None = None
        self.tamper_digest = tamper_digest
        self.forge_identity = forge_identity

    def __call__(self, spec: DocumentWorkerLaunchSpec, frame: bytes) -> bytes:
        self.spec = spec
        if not frame:
            request_path = next(
                Path(path) for path in spec.read_paths if path.endswith("document-request.frame")
            )
            frame = request_path.read_bytes()
        request = parse_request(decode_single_frame(frame))
        staged_input = Path(spec.read_paths[0])
        assert stat.S_IMODE(staged_input.stat().st_mode) & stat.S_IWUSR == 0
        document = WorkerDocument(
            entries=(
                WorkerEntry(
                    "Structured result",
                    SourceLocator(path=request.source_name, page=1, metadata={"adapter": "fake"}),
                ),
            ),
            warnings=(),
            metadata={"network_access": False},
        )
        output = encode_document(document)
        output_path = Path(spec.write_paths[0])
        output_path.write_bytes(output)
        os.chmod(output_path, stat.S_IRUSR)
        return encode_frame(
            {
                "version": PROTOCOL_VERSION,
                "kind": WorkerResponseKind.COMPLETE,
                "request_id": "forged-request-000"
                if self.forge_identity
                else request.request_id,
                "stage_token": request.stage_token,
                "result": {
                    "output_name": request.output_name,
                    "output_size": len(output),
                    "output_sha256": "0" * 64 if self.tamper_digest else sha256_hex(output),
                    "entry_count": 1,
                    "page_count": 1,
                },
            }
        )


class _TamperingTransport(DocumentWorkerTransport):
    @property
    def available(self) -> bool:
        return True

    @property
    def isolation(self) -> WorkerIsolation:
        return WorkerIsolation.WINDOWS_APPCONTAINER_NO_NETWORK

    def invoke(self, spec: DocumentWorkerLaunchSpec, request_frame: bytes) -> bytes:
        staged_input = Path(spec.read_paths[0])
        os.chmod(staged_input, stat.S_IRUSR | stat.S_IWUSR)
        original = staged_input.read_bytes()
        staged_input.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        local = LocalTestSubprocessTransport()
        return local.invoke(spec, request_frame)


class _StagedLocalTransport(DocumentWorkerTransport):
    @property
    def available(self) -> bool:
        return True

    @property
    def isolation(self) -> WorkerIsolation:
        # Test double for the broker: it exercises the staged EOF-stdio shape.
        return WorkerIsolation.WINDOWS_APPCONTAINER_NO_NETWORK

    def invoke(self, spec: DocumentWorkerLaunchSpec, request_frame: bytes) -> bytes:
        assert request_frame == b""
        assert spec.stdin_protocol == "none"
        assert spec.stdout_protocol == "none"
        assert any(path.endswith("document-request.frame") for path in spec.read_paths)
        assert any(path.endswith("document-response.frame") for path in spec.write_paths)
        process = subprocess.run(
            (spec.executable, *spec.arguments),
            cwd=spec.working_directory,
            env=dict(spec.environment),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            timeout=spec.timeout_seconds,
        )
        assert process.returncode == 0, process.stderr.decode(errors="replace")
        assert process.stdout == b""
        return b""


def test_default_adapter_is_fail_closed_without_os_sandbox(tmp_path: Path) -> None:
    source = tmp_path / "source.odt"
    _odt(source)
    adapter = DoclingAdapter()
    assert adapter.available is False
    with pytest.raises(UnsupportedFormatError, match="network-denied Windows sandbox"):
        adapter.convert(source)


def test_unenforced_child_requires_an_explicit_test_opt_in(tmp_path: Path) -> None:
    source = tmp_path / "source.odt"
    _odt(source)
    transport = LocalTestSubprocessTransport()
    adapter = DoclingAdapter(transport=transport)
    assert adapter.available is False
    with pytest.raises(UnsupportedFormatError):
        adapter.convert(source)


def test_real_worker_parses_odt_out_of_process_with_stable_locators(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.odt"
    _odt(source, ("First paragraph", "Second paragraph"))
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-reach-the-worker")
    adapter = DoclingAdapter(
        transport=LocalTestSubprocessTransport(), allow_unenforced_for_tests=True
    )
    converted = adapter.convert(source)
    assert [text for text, _locator in converted] == ["First paragraph", "Second paragraph"]
    assert [locator.path for _text, locator in converted] == ["source.odt", "source.odt"]
    assert [locator.metadata["paragraph"] for _text, locator in converted] == [1, 2]


def test_real_worker_supports_broker_staged_control_with_eof_stdio(tmp_path: Path) -> None:
    source = tmp_path / "source.odt"
    _odt(source, ("Staged control",))
    adapter = DoclingAdapter(transport=_StagedLocalTransport())
    assert adapter.convert(source)[0][0] == "Staged control"


def test_broker_launch_spec_is_appcontainer_network_denied_and_credential_free(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.odt"
    _odt(source)
    monkeypatch.setenv("COHERE_API_KEY", "do-not-inherit")
    broker = _RecordingBroker()
    adapter = DoclingAdapter(transport=BrokerSandboxTransport(broker))
    assert adapter.convert(source)[0][0] == "Structured result"
    assert broker.spec is not None
    assert broker.spec.windows.app_container is True
    assert broker.spec.windows.capabilities == ()
    assert broker.spec.windows.network is NetworkPolicy.DENY
    assert broker.spec.windows.active_process_limit == 1
    assert broker.spec.windows.child_processes is False
    assert broker.spec.windows.job_kill_on_close is True
    assert broker.spec.read_paths != broker.spec.write_paths
    environment = dict(broker.spec.environment)
    assert "COHERE_API_KEY" not in environment
    assert "PATH" not in environment
    assert environment["NO_PROXY"] == "*"


@pytest.mark.parametrize(
    "transport,match",
    [
        (BrokerSandboxTransport(_RecordingBroker(tamper_digest=True)), "digest"),
        (BrokerSandboxTransport(_RecordingBroker(forge_identity=True)), "identity"),
    ],
)
def test_tampered_staged_result_or_forged_response_is_rejected(
    tmp_path: Path, transport: DocumentWorkerTransport, match: str
) -> None:
    source = tmp_path / "source.odt"
    _odt(source)
    with pytest.raises(WorkerProtocolError, match=match):
        DoclingAdapter(transport=transport).convert(source)


def test_worker_rechecks_the_immutable_input_digest(tmp_path: Path) -> None:
    source = tmp_path / "source.odt"
    _odt(source)
    with pytest.raises(WorkerFailureError, match="digest"):
        DoclingAdapter(transport=_TamperingTransport()).convert(source)


def test_worker_enforces_entry_limit_before_returning_output(tmp_path: Path) -> None:
    source = tmp_path / "source.odt"
    _odt(source, ("one", "two", "three"))
    limits = replace(IngestionLimits(), max_document_entries=2)
    adapter = DoclingAdapter(
        transport=LocalTestSubprocessTransport(),
        limits=limits,
        allow_unenforced_for_tests=True,
    )
    with pytest.raises(WorkerFailureError) as captured:
        adapter.convert(source)
    assert captured.value.code == "limit_exceeded"


def test_worker_rejects_xml_entities(tmp_path: Path) -> None:
    source = tmp_path / "source.odt"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr(
            "content.xml",
            '<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]>'
            '<office:document-content xmlns:office="urn:oasis:names:tc:'
            'opendocument:xmlns:office:1.0"/>',
        )
    adapter = DoclingAdapter(
        transport=LocalTestSubprocessTransport(), allow_unenforced_for_tests=True
    )
    with pytest.raises(WorkerFailureError, match="prohibited DTD"):
        adapter.convert(source)


def test_parent_kills_a_worker_that_exceeds_its_deadline(tmp_path: Path) -> None:
    source = tmp_path / "source.odt"
    _odt(source)
    limits = replace(IngestionLimits(), document_worker_timeout_seconds=1)
    sleeping_transport = LocalTestSubprocessTransport(
        command=(sys.executable, "-I", "-c", "import time; time.sleep(10)")
    )
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        DoclingAdapter(
            transport=sleeping_transport,
            limits=limits,
            allow_unenforced_for_tests=True,
        ).convert(source)
    assert time.monotonic() - started < 5


def test_control_protocol_rejects_unknown_duplicate_oversized_and_trailing_data() -> None:
    valid = {
        "version": PROTOCOL_VERSION,
        "kind": "document.parse",
        "request_id": "a" * 32,
        "stage_token": "b" * 32,
        "payload": {
            "input_name": f"{'c' * 32}.input",
            "output_name": f"{'d' * 32}.json",
            "source_name": "source.odt",
            "source_suffix": ".odt",
            "input_size": 1,
            "input_sha256": "e" * 64,
            "limits": {
                "max_input_bytes": 1,
                "max_output_bytes": 1,
                "max_text_characters": 1,
                "max_pages": 1,
                "max_entries": 1,
                "deadline_unix_ms": 1,
            },
        },
    }
    unknown = {**valid, "surprise": True}
    with pytest.raises(WorkerProtocolError, match="unknown"):
        parse_request(decode_single_frame(encode_frame(unknown)))
    duplicate = b'{"version":1,"version":1}'
    with pytest.raises(WorkerProtocolError, match="duplicate"):
        decode_single_frame(struct.pack(">I", len(duplicate)) + duplicate)
    with pytest.raises(WorkerProtocolError, match="invalid size"):
        decode_single_frame(struct.pack(">I", 2 * 1024 * 1024))
    with pytest.raises(WorkerProtocolError, match="exactly one"):
        decode_single_frame(encode_frame(valid) + b"extra")


def test_malformed_worker_request_never_discloses_environment_value(tmp_path: Path) -> None:
    secret = "highly-sensitive-provider-value"
    environment = {
        "CUPCAKE_DOCUMENT_WORKER": "1",
        "OPENAI_API_KEY": secret,
        "PYTHONIOENCODING": "utf-8",
    }
    command = (
        sys.executable,
        "-I",
        "-m",
        "cupcake_runtime.ingestion.document_worker",
        "--stage-root",
        str(tmp_path),
    )
    process = __import__("subprocess").run(
        command,
        input=struct.pack(">I", 2) + b"{}",
        stdout=__import__("subprocess").PIPE,
        stderr=__import__("subprocess").PIPE,
        env=environment,
        check=False,
        timeout=10,
    )
    combined = process.stdout + process.stderr
    assert secret.encode() not in combined
    response = decode_single_frame(process.stdout)
    assert response["kind"] == WorkerResponseKind.FAILED


def test_output_json_cannot_smuggle_duplicate_members() -> None:
    body = json.dumps({"version": 1, "entries": [], "warnings": [], "metadata": {}})
    duplicate = body[:-1] + ',"metadata":{}}'
    from cupcake_runtime.ingestion.worker_protocol import decode_document

    with pytest.raises(WorkerProtocolError, match="duplicate"):
        decode_document(duplicate.encode(), max_entries=1, max_characters=1)
