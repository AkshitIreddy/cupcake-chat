# Storage, content protection, and permission-policy audit

Date: 2026-09-05  
Scope: local Windows product state, optional content encryption, credential protection,
backup payloads, and the `guarded` / `full-freedom` permission policy.

## Executive finding

The preserved implementation had a strong key boundary but overstated what was encrypted.
The profile master key and provider credentials are protected by Windows DPAPI for the current
user. The main product database used SQLCipher and immutable objects used AES-256-GCM. However,
the workflow databases, broker permission database, native-tool audit log, and developer traces
were ordinary plaintext stores. The workspace-password "disable" command removed only the
optional Argon2id lock record; it never turned content encryption off.

This change adds a real, explicitly optional content mode for the main workspace database and
CupcakeAI-managed object bytes. Switching modes uses a new generation, SQLCipher's export path,
authenticated object copy, full verification, and an atomic descriptor replacement. The former
generation remains authoritative until the new one has been reopened successfully. A corrupt or
incomplete staged generation rolls back to the previous generation. Normal startup does not scan
every historical object; full object verification runs only during a pending transition.

Provider credentials remain DPAPI-protected in both modes. No password is introduced into the
normal opening flow. The optional workspace password continues to be a separate unlock control.

## What is actually protected

| Store | Current protection | Controlled by Content encryption | Evidence |
|---|---|---:|---|
| Main workspace database (`cupcake.db` or active content generation) | SQLCipher in `encrypted`; SQLite in `plaintext` | Yes | `application.py`, `storage/database.py`, `storage/content_protection.py` |
| Managed objects for files and artifacts | AES-256-GCM in `encrypted`; raw immutable bytes in `plaintext` | Yes | `object_store/store.py`, `storage/content_protection.py` |
| Provider keys and profile master key | Windows DPAPI, current user and machine context | No; always protected | `tool-broker/src/vault.rs`, `tool-broker/src/runtime.rs` |
| Workflow durability (`cupcake-runtime.db`) | Plain SQLite | No | `tasks/durability.py:83` |
| DBOS system database (`cupcake-dbos-system.db`) | Plain SQLite | No | `application.py` task-runtime construction |
| Broker grants, policies, approvals (`security/security.sqlite`) | Plain SQLite; no provider credentials | No | `tool-broker/src/integration.rs`, `security_db.rs` |
| Native-tool audit (`security/native-tools.jsonl`) | Plain JSONL hash chain | No | `tool-broker/src/native/mod.rs` |
| Developer traces (`developer-traces.db`) | Plain SQLite | No | `application.py`, `observability/traces.py` |

The Settings control therefore says exactly that it changes the main workspace database and
managed file/artifact copies. It also identifies the separate stores that are outside this control.

## Implemented content migration

### Layout and publication

The active selection is a small versioned descriptor at
`security/content-protection.json`. A migrated generation is stored under a canonical UUID at
`content-generations/<uuid>/`. Descriptor parsing accepts only the two known modes and canonical
UUIDs, so a corrupt descriptor cannot redirect cleanup or database opening outside that owned
directory.

The transition is:

1. Close runtime services and checkpoint the current database WAL.
2. Create a new UUID generation without changing the active descriptor.
3. Use a SQLCipher connection plus `ATTACH ... KEY` and `sqlcipher_export()` to copy the database.
   This is required because `PRAGMA rekey` cannot convert a plaintext database into an encrypted
   database.
4. Read each source object through its current mode, verify its SHA-256 object identity, write it
   through the target mode, and read it back.
5. Reopen the target database in its target mode, run `PRAGMA integrity_check`, checkpoint it, and
   verify every target object.
6. Atomically replace the descriptor with a record containing the new active generation and the
   previous generation as recovery metadata.
7. Restart the private Python runtime. Only after the whole runtime opens successfully is the
   transition finalized.

If step 2 through 5 fails, the staged generation is removed and the active descriptor is untouched.
If the process stops after step 6, the next startup verifies the selected generation. It uses the
previous generation if the selected one cannot be opened or authenticated. The broker restarts the
runtime after every mode-change response, including a failed request whose handler already closed
its database connections.

After a successful plaintext-to-encrypted reopen, the known plaintext generation is removed.
Deletion is best effort: neither SQLite secure deletion nor filesystem deletion can promise
forensic erasure on SSDs, copy-on-write storage, backups, synchronization services, or volume
snapshots. If the operating system refuses removal, the descriptor remains in `cleanup-pending`
state and a later startup retries instead of falsely declaring cleanup complete. The UI correctly
says that existing exports and backups retain their prior protection.
Encrypted prior generations may be retained as encrypted rollback copies and are counted in the
status response; they are never mistaken for the active generation.

