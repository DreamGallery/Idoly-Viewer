# R2 snapshot protocol (schema 1)

NAS produces a complete, immutable snapshot: `web/` holds `data/catalog.json`, `data/directory.json`, `data/updates.json`, `data/media/<id>.json`, `catalog/manifest.json`, `catalog/chapters/<id>.json`, and `images/...`. `story/` holds CSV files at each chapter's `csv_path`; `adv/<id>.txt` holds scripts. `media/image/...`, `media/voice/...`, and `media/video/...` match public `/api/media/<kind>/...` paths. The catalog manifest's `base_path` is `/catalog/releases/<release>`.

All keys below are relative to `IDOLY_R2_PREFIX` (default `idoly-v1`; legacy `CAMPUS_R2_PREFIX` also works). Release IDs contain only ASCII letters, digits, underscores, and hyphens.

`releases/<release>/file-map.json` contains:

```json
{"schema_version":1,"files":{"web/data/catalog.json":"text/<sha256>/catalog.json","media/voice/example.flac":"media/<sha256>/example.flac","story/example.csv":"text/<sha256>/example.csv"}}
```

Every logical file must appear in `files`. Targets may use global `text/<64 lowercase hex>/<filename>` or `media/<64 lowercase hex>/<filename>` content-addressed objects, or `releases/<release>/{web,story,adv,media}/...` objects. Global objects are immutable. Store accurate Content-Type metadata (Worker also supplies common extension defaults). Never overwrite a published release/map. Existing releases without a map remain readable as direct objects for compatibility.

After uploading and verifying **all** content objects and then the release map, atomically replace `current.json`:

```json
{"schema_version":1,"release":"idoly-20261001","published_at":"2026-10-01T00:00:00Z","versions":{"revision":123,"versions":[]}}
```

Never switch the pointer after a failed upload. Rollback replaces only the pointer with a prior complete release. Reuse existing global hash keys across updates; batch-list objects and check listed sizes before skipping uploads, and do not copy large media into each release. Retain objects referenced by retained releases; garbage collection is a separate operation. NAS should serialize publishers and keep its upload checkpoint locally.

`node scripts/package-idoly-resources.mjs --input <snapshot> --output <output-dir> --release <release>` creates an offline upload plan. `upload-manifest.json` is uploader metadata, not a public R2 object: `objects` entries contain full prefixed key, local path, size, SHA-256, and Content-Type; `publishLast` names the pointer. Generated content is already final before packaging. The script does not upload, update game data, or read credentials.

Mutable `/data/`, `/images/`, `/api/media/`, and current `/catalog/` requests are no-store. `/catalog/releases/<release>/...` and `/media/<sha256>/<filename>` are immutable. GET/HEAD, ETag, single byte ranges and If-Range are supported; malformed/multiple/unsatisfiable ranges yield 416. Missing resources yield JSON errors and never fall through to the SPA. D1 stores encrypted OAuth/session records independently from these snapshots.

## Pinning a browser session

Release-backed responses include `X-Idoly-Release`. The browser loads `data/catalog.json` first and pins that release for its remaining lifetime. Later data, images, media, source CSV, and raw script URLs carry `?release=<release>`, which bypasses the mutable pointer and returns immutable data from that release. JSON asset URLs are pinned in the browser, so the NAS exporter need not rewrite generated JSON. The directory loads after catalog and is committed to UI state together with it. Local API responses without this header retain their original paths. Old release objects must remain available while clients may be using them. Collaboration writes continue checking the latest source, rejecting stale edits rather than silently publishing against an obsolete script.

## Recent game update archives

`current.json` may include `versions: {revision, versions: [...]}` with the newest five archive records first. Each record supplies `revision`, `from_revision`, `filename`, `bytes`, `sha256`, and `created_at`. Names use `idoly-resources-r<revision>-<12 lowercase hex>.tar.gz`; archive bytes live at `downloads/<filename>`. Upload the archive before switching the pointer. `/api/resources/versions` exposes at most the first five records, and `/api/resources/download/<filename>` checks that same allowlist before streaming a download (including byte ranges). A retained but unlisted archive cannot be downloaded through this API. The header menu derives the endpoint from `filename`, so no `url` field is required.

## Sharded maps for the full game corpus

A complete game snapshot uses a small root map and up to 256 shards:

```json
{"schema_version":1,"files":{},"shards":{"ab":"releases/<release>/maps/ab.json"}}
```

For each logical path (for example `media/voice/example.flac`), compute SHA-256 of its exact UTF-8 bytes, then take the first two lowercase hex characters. That determines its shard key. Each shard contains `{"files":{"logical/path":"target/key"}}`. Only nonempty shards need to be listed. Root `files` entries remain supported and take precedence, so existing flat releases and mixed maps continue to work. Shard references must match the same release and deterministic `maps/<two hex>.json` path.

Upload content, then **all shards**, then the root map, and only then `current.json`. Missing listed shards yield 503 and are never cached. The Worker lazily reads one shard per lookup, with an LRU capped at 16 shards / 4 MiB of raw UTF-16 text size, and two root maps / 4 MiB. Individual root maps over 8 MiB or shards over 2 MiB of UTF-8 JSON are rejected; the NAS must shard large maps. These bounds prevent the full 100,000+ media mapping from remaining in Worker memory. The offline packager emits this sharded format by default.

## Voice format

Voice objects use verified FLAC level 8 and `audio/flac`. Release maps reference these FLAC objects directly.
