from __future__ import annotations

import sqlite3

import sqlcipher3

from cupcake_runtime.__main__ import runtime_failure_diagnostic


def _diagnostic_for(error: Exception) -> dict[str, object]:
    try:
        raise error
    except Exception as caught:
        return runtime_failure_diagnostic(caught)


def test_runtime_database_diagnostic_is_actionable_and_secret_free() -> None:
    diagnostic = _diagnostic_for(sqlite3.OperationalError("database is locked"))

    assert diagnostic == {
        "level": "error",
        "component": "runtime",
        "errorType": "OperationalError",
        "message": "runtime database is busy",
        "databaseFailure": "database-busy",
        "operation": "_diagnostic_for",
    }


def test_runtime_database_diagnostic_does_not_echo_paths() -> None:
    diagnostic = _diagnostic_for(
        sqlite3.DatabaseError("file C:/Users/owner/private/cupcake.db is not a database")
    )

    assert diagnostic["message"] == "runtime database could not be authenticated or is damaged"
    assert diagnostic["databaseFailure"] == "database-integrity"
    assert "owner" not in str(diagnostic)


def test_sqlcipher_database_errors_use_the_same_safe_categories() -> None:
    diagnostic = _diagnostic_for(sqlcipher3.DatabaseError("database is read-only"))

    assert diagnostic["message"] == "runtime database is not writable"
    assert diagnostic["databaseFailure"] == "database-not-writable"
    assert "read-only" not in str(diagnostic)