### Runtime contract

`content_protection.status` returns:

```json
{
  "mode": "encrypted",
  "databaseEncrypted": true,
  "objectsEncrypted": true,
  "credentialsProtected": true,
  "credentialsProtection": "windows-dpapi-current-user",
  "requiresRestart": false,
  "transition": null,
  "retainedEncryptedRollbackCopies": 0
}
```

`content_protection.set` accepts `{ "mode": "encrypted" | "plaintext" }`. A real change returns
the same status plus `changed: true` and `requiresRestart: true`. A no-op returns `changed: false`.
Both methods are explicitly present in the desktop runtime allowlist.

### Confidentiality limits

SQLCipher protects database and WAL pages at rest and authenticates pages. `temp_store=MEMORY` is
set so SQLite temporary structures do not quietly become file-backed plaintext. AES-GCM protects
object confidentiality and integrity. The object ID is still the ordinary SHA-256 of plaintext, so
equal content has an equal visible ID; the prior ADR's implied keyed object-name privacy is not
implemented.

At-rest encryption does not protect content after the unlocked runtime has decrypted it. It also
does not defend against malware already running as the same Windows user, an administrator reading
process memory, screen capture, exported plaintext, or upstream provider disclosure.

DPAPI binds credentials and the profile key to the Windows user context and normally the same
computer. A password reset performed by an administrator can make DPAPI material unrecoverable;
the product must not promise that the optional workspace password is a recovery key.

The existing product database/object subkeys are derived as
`SHA-256(master[0:32] || 0x00 || purpose)`, not HKDF as the earlier ADR claimed. The master key is
high-entropy random material and the purposes are separated, but a future crypto-format revision
should move to a named standard KDF with an explicit key-version field. Changing this silently now
would make every existing encrypted workspace unreadable, so this migration deliberately preserves
the established derivation.

## Backup correction

The version-1 `.cupcakebak` container wrapped the profile key and authenticated plaintext hashes,
but appended the runtime archive and broker security snapshot verbatim. That was especially unsafe
for the always-plaintext workflow and policy stores, and a passphrase-protected key envelope did not
make those payload bytes confidential.

Version 2 now encrypts both outer payloads with chunked AES-256-GCM. A domain-separated HMAC-SHA-256
derives a backup payload key from the profile key and backup UUID. Each payload has an independent
random 64-bit nonce prefix and a 32-bit chunk counter; runtime and security nonces cannot collide.
The authenticated data binds the complete serialized manifest, exact payload path, plaintext
digest, plaintext byte count, and chunk index. One-MiB chunks keep memory bounded for large backups. Creation re-hashes the
source while encrypting to catch mutation between the initial manifest hash and streaming copy.
Same-user backups include the profile key only as a self-contained current-user DPAPI blob in the
bounded manifest header. Recovery therefore does not depend on the live CupcakeAI credential file
still existing, while another Windows user cannot unwrap the key. The blob is never exposed to the
renderer as plaintext. Portable passphrase creation remains an implemented broker primitive without
a visible creation control and is not advertised by the current Storage screen.

Keyed inspection authenticates every chunk. Restore decrypts only into a new broker-private staging
directory, verifies the declared whole-payload digest, syncs the output, and removes the whole
staging directory on any wrong-key, truncation, tag, digest, or security-snapshot failure. The
reader retains an explicit version-1 path for existing unencrypted containers. New version-2
containers cannot be inspected or extracted through the unkeyed API.

The Storage screen's backup action now acquires an opaque, exact save-target grant and sends only
that handle through `backup.create.intent`. The broker binds the runtime intent back to the desktop
request, asks the runtime for a consistent private archive, creates and authenticates the encrypted
version-2 container in broker-private staging, revalidates the save grant, and atomically installs
the file. The renderer receives a path-free receipt with the backup ID, safe file name, size,
SHA-256 digest, payload counts, protection mode, and creation time.

The visible recovery action likewise accepts only an opaque read-only file grant. It authenticates
the outer container before extraction, prepares a new disposable profile, launches a separate
runtime against the restored profile key and detected content mode, opens the product database,
checks database integrity, proves object-store reachability exactly matches the database,
authenticates every object, and verifies a restored copy of the broker security database. It
deliberately does not replace the active profile or activate the restored key; the control and
path-free receipt make both facts explicit. Automatic active-workspace replacement is outside this
recovery verifier's current contract.

## Permission-policy audit

