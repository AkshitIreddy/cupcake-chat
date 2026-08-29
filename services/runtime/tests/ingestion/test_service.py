from __future__ import annotations

import os
import tempfile
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path

from cupcake_runtime.ingestion import (
    IngestionLimits,
    IngestionService,
    LimitExceededError,
    UnsafeSourceError,
)


class IngestionServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.service = IngestionService()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_archive_traversal_is_rejected_without_extraction(self) -> None:
        archive = self.root / "unsafe.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("../escape.txt", "must not escape")
        with self.assertRaises(UnsafeSourceError):
            self.service.ingest_path(project_id="alpha", path=archive, granted_root=self.root)
        self.assertFalse((self.root.parent / "escape.txt").exists())

    def test_archive_member_has_stable_citation_locator(self) -> None:
        archive = self.root / "safe.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("docs/readme.md", "first line\nberry citation\n")
        result = self.service.ingest_path(project_id="alpha", path=archive, granted_root=self.root)
        self.assertEqual(result.chunks[0].locator.archive_member, "docs/readme.md")
        self.assertEqual(result.chunks[0].locator.path, "safe.zip")
        self.assertEqual(result.chunks[0].locator.line_start, 1)

    @unittest.skipUnless(hasattr(os, "symlink"), "symbolic links unavailable")
    def test_repository_skips_symlinks_and_direct_symlink_is_rejected(self) -> None:
        repository = self.root / "repository"
        repository.mkdir()
        (repository / "real.py").write_text("print('safe')\n", encoding="utf-8")
        outside = self.root / "outside.txt"
        outside.write_text("private", encoding="utf-8")
        link = repository / "linked.txt"
        try:
            link.symlink_to(outside)
        except OSError as exc:
            self.skipTest(f"symbolic links unavailable: {exc}")

        result = self.service.ingest_repository(project_id="alpha", root=repository)
        self.assertEqual([chunk.title for chunk in result.chunks], ["real.py"])
        self.assertTrue(any("symbolic link" in warning for warning in result.warnings))
        with self.assertRaises(UnsafeSourceError):
            self.service.ingest_path(project_id="alpha", path=link, granted_root=repository)

    def test_native_code_spreadsheet_and_media_locators_remain_structured(self) -> None:
        code = self.root / "example.py"
        code.write_text("first = 1\nsecond = 2\n", encoding="utf-8")
        code_result = self.service.ingest_path(
            project_id="alpha", path=code, granted_root=self.root
        )
        self.assertEqual(code_result.chunks[0].locator.line_start, 1)
        self.assertEqual(code_result.chunks[0].locator.line_end, 2)

        sheet = self.root / "table.csv"
        sheet.write_text("name,value\nberry,3\n", encoding="utf-8")
        sheet_result = self.service.ingest_path(
            project_id="alpha", path=sheet, granted_root=self.root
        )
        self.assertEqual(sheet_result.chunks[0].locator.sheet, "Sheet1")
        self.assertEqual(sheet_result.chunks[0].locator.cell_range, "A1:B2")

        media = self.root / "image.png"
        media.write_bytes(b"not-decoded-by-the-native-metadata-parser")
        media_result = self.service.ingest_path(
            project_id="alpha", path=media, granted_root=self.root
        )
        self.assertEqual(media_result.chunks[0].locator.timestamp_start_ms, 0)
        self.assertEqual(media_result.metadata["extraction"], "metadata-only")

    def test_native_pdf_page_limit_is_checked_before_extraction(self) -> None:
        from pypdf import PdfWriter

        pdf = self.root / "many-pages.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=72, height=72)
        writer.add_blank_page(width=72, height=72)
        with pdf.open("wb") as output:
            writer.write(output)
        service = IngestionService(limits=replace(IngestionLimits(), max_document_pages=1))
        with self.assertRaises(LimitExceededError):
            service.ingest_path(project_id="alpha", path=pdf, granted_root=self.root)

    def test_native_spreadsheet_row_limit_is_checked(self) -> None:
        sheet = self.root / "large.csv"
        sheet.write_text("one\ntwo\nthree\n", encoding="utf-8")
        service = IngestionService(limits=replace(IngestionLimits(), max_document_entries=2))
        with self.assertRaises(LimitExceededError):
            service.ingest_path(project_id="alpha", path=sheet, granted_root=self.root)


if __name__ == "__main__":
    unittest.main()
