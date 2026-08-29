"""Fail-closed reader for broker-owned portable-backup manifests.

The Python runtime validates snapshot/object digests and the public envelope
metadata, but it never receives a backup passphrase. Profile-key wrap/unwrap is
performed only by the Rust broker after Windows Credential UI collects it.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
import stat
import zipfile
from collections import Counter
from datetime import datetime
from enum import StrEnum
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from cupcake_runtime.domain.errors import IntegrityViolation

PORTABLE_BACKUP_FORMAT = "cupcake-portable-backup"
PORTABLE_BACKUP_FORMAT_VERSION = 1
KEY_ENVELOPE_FORMAT = "cupcake-profile-key-envelope"
KEY_ENVELOPE_VERSION = 1
MANIFEST_PATH = "manifest.json"
NONPORTABLE_DPAPI_NOTICE = (
    "This backup is protected by Windows DPAPI for the current user and cannot be restored "
    "by another Windows user or on another computer."
)

_MANIFEST_LIMIT_BYTES = 1024 * 1024
_MAX_ENTRIES = 1_000_000
_HEX_256 = re.compile(r"[0-9a-f]{64}\Z")
_BASE64URL = re.compile(r"[A-Za-z0-9_-]+\Z")


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, populate_by_name=True)


class Argon2idDescriptor(_Contract):
    algorithm: Literal["argon2id"]
    version: Literal[19]
    memory_kib: int = Field(alias="memoryKiB", ge=32 * 1024, le=256 * 1024)
    iterations: int = Field(ge=2, le=8)
    parallelism: int = Field(ge=1, le=4)
    output_bytes: Literal[32] = Field(alias="outputBytes")
    salt_base64: str = Field(alias="saltBase64", min_length=1, max_length=128)

    @model_validator(mode="after")
    def valid_salt(self) -> Argon2idDescriptor:
        if len(_decode_base64url(self.salt_base64, "Argon2id salt")) != 16:
            raise ValueError("Argon2id salt must contain exactly 16 bytes")
        return self


class ProfileKeyEnvelope(_Contract):
    format: Literal["cupcake-profile-key-envelope"]
    format_version: Literal[1] = Field(alias="formatVersion")
    cipher: Literal["aes-256-gcm"]
    kdf: Argon2idDescriptor
    nonce_base64: str = Field(alias="nonceBase64", min_length=1, max_length=128)
    wrapped_key_base64: str = Field(alias="wrappedKeyBase64", min_length=1, max_length=256)
    aad_sha256: str = Field(alias="aadSha256", pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def valid_lengths(self) -> ProfileKeyEnvelope:
        if len(_decode_base64url(self.nonce_base64, "AES-GCM nonce")) != 12:
            raise ValueError("AES-GCM nonce must contain exactly 12 bytes")
        # RustCrypto's combined representation is 32-byte key ciphertext + 16-byte tag.
        if len(_decode_base64url(self.wrapped_key_base64, "wrapped profile key")) != 48:
            raise ValueError("wrapped profile key must contain exactly 48 bytes")
        return self


class PortablePassphraseProtection(_Contract):
    mode: Literal["passphrase-portable"]
    cross_user: Literal[True] = Field(alias="crossUser")
    key_envelope: ProfileKeyEnvelope = Field(alias="keyEnvelope")


class SameUserDpapiProtection(_Contract):
    mode: Literal["windows-dpapi-current-user"]
    cross_user: Literal[False] = Field(alias="crossUser")
    notice: Literal[
        "This backup is protected by Windows DPAPI for the current user and cannot be restored "
        "by another Windows user or on another computer."
    ]


BackupProtection = Annotated[
    PortablePassphraseProtection | SameUserDpapiProtection,
    Field(discriminator="mode"),
]


class BackupEntryRole(StrEnum):
    PRODUCT_DATABASE = "productDatabase"
    DBOS_DATABASE = "dbosDatabase"
    SECURITY_DATABASE = "securityDatabase"
    ENCRYPTED_OBJECT = "encryptedObject"


class PortableBackupEntry(_Contract):
    path: str = Field(min_length=1, max_length=4096)
    role: BackupEntryRole
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_size: int = Field(alias="byteSize", ge=0, le=2**63 - 1)
    object_id: str | None = Field(default=None, alias="objectId")

    @model_validator(mode="after")
    def safe_and_consistent(self) -> PortableBackupEntry:
        _validate_archive_path(self.path)
        if self.path == MANIFEST_PATH:
            raise ValueError("manifest path cannot also be a payload entry")
        if self.role is BackupEntryRole.ENCRYPTED_OBJECT:
            if self.object_id is None or _HEX_256.fullmatch(self.object_id) is None:
                raise ValueError("encrypted object entry requires a lowercase SHA-256 object id")
        elif self.object_id is not None:
            raise ValueError("database snapshot entry cannot have an object id")
        return self


class PortableBackupManifest(_Contract):
    format: Literal["cupcake-portable-backup"]
    format_version: Literal[1] = Field(alias="formatVersion")
    backup_id: UUID = Field(alias="backupId")
    product_version: str = Field(alias="productVersion", min_length=1, max_length=128)
    created_at: datetime = Field(alias="createdAt")
    protection: BackupProtection
    entries: tuple[PortableBackupEntry, ...]

    @model_validator(mode="after")
    def consistent_backup_set(self) -> PortableBackupManifest:
        if self.created_at.tzinfo is None or self.created_at.utcoffset() is None:
            raise ValueError("backup creation timestamp must include a UTC offset")
        if any(_is_control(character) for character in self.product_version):
            raise ValueError("product version contains a control character")
        if len(self.product_version.encode("utf-8")) > 128:
            raise ValueError("UTF-8 product version exceeds 128 bytes")
        if len(self.entries) > _MAX_ENTRIES:
            raise ValueError("backup contains too many manifest entries")
        paths = [entry.path for entry in self.entries]
        if len(paths) != len(set(paths)):
            raise ValueError("backup manifest paths must be unique")
        object_ids = [
            entry.object_id
            for entry in self.entries
            if entry.role is BackupEntryRole.ENCRYPTED_OBJECT
        ]
        if len(object_ids) != len(set(object_ids)):
            raise ValueError("backup manifest object ids must be unique")
        counts = Counter(entry.role for entry in self.entries)
        for role in (
            BackupEntryRole.PRODUCT_DATABASE,
            BackupEntryRole.DBOS_DATABASE,
            BackupEntryRole.SECURITY_DATABASE,
        ):
            if counts[role] != 1:
                raise ValueError(f"backup must contain exactly one {role.value} snapshot")
        if isinstance(self.protection, PortablePassphraseProtection):
            expected = hashlib.sha256(
                authenticated_metadata(self.backup_id, self.product_version)
            ).hexdigest()
            if not _constant_time_ascii_equal(expected, self.protection.key_envelope.aad_sha256):
                raise ValueError("key envelope authenticated-metadata digest is invalid")
        return self

    @property
    def is_cross_user_portable(self) -> bool:
        return isinstance(self.protection, PortablePassphraseProtection)


_MANIFEST_ADAPTER = TypeAdapter(PortableBackupManifest)


class PortableBackupInspection(_Contract):
    manifest: PortableBackupManifest
    verified_entries: int = Field(ge=3)
    total_bytes: int = Field(ge=0)


def authenticated_metadata(backup_id: UUID, product_version: str) -> bytes:
    """Build the stable binary AAD used by the Rust AES-GCM envelope."""
    encoded_version = product_version.encode("utf-8")
    return b"".join(
        (
            b"CUPCAKEAGI\0portable-backup-key-envelope\0v1\0",
            backup_id.bytes,
            len(encoded_version).to_bytes(4, byteorder="big"),
            encoded_version,
        )
    )


def validate_manifest_bytes(data: bytes) -> PortableBackupManifest:
    """Parse an exact v1 manifest with bounded input and no future-field tolerance."""
    if not data or len(data) > _MANIFEST_LIMIT_BYTES:
        raise IntegrityViolation("portable backup manifest size is invalid")
    try:
        return _MANIFEST_ADAPTER.validate_json(data)
    except (ValueError, TypeError) as exc:
        raise IntegrityViolation("portable backup manifest is invalid") from exc


def read_manifest(archive_path: Path) -> PortableBackupManifest:
    """Read only the bounded manifest from an archive; payloads are not extracted."""
    try:
        with zipfile.ZipFile(archive_path, mode="r") as archive:
            infos = archive.infolist()
            _validate_zip_directory(infos)
            try:
                manifest_info = archive.getinfo(MANIFEST_PATH)
            except KeyError as exc:
                raise IntegrityViolation("portable backup manifest is missing") from exc
            if manifest_info.file_size > _MANIFEST_LIMIT_BYTES:
                raise IntegrityViolation("portable backup manifest exceeds the 1 MiB limit")
            return validate_manifest_bytes(archive.read(manifest_info))
    except zipfile.BadZipFile as exc:
        raise IntegrityViolation("portable backup is not a valid ZIP archive") from exc


def inspect_archive(archive_path: Path) -> PortableBackupInspection:
    """Verify the manifest and every consistent snapshot/reachable-object digest."""
    try:
        with zipfile.ZipFile(archive_path, mode="r") as archive:
            infos = archive.infolist()
            _validate_zip_directory(infos)
            by_name = {info.filename: info for info in infos}
            try:
                manifest_info = by_name[MANIFEST_PATH]
            except KeyError as exc:
                raise IntegrityViolation("portable backup manifest is missing") from exc
            if manifest_info.file_size > _MANIFEST_LIMIT_BYTES:
                raise IntegrityViolation("portable backup manifest exceeds the 1 MiB limit")
            manifest = validate_manifest_bytes(archive.read(manifest_info))
            expected_names = {MANIFEST_PATH, *(entry.path for entry in manifest.entries)}
            if set(by_name) != expected_names:
                raise IntegrityViolation("portable backup payload set differs from its manifest")

            total_bytes = 0
            for entry in manifest.entries:
                info = by_name[entry.path]
                if info.file_size != entry.byte_size:
                    raise IntegrityViolation(f"backup size differs for {entry.path}")
                digest = hashlib.sha256()
                measured = 0
                with archive.open(info, mode="r") as source:
                    while chunk := source.read(1024 * 1024):
                        measured += len(chunk)
                        if measured > entry.byte_size:
                            raise IntegrityViolation(f"backup size differs for {entry.path}")
                        digest.update(chunk)
                if measured != entry.byte_size or not _constant_time_ascii_equal(
                    digest.hexdigest(), entry.sha256
                ):
                    raise IntegrityViolation(f"backup digest differs for {entry.path}")
                total_bytes += measured
            return PortableBackupInspection(
                manifest=manifest,
                verified_entries=len(manifest.entries),
                total_bytes=total_bytes,
            )
    except zipfile.BadZipFile as exc:
        raise IntegrityViolation("portable backup is not a valid ZIP archive") from exc


def _validate_zip_directory(infos: list[zipfile.ZipInfo]) -> None:
    names = [info.filename for info in infos]
    if len(names) != len(set(names)):
        raise IntegrityViolation("portable backup contains duplicate archive paths")
    for info in infos:
        try:
            _validate_archive_path(info.filename)
        except ValueError as exc:
            raise IntegrityViolation("portable backup contains an unsafe archive path") from exc
        if info.is_dir():
            raise IntegrityViolation("portable backup cannot contain directory entries")
        unix_mode = info.external_attr >> 16
        if unix_mode and stat.S_ISLNK(unix_mode):
            raise IntegrityViolation("portable backup cannot contain symbolic links")
        if info.flag_bits & 0x1:
            raise IntegrityViolation("ZIP-level encryption is not supported")


def _validate_archive_path(value: str) -> None:
    path = PurePosixPath(value)
    if (
        not value
        or "\\" in value
        or path.is_absolute()
        or ".." in path.parts
        or (path.parts and ":" in path.parts[0])
    ):
        raise ValueError("portable backup contains an unsafe archive path")


def _decode_base64url(value: str, label: str) -> bytes:
    if "=" in value or _BASE64URL.fullmatch(value) is None:
        raise ValueError(f"{label} is not unpadded base64url")
    padded = value + "=" * (-len(value) % 4)
    try:
        return base64.b64decode(padded, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{label} is not unpadded base64url") from exc


def _constant_time_ascii_equal(left: str, right: str) -> bool:
    import hmac

    return hmac.compare_digest(left.encode("ascii"), right.encode("ascii"))


def _is_control(value: str) -> bool:
    codepoint = ord(value)
    return codepoint < 32 or 127 <= codepoint <= 159
