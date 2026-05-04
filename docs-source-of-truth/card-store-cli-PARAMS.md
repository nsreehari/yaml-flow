# card-store CLI — Parameter Reference

> **Note**: Unlike `board-live-cards-cli`, `card-store` outputs raw JSON/YAML directly to stdout — not wrapped in a `CommandResult` envelope.

`--store-ref` is a `::kind::value` routing flag, e.g. `::fs-path::/path/to/board`.  
It is required on every command and selects the card store directory.

---

## `get`

Read one card or all cards from the store.

```
card-store get --store-ref <ref> [--id <card-id>] [--yaml]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--store-ref <ref>` | yes | Card store location |
| `--id <card-id>` | no | Return only this card; exits 1 if not found |
| `--yaml` | no | Output YAML multi-doc (default: JSON array) |

**stdout (default — JSON)**
```json
[
  { "id": "<card-id>", ... },
  ...
]
```

**stdout (`--yaml`)**
```yaml
---
id: <card-id>
...
---
id: <card-id>
...
```

No output (silent exit 0) when the store is empty.

---

## `set`

Write one or more cards into the store. Cards are upserted by `id`.

```
card-store set --store-ref <ref> [--ref <jsonfile> | --ref-yaml <yamlfile>] [--yaml]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--store-ref <ref>` | yes | Card store location |
| `--ref <file>` | no | Read cards from a JSON file (array or single object) |
| `--ref-yaml <file>` | no | Read cards from a YAML multi-doc file |
| `--yaml` | no | Treat **stdin** as YAML multi-doc (default stdin format is JSON) |

When neither `--ref` nor `--ref-yaml` is given, cards are read from **stdin**.

Each card must contain a string `id` field.

**stdin / file shapes**

JSON:
```json
[{ "id": "card-foo", ... }, { "id": "card-bar", ... }]
```
or a single object:
```json
{ "id": "card-foo", ... }
```

YAML multi-doc:
```yaml
---
id: card-foo
...
---
id: card-bar
...
```

**stderr on success**
```
card-store set: wrote N card(s)
```

---

## `del` / `delete`

Delete one or more cards from the store by ID.

```
card-store del --store-ref <ref> --id <card-id> [--id <card-id> ...]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--store-ref <ref>` | yes | Card store location |
| `--id <card-id>` | yes (≥1) | Card ID to remove; repeat for multiple |

**stderr on success**
```
card-store del: removed N card(s)
```

---

## Comparison with `board-live-cards-cli`

`card-store` is the canonical tool for direct card store read/write.  
`board-live-cards-cli` no longer exposes card store commands directly — use `card-store` instead.

| Capability | `card-store` CLI | `board-live-cards-cli` |
|---|---|---|
| Write / update cards | `set` | removed — use `card-store set` |
| Delete cards | `del` | removed — use `card-store del` |
| Read cards | `get` / `get --id <id>` | removed — use `card-store get` |
| YAML output | `get --yaml` | — |
| Output format | raw JSON array / YAML multi-doc | `CommandResult` envelope |
| Board init required | no | yes — and `init` now requires `--store-ref` |
| Card store location | `--store-ref` flag (any `::kind::value`) | configured at `init` time, readable via `get-card-store-ref` |
