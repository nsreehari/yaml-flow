# card-store — Function Signature Reference

> There is no `card-store-public` layer. The CLI (`card-store-cli.ts`) calls `createCardStore` and `createFsCardStorageAdapter` directly.

---

## Types

```ts
interface CardIndexEntry {
  key:       string;   // storage-specific address (file path, blob name, …)
  checksum:  string;   // stable-JSON hash of card content, computed at write time
  updatedAt: string;   // ISO timestamp
}

type CardIndex        = Record<string, CardIndexEntry>;   // keyed by card id
type CardChecksumIndex = Record<string, string>;          // id → checksum (read-only snapshot)
```

---

## `CardStore` — read-only interface

Used by the board's one-cycle read path.

```ts
interface CardStore {
  readCard(id: string): LiveCard | null;
  readCardKey(id: string): string | null;
  readAllCards(): LiveCard[];
  readChecksumIndex(): CardChecksumIndex;
  changedSince(snapshotChecksumIndex: CardChecksumIndex): string[];
}
```

---

## `CardAdminStore` — extends `CardStore`, adds write operations

Returned by `createCardStore(...)`.

```ts
interface CardAdminStore extends CardStore {
  writeCard(id: string, card: LiveCard, cardKey?: string): void;
  removeCard(id: string): void;
  readIndex(): CardIndex;
  validateUpsert(id: string, cardKey: string): { ok: boolean; error?: string };
}
```

| Method | Description |
|--------|-------------|
| `readCard(id)` | Returns the card or `null` if not found / missing from storage |
| `readCardKey(id)` | Returns the storage key for a card id, or `null` |
| `readAllCards()` | Returns all cards; warns (via `onWarn`) on unreadable entries |
| `readChecksumIndex()` | Returns a `{ id → checksum }` map — no card content loaded |
| `changedSince(snapshot)` | IDs whose checksum differs from the snapshot, plus deleted IDs |
| `writeCard(id, card, cardKey?)` | Upsert a card; `cardKey` defaults to `id` |
| `removeCard(id)` | Remove a card and its index entry (no-op if not found) |
| `readIndex()` | Returns the raw `CardIndex` (id → `CardIndexEntry`) |
| `validateUpsert(id, cardKey)` | Pre-flight check before writing; returns `{ ok, error? }` |

---

## `createCardStore`

Pure logic factory — no I/O of its own, delegates all storage to the adapter.

```ts
function createCardStore(
  adapter: CardStorageAdapter,
  onWarn?: (msg: string) => void
): CardAdminStore
```

| Parameter | Description |
|-----------|-------------|
| `adapter` | Storage back-end (see `CardStorageAdapter` below) |
| `onWarn` | Optional warning callback; called for unreadable index entries |

---

## `CardStorageAdapter` — injected storage interface

```ts
interface CardStorageAdapter {
  readIndex(): CardIndex | null;
  writeIndex(index: CardIndex): void;
  readCard(key: string): LiveCard | null;
  writeCard(key: string, card: LiveCard): string;   // returns checksum
  cardExists(key: string): boolean;
  defaultCardKey(cardId: string): string;
}
```

---

## `createFsCardStorageAdapter`

Filesystem implementation backed by `createFsKvStorage`. Cards are stored as `.json` files under `<boardDir>/.cards/`, with `_index.json` holding the `CardIndex`.

```ts
function createFsCardStorageAdapter(boardDir: string): CardStorageAdapter
```

| Parameter | Description |
|-----------|-------------|
| `boardDir` | Root directory of the board (or any directory); `.cards/` sub-dir is created automatically |

Storage layout:
```
<boardDir>/
  .cards/
    _index.json          ← CardIndex (id → CardIndexEntry)
    <card-id>.json       ← card content (LiveCard)
    ...
```

---

## Typical usage

```ts
import { createCardStore }          from './board-live-cards-lib.js';
import { createFsCardStorageAdapter } from './storage-fs-adapters.js';

const store = createCardStore(
  createFsCardStorageAdapter('/path/to/board'),
  (msg) => console.warn(msg)
);

// Read
const card = store.readCard('card-foo');
const all  = store.readAllCards();

// Write
store.writeCard('card-foo', { id: 'card-foo', ... });

// Delete
store.removeCard('card-foo');
```
