"""Packaged CUPCAKEAGI runtime entry point."""

from __future__ import annotations

import argparse
import json
import sys


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
    parser.add_argument("--stage-root")
    parser.add_argument("--worker-transport", choices=("stdio", "staged"))
    args = parser.parse_args()
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
        detail = "runtime startup or protocol failure"
        if type(exc).__name__ == "DesktopProtocolError":
            detail = f"runtime protocol failure: {exc}"
        print(
            json.dumps(
                {
                    "level": "error",
                    "component": "runtime",
                    "errorType": type(exc).__name__,
                    "message": detail,
                }
            ),
            file=sys.stderr,
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
