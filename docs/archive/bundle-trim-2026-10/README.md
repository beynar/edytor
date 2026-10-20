# Bundle trim, October 2026: the area studies

Three studies of the bare `<Edytor />` (the `minimal` probe), each following `docs/agents/bundle-trim.md` steps 2 to 6 in an exported copy of `master` at `9f592dde` (before shared suggestions became a plugin). Kept as written: the paths they cite into a scratch directory are the exports they were measured in.

| Study                          | Area                                                                                   | Measured prototypes (`minimal`, own min)                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`doc-layer.md`](doc-layer.md) | `src/lib/crdt/` (the facade, the op families, the index)                               | op names stated once −842 B, families spread into `prepare` −643 B, one role record per kind −613 B, claims' first build −895 B |
| [`session.md`](session.md)     | `session/`, `selection/`, `block/`, `text/`, `clipboard/`                              | `sameValue` is `jsonEquals` −470 B, one segmentation of block content −664 B, block-offset points −103 B                        |
| [`surface.md`](surface.md)     | `surface/`, `events/`, `components/`, the root, the remote carets, the rich text kinds | root wiring as tables −607 B, `focusIn` −264 B, one DOM → handle registry −336 B, the observer's one walk −387 B                |

`prototypes/` holds each prototype's diff against `9f592dde`, in the order it was stacked in its study (`doc-1` … `doc-4`; `session-A`, `session-C`, `session-B`; `surface-p1` … `surface-p5`, `p5` dropped). Wave 1 of the trim applied them onto `514c7995`; its pull request lists what each cut measured there and which were kept.

The attribution script the three studies wrote, merged, is `scripts/bundle-attribution.mjs` (`pnpm bundle:attribution`).
