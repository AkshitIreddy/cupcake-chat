# September 8 Windows package audit

**Date:** 2026-09-08

**Scope:** Current-Windows, headless runtime and package association for the September 8 UI pass.

**Product source freeze:** `ccc17b8debbd91ec720f29a49411f63e6206f8ba`

**Runtime source freeze:** `8a25eb7`

## Runtime source and candidate

The runtime candidate was frozen from Git commit `8a25eb7`
(`fix(runtime): accept every workspace wallpaper`). The build used the repository-pinned Python 3.12
environment with PyInstaller 6.22.2 and the same one-directory arguments, excluded demand-only
modules, and copied package metadata as `scripts/package-sidecars.mjs`. It was built from a Git
archive in an isolated E: directory, so concurrent renderer edits and the running owner app could
not alter the candidate or receive a partially staged resource tree.

The focused settings restart test passed for all four newly accepted wallpapers:

- `aquamarine-tidepool-library`
- `ink-snow-garden`
- `raspberry-circuit-conservatory`
- `saffron-paper-city`

The frozen `--provider-load-check` loaded all six packaged provider adapters: Anthropic, Cohere,
Google, Mistral, OpenAI, and xAI. The frozen `--help` entry point also exited successfully. These
checks made no provider request and did not load a local model.

| Runtime candidate field | Value                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| Candidate directory     | `E:\temp\cupcake-runtime-8a25eb7-20260908T114314\dist\cupcake-runtime`       |
| Executable bytes        | 28,674,610                                                                   |
| Executable SHA-256      | `C1A095EFA90BBF6F5B793C2B8E750FE001A442C3BFB1658C0E7FA64E0EA27694`           |
| `_internal` inventory   | 820 files; 87,338,636 bytes                                                  |
| Source archive SHA-256  | `A800ECED1AF23C549ED11BEA277DF0F5392C5D7A027B7C22D2F98815B0D1B08A`           |
| Receipt                 | `E:\temp\cupcake-runtime-8a25eb7-20260908T114314\runtime-build-receipt.json` |

The receipt contains a byte length and SHA-256 record for every support file. This candidate was not
promoted into the active Tauri input directories while the old owner package was running.

## Final package association

The final source freeze is `ccc17b8debbd91ec720f29a49411f63e6206f8ba`. A later commit added a
human-run demo helper after the renderer build had finished; it did not change or enter the product
executable. The source archive used for package association was created before that helper commit.

| Artifact                                                                                 |      Bytes | SHA-256                                                            |
| ---------------------------------------------------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| `apps/desktop/src-tauri/target/release/CupcakeAI.exe`                                    | 12,780,032 | `63C664259992DB8194A86AA58AE66F0A23E8B7F114215D8590807C5D05318E4E` |
| `apps/desktop/src-tauri/target/release/bundle/nsis/CupcakeAI 2_2.0.0-rc.1_x64-setup.exe` | 82,457,823 | `819050217889735890329CDD5E581C01B297886AE330F1D673988CB0C5A2E3CD` |
| Packaged `sidecars/cupcake-runtime.exe`                                                  | 28,674,610 | `C1A095EFA90BBF6F5B793C2B8E750FE001A442C3BFB1658C0E7FA64E0EA27694` |
| Packaged `sidecars/cupcake-tool-broker.exe`                                              | 10,749,440 | `6AE4A22F42B5D7B2AD5DB2670C31091E15273F05EF9BA6128E5C3B298E9E9CAC` |
| Packaged `sidecars/sidecars.manifest.json`                                               |    161,448 | `2608A4343F19C0839AF5B33B218C999CE304A57D1E2FB87B6D76A1C535288541` |
| `E:\temp\cupcake-overhaul-20260905\final-source-ccc17b8-20260908.zip`                    |  6,994,574 | `662294B59897D5186AF6ED98A0D0EA0F624A9C9271CB9CA60FE5328FA56985BF` |

The packaged runtime, broker, and manifest hashes exactly match the verified staging set. The
manifest has schema 1, protocol 1, target `win32-x64`, 820 runtime support records, and the verified
Cupcake Local `b10679` CPU baseline. Its baseline manifest SHA-256 is
`C1890BFA47E251ABC37EEAEEB59ACC40BF4B1EEE1A890DC1697C68CEB103F96A`.

## Headless gates

The following completed successfully against the final package:

- pinned-environment wallpaper persistence test: 4 passed;
- frozen runtime `--provider-load-check`: Anthropic, Cohere, Google, Mistral, OpenAI, and xAI;
- frozen runtime `--help`;
- `node scripts/package-sidecars.mjs --verify-only`;
- `node scripts/smoke-package.mjs --platform win32 --mode bundle`;
- `node scripts/release-candidate-audit.mjs --require-artifacts`.

The release host linked in 5 minutes 19 seconds, and NSIS produced one unsigned installer. No
provider request, local-model load, GPU work, visible window, publish, or push was performed in this
lane. Per the owner's September 8 direction, UI checks remained headless. Installer lifecycle was
not repeated because this pass changed renderer and runtime content rather than installer behavior;
the final package's static bundle and manifest gates are the evidence recorded here.
