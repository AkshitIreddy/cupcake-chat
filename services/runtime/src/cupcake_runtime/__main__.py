"""Packaged CUPCAKEAGI runtime entry point."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from types import TracebackType
from typing import Any

_DATABASE_FAILURE_MESSAGES = {
    "database-busy": "runtime database is busy",
    "database-not-writable": "runtime database is not writable",
    "database-integrity": "runtime database could not be authenticated or is damaged",
    "database-error": "runtime database could not be opened",
}


def runtime_failure_diagnostic(exc: Exception) -> dict[str, Any]:
    """Return a bounded, secret-free startup diagnostic for the broker log."""

    detail = "runtime startup or protocol failure"
    diagnostic: dict[str, Any] = {
        "level": "error",
        "component": "runtime",
        "errorType": type(exc).__name__,
        "message": detail,
    }
    if type(exc).__name__ == "DesktopProtocolError":
        diagnostic["message"] = f"runtime protocol failure: {exc}"
        return diagnostic
    if _is_database_error(exc):
        database_error = str(getattr(exc, "sqlite_errorname", "") or "").upper()
        message = str(exc).lower()
        if database_error.startswith(("SQLITE_BUSY", "SQLITE_LOCKED")) or any(
            marker in message for marker in ("busy", "locked")
        ):
            category = "database-busy"
        elif database_error.startswith(("SQLITE_READONLY", "SQLITE_PERM")) or any(
            marker in message for marker in ("readonly", "read-only", "permission")
        ):
            category = "database-not-writable"
        elif database_error.startswith(("SQLITE_NOTADB", "SQLITE_CORRUPT")) or any(
            marker in message for marker in ("not a database", "malformed", "corrupt")
        ):
            category = "database-integrity"
        else:
            category = "database-error"
        diagnostic["message"] = _DATABASE_FAILURE_MESSAGES[category]
        diagnostic["databaseFailure"] = category
        operation = _traceback_operation(exc.__traceback__)
        if operation:
            diagnostic["operation"] = operation
    return diagnostic


def _is_database_error(exc: Exception) -> bool:
    if isinstance(exc, sqlite3.DatabaseError):
        return True
    module = type(exc).__module__
    return module.startswith("sqlcipher3") and any(
        base.__name__ in {"DatabaseError", "OperationalError"} for base in type(exc).__mro__
    )


def _traceback_operation(traceback: TracebackType | None) -> str | None:
    operation = None
    while traceback is not None:
        candidate = traceback.tb_frame.f_code.co_name
        if candidate not in {"main", "<module>"}:
            operation = candidate
        traceback = traceback.tb_next
    return operation


def packaged_provider_load_check() -> dict[str, Any]:
    """Construct retained provider clients and Pydantic models without network access."""

    from cupcake_runtime.agent_engine import PydanticModelFactory
    from cupcake_runtime.providers import ProviderRegistry
    from cupcake_runtime.providers.base import ProviderConfig
    from cupcake_runtime.providers.onboarding import create_onboarding_client
    from cupcake_runtime.providers.types import CanonicalMessage, ModelRequest

    registry = ProviderRegistry()
    factory = PydanticModelFactory()
    providers: dict[str, dict[str, Any]] = {}
    for provider in ("openai", "anthropic", "google", "xai", "mistral", "cohere"):
        descriptor = registry.catalog.list(provider=provider)[0]
        config = ProviderConfig(api_key="provider-load-placeholder")
        try:
            client = create_onboarding_client(provider, config)
            model = factory.build(
                descriptor,
                config,
                ModelRequest(
                    descriptor.id,
                    (CanonicalMessage(role="user", content="provider load check"),),
                ),
            )
            providers[provider] = {
                "ok": True,
                "clientType": type(client).__name__,
                "modelType": type(model).__name__,
            }
        except Exception as exc:
            providers[provider] = {"ok": False, "errorType": type(exc).__name__}
    return {"ok": all(item["ok"] for item in providers.values()), "providers": providers}


def _install_frozen_metadata_fallback() -> None:
    """Keep import-time version modules working inside a one-file bundle.

    A few optional provider packages ask ``importlib.metadata.version`` during
    import and do not catch a missing dist-info directory. PyInstaller embeds
    the code but can omit that metadata even when the dependency is present.
    Development runs retain normal metadata semantics; only the locked frozen
    build gets the conservative package-version fallback.
    """
    if not getattr(sys, "frozen", False):
        return
    from importlib import metadata

    original = metadata.version

    def packaged_version(name: str) -> str:
        try:
            return original(name)
        except metadata.PackageNotFoundError:
            return {
                "dbos": "2.31.0",
                "cohere": "0.0.0",
                "latex2mathml": "0.0.0",
            }.get(name, "0.0.0")

    metadata.version = packaged_version


def main() -> int:
    _install_frozen_metadata_fallback()
    parser = argparse.ArgumentParser(prog="cupcake-runtime")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--stdio", action="store_true", help="run the authenticated desktop pipe")
    modes.add_argument(
        "--document-worker",
        action="store_true",
        help="run one isolated structured-document request",
    )
    modes.add_argument(
        "--sandbox-python-worker",
        action="store_true",
        help="run one isolated staged Python request",
    )
    modes.add_argument("--provider-load-check", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--stage-root")
    parser.add_argument("--worker-transport", choices=("stdio", "staged"))
    args = parser.parse_args()
    if args.provider_load_check:
        if args.stage_root or args.worker_transport:
            parser.error("--provider-load-check does not accept worker options")
        result = packaged_provider_load_check()
        print(json.dumps(result, sort_keys=True), flush=True)
        return 0 if result["ok"] else 1
    if args.document_worker:
        if not args.stage_root:
            parser.error("--document-worker requires --stage-root")
        # Deliberately import only the narrow worker module in this mode. Product
        # storage, providers, DBOS, and desktop runtime setup never execute in an
        # untrusted-document AppContainer.
        from cupcake_runtime.ingestion.document_worker import main as worker_main

        return worker_main(
            (
                "--stage-root",
                args.stage_root,
                "--worker-transport",
                args.worker_transport or "staged",
            )
        )
    if args.sandbox_python_worker:
        if not args.stage_root:
            parser.error("--sandbox-python-worker requires --stage-root")
        if args.worker_transport:
            parser.error("--worker-transport is valid only with --document-worker")
        # This fixed packaged entry point reads only immutable stage objects and
        # does not import product storage, providers, DBOS, or the desktop loop.
        from cupcake_runtime.ingestion.python_worker import main as python_worker_main

        return python_worker_main(("--stage-root", args.stage_root))
    if args.worker_transport:
        parser.error("--worker-transport is valid only with --document-worker")
    if args.stage_root:
        parser.error("--stage-root is valid only with an isolated worker mode")
    try:
        # Keep the broad product runtime import out of isolated worker modes.
        from cupcake_runtime.desktop_protocol import DesktopRuntimeServer

        DesktopRuntimeServer.from_environment().run()
        return 0
    except Exception as exc:
        print(
            json.dumps(runtime_failure_diagnostic(exc), sort_keys=True),
            file=sys.stderr,
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
