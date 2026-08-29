"""One-time, idempotent migration from the 2023 flat-file application."""

from .legacy import (
    LEGACY_IMPORT_FORMAT_VERSION,
    InMemoryMigrationSink,
    LegacyImporter,
    MigrationSink,
)
from .models import LegacyRecord, MigrationReport
from .product_sink import (
    IMPORTER_VERSION,
    PersistedMigration,
    PersistedMigrationDecision,
    ProductMigrationSink,
)
from .service import LegacyMigrationService, LegacyMigrationState, LegacyMigrationStateName

__all__ = [
    "IMPORTER_VERSION",
    "LEGACY_IMPORT_FORMAT_VERSION",
    "InMemoryMigrationSink",
    "LegacyImporter",
    "LegacyMigrationService",
    "LegacyMigrationState",
    "LegacyMigrationStateName",
    "LegacyRecord",
    "MigrationReport",
    "MigrationSink",
    "PersistedMigration",
    "PersistedMigrationDecision",
    "ProductMigrationSink",
]
