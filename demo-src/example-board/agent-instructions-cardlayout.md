# Card Design Principles & Layout Guide

---

## Card Design Principles

- **Cards are not pages** — think post-it notes, not dashboards. The primary content (table, editable data) should be immediately visible, not buried below stacked metrics. Use at most one hero `metric`; collapse secondary summary figures into a single `text` line rather than multiple `metric` blocks.
- **Single responsibility** — each card answers one question. If the title needs "and", split it.
- **No redundancy across cards** — each column on a board should appear on exactly one card. If a value is already visible elsewhere, omit it; the user's eye can join cards mentally.
- **Aggregations are distinct** — a metric that summarises data from another card (total, count, average) is not redundant — it is new information. Keep it.
- **Separate input from output** — cards with editable elements (`editable-table`, `form`, `filter`) should stay lean; put heavy compute and display in a separate downstream card that `requires` the published token.
- **Propagate data, not display** — use `provides` to pass data between cards; never duplicate a `source_defs[]` fetch for data another card already provides.
- **KISS** — if you are unsure whether a field adds value, leave it out. A sparse card that is immediately readable is better than a dense card that requires study.

---

## Layout

```json
"layout": {
  "board":  { "col": 4, "order": 5 },
  "canvas": { "x": 300, "y": 400, "w": 280, "h": 180 }
}
```

- `board.col` — Bootstrap 12-column span: `3`=quarter, `4`=third, `6`=half, `8`=two-thirds, `12`=full
- `board.order` — ascending integer, controls vertical sort in board view
- `canvas` — pixel coordinates/size for drag-layout (canvas mode). `h` must be tall enough for all rendered content — a card with metrics + a 4-row table typically needs 400–500px. Too small a height causes an in-card scrollbar; when in doubt, size generously.