`full-freedom` is persisted in the broker security database and loaded into `PolicySet`. Explicit
denies are evaluated first. Full freedom then allows the policy effect without the normal category,
scope, or fresh-approval decision. Generic brokered tools also suppress their fresh-approval flag
for `Delete`, `ExternalCommunication`, `SpendMoney`, `InstallSoftware`, `SystemChange`, and
`ExecuteUnsandboxed` when this mode is active.

Native operations retain important structural boundaries independent of the policy choice:

- declared effects must exactly match effects computed from the typed operation;
- grant IDs must exactly match broker-resolved resource IDs;
- destination disclosures must exactly match the resolved operation;
- filesystem paths are resolved through opaque grants and revalidated at use;
- sandboxed Python still requires memory and CPU limits;
- URL, local-address, output-size, revision, and immutable-object checks remain enforced;
- explicit deny records still win.

The audit found one inconsistent exception: native `ApplyWrites` initialized `requires_approval`
from `always_requires_fresh_approval()` before policy evaluation, so it still asked in Full freedom.
The implementation now gates that prompt on `!policy.full_freedom`, matching the generic-tool path
and the policy unit test. Exact grant, staged-proposal identity, revision hash, destination, and
one-use execution checks remain mandatory, and a focused test proves the prompt-free path cannot
skip those checks.

The recommended product meaning is: Full freedom removes per-action consent prompts after the owner
explicitly chooses the preset, while structural capability and containment checks remain
non-bypassable. Under that meaning, no effect category needs a mandatory fresh prompt inside Full
freedom, including apply-writes; exact resource grants, secret isolation, typed operation schemas,
network containment, size/time limits, revision checks, explicit denies, and operating-system ACLs
are the safety boundary. If the product instead intends external communication or spending to
always prompt, those need separate immutable owner toggles and the UI must not call the preset Full
freedom.

## Documentation corrections required

The older wording in `README.md`, `ADR-0002-STORAGE-AND-RETRIEVAL.md`, and
`architecture/SYSTEM_OVERVIEW.md` describes product, workflow, and broker state as separate
encrypted stores. That is false for workflow, security, audit, and diagnostics. It should say:

- the main workspace database and managed objects are optionally encrypted, on by default for the
  persistent Windows profile;
- credentials and the profile key remain DPAPI-protected in either content mode;
- workflow, broker policy/audit, and developer diagnostic stores are separate plaintext stores
  until a later migration explicitly changes them;
- version-2 coordinated backup payload encryption protects all included database snapshots, while
  version-1 backups remain legacy plaintext containers around any already-encrypted inner files.

## Verification performed

- SQLCipher environment round trip: plaintext to encrypted to plaintext, preserving a real project
  and artifact object.
- Active SQLCipher header is not a plaintext SQLite header; returned plaintext generation is.
- A deliberately damaged staged encrypted database rolls back to the previous plaintext project.
- A simulated object-copy failure never publishes a descriptor and the prior project reopens.
- Noncanonical/traversal generation identifiers fail closed.
- Known plaintext generation is absent after the first successful encrypted reopen.
- Finalized startup does not scan all objects; a later authenticated read still reports a
  deliberately corrupted object.
- Broker container version 2 encrypts a payload spanning multiple one-MiB chunks; neither the known
  runtime phrase nor SQLite header appears in the container.
- Wrong profile key, ciphertext tampering, truncation, and trailing bytes fail closed and leave no
  restore staging directory.
- A generated version-1 container still passes legacy inspection and extraction.
- A real broker backup creation consumes an exact save grant, leaves no raw path in the receipt,
  verifies the installed file digest, and preserves an existing target on pre-completion failure.
- Restore preparation accepts both plaintext and SQLCipher product databases in disposable
  profiles, verifies every declared entry, and removes partial output after tampering.
- Desktop runtime allowlist remains sorted and unique.

Results at source freeze:

- Runtime content and disposable-restore tests: 8 passed.
- Full runtime suite: 421 passed and 1 skipped; strict Pyright reported 0 errors.
- Full tool-broker library suite: 112 passed and 1 ignored.
- Tool-broker binary unit tests: 7 passed.
- Tool-broker process integration tests: 6 passed.
- Generated-contract tests: 3 passed.
- Desktop allowlist test: 1 passed.

## Primary and authoritative source ledger

The implementation and conclusions above were checked against these primary or official sources:

