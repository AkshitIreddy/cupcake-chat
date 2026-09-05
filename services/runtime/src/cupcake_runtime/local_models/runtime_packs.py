"""Verified, side-by-side installation of app-managed llama.cpp runtime packs."""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
import zipfile
from contextlib import suppress
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import TypeAdapter

from .catalog import sha256_file
from .types import (
    InstalledRuntimePack,
    RuntimeBackend,
    RuntimeCompanionArtifact,
    RuntimePackArtifact,
)

_JSON_OBJECT_ADAPTER = TypeAdapter(dict[str, Any])
_FILE_MANIFEST_ADAPTER = TypeAdapter(dict[str, str])


class RuntimePackError(RuntimeError):
    """A runtime pack could not be installed or activated safely."""


class RuntimePackIntegrityError(RuntimePackError):
    pass


class RuntimePackInUseError(RuntimePackError):
    pass


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)


def _safe_member(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    windows_reserved = {
        "con",
        "prn",
        "aux",
        "nul",
        *(f"com{number}" for number in range(1, 10)),
        *(f"lpt{number}" for number in range(1, 10)),
    }
    if (
        not name
        or name.startswith(("/", "\\"))
        or "\\" in name
        or any(character in name for character in '<>:"|?*\0')
        or path.is_absolute()
        or ".." in path.parts
        or any(
            not part
            or part.endswith((".", " "))
            or part.split(".", 1)[0].casefold() in windows_reserved
            for part in path.parts
        )
    ):
        raise RuntimePackIntegrityError(f"unsafe archive member: {name!r}")
    return path


class RuntimePackStore:
    """Install signed runtime packs without mutable symlinks or in-place upgrades.

    The outer archive digest is checked before parsing. Every extracted file is
    independently checked against the signed manifest. Installs land in a new
    immutable version/backend directory, then a tiny JSON pointer is replaced
    atomically. This works on Windows without administrator or developer-mode
    symlink privileges.
    """

    METADATA_NAME = ".cupcake-runtime.json"

    def __init__(self, root: Path):
        self.root = root
        self.versions = root / "versions"
        self.active_file = root / "active.json"

    def install(
        self,
        artifact: RuntimePackArtifact,
        archive: Path,
        *,
        companion_archives: dict[str, Path] | None = None,
    ) -> InstalledRuntimePack:
        destination = self._directory(artifact.version, artifact.backend)
        if destination.exists():
            installed = self._read_install(destination)
            if not self.verify_against_artifact(installed, artifact):
                raise RuntimePackIntegrityError(
                    "an incompatible or corrupt runtime already occupies this version"
                )
            return replace(
                self._with_active(installed, verify_integrity=False),
                integrity_verified=True,
            )

        self._verify_archive(artifact, archive)
        companions = companion_archives or {}
        expected_companions = {companion.id for companion in artifact.companions}
        if set(companions) != expected_companions:
            raise RuntimePackIntegrityError(
                "runtime companion archive set does not match signed catalog"
            )
        for companion in artifact.companions:
            self._verify_archive(companion, companions[companion.id])

        self.versions.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=".install-", dir=self.versions))
        try:
            self._extract_verified(artifact, archive, temporary, require_executable=True)
            for companion in artifact.companions:
                self._extract_verified(
                    companion,
                    companions[companion.id],
                    temporary,
                    require_executable=False,
                )
            metadata = {
                "id": artifact.id,
                "version": artifact.version,
                "backend": artifact.backend.value,
                "executable": artifact.executable,
                "source_revision": artifact.source_revision,
                "installed_at": datetime.now(UTC).isoformat(),
                "files": self._all_files(artifact),
            }
            _atomic_json(temporary / self.METADATA_NAME, metadata)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(temporary, destination)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        return self._with_active(self._read_install(destination))

    def import_verified_directory(
        self, artifact: RuntimePackArtifact, source: Path
    ) -> InstalledRuntimePack:
        """Seed a profile from the immutable runtime staged beside the app.

        This is the first-launch counterpart to ``install``: desktop packages
        already contain extracted files, so copying the ZIP too would waste
        space. Every source and destination file is checked against the same
        signed catalog before the atomic version-directory switch.
        """

        if not source.is_dir():
            raise FileNotFoundError(source)
        destination = self._directory(artifact.version, artifact.backend)
        if destination.exists():
            installed = self._read_install(destination)
            if installed.id != artifact.id or not self.verify(installed):
                raise RuntimePackIntegrityError(
                    "an incompatible or corrupt runtime already occupies this version"
                )
            return self._with_active(installed)
        self.versions.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=".import-", dir=self.versions))
        try:
            for relative, expected in self._all_files(artifact).items():
                member = _safe_member(relative)
                original = source.joinpath(*member.parts)
                if not original.is_file() or sha256_file(original).lower() != expected.lower():
                    raise RuntimePackIntegrityError(
                        f"packaged runtime member checksum mismatch: {relative}"
                    )
                target = temporary.joinpath(*member.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, target)
                if sha256_file(target).lower() != expected.lower():
                    raise RuntimePackIntegrityError(
                        f"imported runtime member checksum mismatch: {relative}"
                    )
            metadata = {
                "id": artifact.id,
                "version": artifact.version,
                "backend": artifact.backend.value,
                "executable": artifact.executable,
                "source_revision": artifact.source_revision,
                "installed_at": datetime.now(UTC).isoformat(),
                "files": self._all_files(artifact),
            }
            _atomic_json(temporary / self.METADATA_NAME, metadata)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(temporary, destination)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        return self._with_active(self._read_install(destination))

    def activate(self, version: str, backend: RuntimeBackend) -> InstalledRuntimePack:
        installed = self._read_install(self._directory(version, backend))
        if not self.verify(installed):
            raise RuntimePackIntegrityError("refusing to activate a corrupt runtime pack")
        _atomic_json(
            self.active_file,
            {
                "version": version,
                "backend": backend.value,
                "activated_at": datetime.now(UTC).isoformat(),
            },
        )
        return self._with_active(installed)

    def active(self, *, verify_integrity: bool = True) -> InstalledRuntimePack | None:
        try:
            value = json.loads(self.active_file.read_text(encoding="utf-8"))
            return self._with_active(
                self._read_install(
                    self._directory(str(value["version"]), RuntimeBackend(str(value["backend"])))
                ),
                verify_integrity=verify_integrity,
            )
        except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None

    def list(self, *, verify_integrity: bool = True) -> tuple[InstalledRuntimePack, ...]:
        packs: list[InstalledRuntimePack] = []
        if not self.versions.is_dir():
            return ()
        for metadata in sorted(self.versions.glob(f"*/*/{self.METADATA_NAME}")):
            try:
                packs.append(
                    self._with_active(
                        self._read_install(metadata.parent),
                        verify_integrity=verify_integrity,
                    )
                )
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
        return tuple(packs)

    def verify(self, installed: InstalledRuntimePack) -> bool:
        try:
            directory = Path(installed.directory).resolve(strict=True)
            if self.versions.resolve() not in directory.parents:
                return False
            metadata = _JSON_OBJECT_ADAPTER.validate_json(
                (directory / self.METADATA_NAME).read_text(encoding="utf-8")
            )
            files = _FILE_MANIFEST_ADAPTER.validate_python(metadata["files"])
            if not files:
                return False
            for relative, expected in files.items():
                member = _safe_member(str(relative))
                path = directory.joinpath(*member.parts)
                if not path.is_file() or sha256_file(path).lower() != str(expected).lower():
                    return False
            return True
        except (FileNotFoundError, OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return False

    def verify_against_artifact(
        self, installed: InstalledRuntimePack, artifact: RuntimePackArtifact
    ) -> bool:
        """Bind an installed receipt and every file to signed catalog metadata."""

        try:
            directory = Path(installed.directory).resolve(strict=True)
            if self.versions.resolve() not in directory.parents:
                return False
            metadata = _JSON_OBJECT_ADAPTER.validate_json(
                (directory / self.METADATA_NAME).read_text(encoding="utf-8")
            )
            files = _FILE_MANIFEST_ADAPTER.validate_python(metadata["files"])
            expected_files = self._all_files(artifact)
            if set(files) != set(expected_files) or any(
                files[path].lower() != digest.lower() for path, digest in expected_files.items()
            ):
                return False
            expected_executable = directory.joinpath(*_safe_member(artifact.executable).parts)
            if (
                installed.id != artifact.id
                or installed.version != artifact.version
                or installed.backend != artifact.backend
                or installed.source_revision != artifact.source_revision
                or Path(installed.executable) != expected_executable
                or metadata.get("id") != artifact.id
                or metadata.get("version") != artifact.version
                or metadata.get("backend") != artifact.backend.value
                or metadata.get("executable") != artifact.executable
                or metadata.get("source_revision") != artifact.source_revision
            ):
                return False
            return self.verify(installed)
        except (FileNotFoundError, OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return False

    def remove(
        self,
        version: str,
        backend: RuntimeBackend,
        *,
        allow_active: bool = False,
    ) -> None:
        target = self._directory(version, backend)
        active = self.active()
        if active and Path(active.directory) == target and not allow_active:
            raise RuntimePackInUseError("stop and deactivate the runtime before removing it")
        if active and Path(active.directory) == target:
            self.active_file.unlink(missing_ok=True)
        shutil.rmtree(target, ignore_errors=False)
        with suppress(OSError):
            target.parent.rmdir()

    def _directory(self, version: str, backend: RuntimeBackend) -> Path:
        if (
            not version
            or any(character in version for character in "/\\:")
            or version in {".", ".."}
        ):
            raise ValueError("unsafe runtime version")
        return self.versions / version / backend.value

    def _extract_verified(
        self,
        artifact: RuntimePackArtifact | RuntimeCompanionArtifact,
        archive: Path,
        temporary: Path,
        *,
        require_executable: bool,
    ) -> None:
        expected = {
            str(_safe_member(path)): digest.lower() for path, digest in artifact.files.items()
        }
        if len(expected) > 4096:
            raise RuntimePackIntegrityError("runtime manifest contains too many files")
        if len(expected) != len({path.casefold() for path in expected}):
            raise RuntimePackIntegrityError("runtime manifest contains case-colliding paths")
        seen: set[str] = set()
        seen_folded: set[str] = set()
        expanded_bytes = 0
        # A bounded expansion ratio prevents small signed-metadata mistakes from
        # becoming a multi-gigabyte disk exhaustion during install.
        maximum_expanded = min(
            max(artifact.size_bytes * 20, artifact.size_bytes + 512 * 1024 * 1024),
            4 * 1024 * 1024 * 1024,
        )
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                member = _safe_member(info.filename)
                name = str(member)
                unix_mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(unix_mode):
                    raise RuntimePackIntegrityError(
                        f"runtime archives may not contain symlinks: {name}"
                    )
                if info.is_dir():
                    continue
                if name not in expected:
                    raise RuntimePackIntegrityError(f"unsigned file in runtime archive: {name}")
                if name in seen:
                    raise RuntimePackIntegrityError(f"duplicate runtime archive member: {name}")
                if name.casefold() in seen_folded:
                    raise RuntimePackIntegrityError(
                        f"case-colliding runtime archive member: {name}"
                    )
                expanded_bytes += info.file_size
                if expanded_bytes > maximum_expanded:
                    raise RuntimePackIntegrityError("runtime archive exceeds safe expansion limit")
                target = temporary.joinpath(*member.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                if sha256_file(target).lower() != expected[name]:
                    raise RuntimePackIntegrityError(f"runtime member checksum mismatch: {name}")
                seen.add(name)
                seen_folded.add(name.casefold())
        missing = set(expected) - seen
        if missing:
            raise RuntimePackIntegrityError(
                f"runtime archive is missing signed files: {sorted(missing)!r}"
            )
        if (
            require_executable
            and isinstance(artifact, RuntimePackArtifact)
            and artifact.executable not in seen
        ):
            raise RuntimePackIntegrityError("runtime archive does not contain llama-server.exe")

    @staticmethod
    def _verify_archive(
        artifact: RuntimePackArtifact | RuntimeCompanionArtifact, archive: Path
    ) -> None:
        if not archive.is_file():
            raise FileNotFoundError(archive)
        if archive.stat().st_size != artifact.size_bytes:
            raise RuntimePackIntegrityError("runtime archive size does not match signed catalog")
        if sha256_file(archive).lower() != artifact.sha256.lower():
            raise RuntimePackIntegrityError(
                "runtime archive checksum does not match signed catalog"
            )

    @staticmethod
    def _all_files(artifact: RuntimePackArtifact) -> dict[str, str]:
        files = dict(artifact.files)
        for companion in artifact.companions:
            for path, digest in companion.files.items():
                if path.casefold() in {existing.casefold() for existing in files}:
                    raise RuntimePackIntegrityError(f"runtime file collision: {path}")
                files[path] = digest
        return files

    def _read_install(self, directory: Path) -> InstalledRuntimePack:
        value = _JSON_OBJECT_ADAPTER.validate_json(
            (directory / self.METADATA_NAME).read_text(encoding="utf-8")
        )
        executable = directory.joinpath(*_safe_member(str(value["executable"])).parts)
        return InstalledRuntimePack(
            id=str(value["id"]),
            version=str(value["version"]),
            backend=RuntimeBackend(str(value["backend"])),
            directory=str(directory),
            executable=str(executable),
            source_revision=str(value["source_revision"]),
            installed_at=str(value["installed_at"]),
            active=False,
            integrity_verified=False,
        )

    def _with_active(
        self, installed: InstalledRuntimePack, *, verify_integrity: bool = True
    ) -> InstalledRuntimePack:
        active_coordinate: tuple[str, RuntimeBackend] | None = None
        try:
            value = _JSON_OBJECT_ADAPTER.validate_json(self.active_file.read_text(encoding="utf-8"))
            active_coordinate = (str(value["version"]), RuntimeBackend(str(value["backend"])))
        except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass
        return replace(
            installed,
            active=active_coordinate == (installed.version, installed.backend),
            integrity_verified=self.verify(installed) if verify_integrity else False,
        )
