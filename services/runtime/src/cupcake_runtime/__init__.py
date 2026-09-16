"""CUPCAKEAGI's product-owned runtime foundation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from cupcake_runtime.domain.ids import new_id, uuid7
    from cupcake_runtime.storage.database import Database, DatabaseConfig
    from cupcake_runtime.storage.repositories import ProductRepository

__all__ = ["Database", "DatabaseConfig", "ProductRepository", "new_id", "uuid7"]
__version__ = "1.8.5"


def __getattr__(name: str) -> Any:
    """Keep the package root cheap for isolated packaged worker modes.

    Public compatibility exports remain available, but storage modules are not
    imported merely by resolving ``cupcake_runtime.__main__``.
    """
    if name in {"new_id", "uuid7"}:
        from cupcake_runtime.domain import ids

        return getattr(ids, name)
    if name in {"Database", "DatabaseConfig"}:
        from cupcake_runtime.storage import database

        return getattr(database, name)
    if name == "ProductRepository":
        from cupcake_runtime.storage.repositories import ProductRepository

        return ProductRepository
    raise AttributeError(name)