1. [SQLCipher design](https://www.zetetic.net/sqlcipher/design/) — page/WAL encryption, page
   authentication, and temporary-store considerations.
2. [SQLCipher database key material](https://www.zetetic.net/sqlcipher/database-key-material/) —
   raw key syntax and key handling.
3. [SQLCipher API](https://www.zetetic.net/sqlcipher/sqlcipher-api/) — `PRAGMA key`, `rekey`, and
   `sqlcipher_export` behavior.
4. [Encrypting plaintext databases with SQLCipher](https://www.zetetic.net/sqlcipher/encrypting-plaintext-databases/)
   — attach/export migration rather than `rekey`.
5. [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html) — journal, flush, and atomic
   filesystem assumptions.
6. [SQLite temporary files](https://www.sqlite.org/tempfiles.html) — rollback/WAL/temp file scope.
7. [SQLite VACUUM](https://sqlite.org/lang_vacuum.html) — rewriting and secure-delete limitations.
8. [SQLite WAL](https://www.sqlite.org/wal.html) — WAL lifecycle and checkpoint semantics.
9. [SQLite how to corrupt a database](https://www.sqlite.org/howtocorrupt.html) — keeping WAL and
   database state paired.
10. [SQLite Online Backup API](https://www.sqlite.org/backup.html) — consistent live snapshots.
11. [SQLite `ATTACH DATABASE`](https://www.sqlite.org/lang_attach.html) — attached database and
    transaction behavior.
12. [SQLite transactions](https://www.sqlite.org/lang_transaction.html) — transaction boundaries.
13. [Microsoft `CryptProtectData`](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
    — current-user DPAPI protection and same-machine defaults.
14. [Microsoft `CryptUnprotectData`](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata)
    — identity and integrity requirements during unprotect.
15. [Microsoft handling passwords](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords)
    — minimizing password lifetime and clearing secret memory.
16. [Microsoft CNG portal](https://learn.microsoft.com/en-us/windows/win32/seccng/cng-portal) —
    Windows cryptographic primitives and platform direction.
17. [Microsoft threat mitigation techniques](https://learn.microsoft.com/en-us/windows/win32/secbp/threat-mitigation-techniques)
    — defense in depth and process mitigation context.
18. [Microsoft AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
    — capability isolation boundary.
19. [Microsoft implementing an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
    — AppContainer creation and launch model.
20. [Microsoft restricted tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)
    — token restriction semantics.
21. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
    — process grouping and resource limits.
22. [Microsoft Create Process in Sandbox](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)
    — restricted-process construction.
23. [NIST SP 800-38D](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-38d.pdf)
    — AES-GCM nonce uniqueness and authenticated-data requirements.
24. [NIST key-management guidance](https://csrc.nist.gov/projects/key-management/key-management-guidelines)
    — key lifecycle and separation.
25. [NIST SP 800-63B passwords](https://pages.nist.gov/800-63-4/sp800-63b/passwords/) — password
    length, blocklists, and composition guidance.
26. [NIST SP 800-63B authenticators](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)
    — authenticator and verifier threat model.
27. [RFC 9106 Argon2](https://www.rfc-editor.org/rfc/rfc9106.html) — Argon2id parameters and
    memory-hard password derivation.
28. [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
    — the 19-MiB/two-iteration/one-lane Argon2id minimum and work-factor upgrades.
29. [RFC 5869 HKDF](https://www.rfc-editor.org/rfc/rfc5869.html) — the standard extract-and-expand
    construction recommended for a future versioned product-subkey migration.

The implementation follows the intersection of these sources: SQLCipher export for format changes,
generation publication rather than multi-file in-place mutation, DPAPI for nonportable Windows
credentials, Argon2id only for optional user passphrases, unique GCM nonces with bound metadata, and
capability/containment checks that do not disappear when consent prompting is reduced.

## Optional workspace-password audit

The password gate is genuinely opt-in. With no `security/workspace-lock.json`, the workspace starts
unlocked and the private sidecars start normally. The password is a local application launch gate;
it does not derive or unwrap the content key and is not a recovery secret. Turning it off verifies
the current password, removes only the verifier record, and leaves content protection unchanged.

The verifier is a salted Argon2id PHC record with 19 MiB memory, two iterations, and one lane. The
input policy accepts 15 to 128 Unicode characters up to 512 UTF-8 bytes, rejects NUL, and imposes no
composition rules. Writes use a same-directory temporary file, file sync, and a write-through
replacement on Windows. Password strings use `Zeroizing<String>` at the command boundary.

Failures use exponential delay from 500 ms through 30 seconds, but counters live only in process
memory and reset after application restart. An attacker who can read the verifier can also perform
offline guesses. A future improvement should add the NIST-recommended blocklist check and consider
persisting a coarse, integrity-protected retry epoch without creating a denial-of-service lever.
The present Argon2id parameters meet the OWASP 19-MiB minimum profile but are below RFC 9106's
memory-constrained 64-MiB recommendation; changing them can use Argon2's encoded parameters and a
rehash-after-success path without invalidating current passwords.
