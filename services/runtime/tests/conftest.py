from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from cupcake_runtime.storage.database import Database, DatabaseConfig
from cupcake_runtime.storage.repositories import ProductRepository


@pytest.fixture
def database(tmp_path: Path) -> Iterator[Database]:
    instance = Database(DatabaseConfig(path=tmp_path / "product.sqlite", require_sqlcipher=False))
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture
def repository(database: Database) -> ProductRepository:
    return ProductRepository(database)
