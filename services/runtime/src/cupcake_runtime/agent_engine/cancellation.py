"""Thread-safe cancellation handle for one agent run."""

from __future__ import annotations

from pydantic_ai import CancellationToken


class AgentCancellation:
    """A single-use cancellation handle safe to call from Electron routing threads."""

    def __init__(self) -> None:
        self._token = CancellationToken()

    @property
    def cancelled(self) -> bool:
        return self._token.cancelled

    def cancel(self) -> None:
        self._token.cancel()

    @property
    def pydantic_token(self) -> CancellationToken:
        """Internal Pydantic token; application callers should use :meth:`cancel`."""

        return self._token

