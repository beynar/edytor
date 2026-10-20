# Doc layer (`src/lib/crdt/`): bundle-trim overview

This is the study for the document layer, following `docs/agents/bundle-trim.md` steps 2 to 6. It was done in an export of `master` taken on 2026-10-19 (`9f592dde`). The export is at `ov-doc/`, and the prototype stack is in the worktree `ov-p3/` next to it. The main checkout was not touched.

## Baseline and result of the prototypes

Measurements come from `node scripts/bundle-size.mjs --only minimal,all,export` on the same machine. In the export, the script's cache was moved to `.bundle-cache/` and Vite's to `<probe>/.vite`. "Own" means edytor's minified bytes, Svelte runtime excluded. "Gzip" is the gzip -9 of the whole probe bundle, as the script reports it.

| Probe | Baseline own min | After the 4 prototyped cuts | Δ min | Baseline gzip | After | Δ gzip |
|---|---:|---:|---:|---:|---:|---:|
| `minimal` | 456,314 | 453,321 | **−2,993** | 173,662 | 172,894 | −768 |
| `all` | 691,629 | 688,648 | −2,981 | 258,848 | 258,049 | −799 |
| `export` | 52,220 | 52,220 | 0 | 29,579 | 29,579 | 0 |

Each cut was measured as its own commit on top of the previous one (`minimal`):

| Cut | Pattern | Δ min | Δ gzip | Kept? | Tests run in the export |
|---|---|---:|---:|---|---|
| P1: the document and the view forward the facade's own public members (`facade.api`, `facade.prepare` keys). The editor no longer reads `DOCUMENT_OPERATIONS`/`DOCUMENT_WRITES`. | 1 one idea, several shapes | −842 | −310 | yes (≥ 0.3 KB) | `src/tests/crdt/{document,doc}` 264/264 |
| P2: one `KindRole` record per kind, memoized, plus the declared kind sets computed once. It replaces the 11 `DisplayRoles` closures, `flow.roleOf`/`tableKind`, the index's `role`/`declaredItems`/`declaredRows`, `sameShape`'s four rebuilt Sets, and `reads.isRowKind`/`isCellKind`'s scans. | 1, 8 a missing provider | −613 | −56 | yes | `src/tests/crdt` 3876/3876; `test:dom` 2902/2903 (1 Android timing row fails under load; it passes alone, on both base and P2) |
| P3: the op families are spread into `prepare`. The hand re-keyed destructures and `prepare` keys are gone. | 1 | −643 | −131 | yes | `src/tests/crdt` 3876/3876 |
| F1: the claim owners' first build goes through the incremental path. The `ownersBuilt` branch is gone, and `claimGraph` is tree-shaken out of the editor. | 1 maintained fact plus its rebuild twin | −895 | −271 | yes | `src/tests/crdt` 3876/3876 (index self-checks on) |
| All four stacked | | −2,993 | −768 | | `src/tests/crdt` 3876/3876, `test:dom` 2903 passed / 0 failed |

Patches, one per cut: `proto-1-op-lists.patch`, `proto-2-kind-record.patch`, `proto-3-families-spread.patch`, `proto-4-claims-first-build.patch`.

How the prototypes compared with their estimates:
- P1+P3 were estimated at −1.45 KB and measured −1.49 KB.
- F1 was estimated at −0.85 KB and measured −0.90 KB.
- P2 was estimated at −1.1 to −1.5 KB and measured only −0.61 KB: the producer (+0.6 KB) cost twice what was planned. The P2-like row below (O3) is re-estimated from the measurement.

Not run, left to the pass:
- `pnpm check`, `lint`, `check:deps`, `check:api`, `check:worker`;
- Playwright;
- the wide corpus.

`tsc` errors in `src/lib` are unchanged (82 before, 82 after; they come from `.svelte` imports that tsc cannot resolve).

Tools, all in `ov-doc/`:
- `attr-fn.mjs`: attribution by declaration, through the source map and TypeScript's parser on `dist/`. It is worth committing as `scripts/bundle-attribution.mjs`.
- `show-min.mjs`: prints the minified code one file contributes.
- `gz.mjs`: gzip of each file's minified code on its own.
- `unused-destructure.mjs`: no unused destructured names found.
- `../measure.sh`: measures one commit.

## 1. Attribution table (step 2)

In the `minimal` probe, the area is 168,761 B of edytor's own `crdt/` code (37 % of edytor's 456 KB), plus 53,760 B of vendored engine. By group:

| Group | Min B |
|---|---:|
| index (`text/index/*`, `text/runs`) | 37,965 |
| `doc/*` op families, reads, funnel, history, anchors, gate, seed | 33,478 |
| providers, protocols, admission, storage | 26,148 |
| `document`, `edytor-doc` (facade), `operations`, `semantics` | 15,932 |
| `placement/*` | 11,471 |
| `doc/suggest` (being moved into the engine on `suggestions-in-engine`; excluded below) | 9,830 |
| `data`, `props` | 9,643 |
| text model (`text/rows`, `streams`, `model`, `ranges`, `marks`, `items`) | 8,886 |
| `flow`, `rangeDelete` | 8,153 |
| attribution, structs, schema, anchors, incarnations, rand, tables, engine | 7,255 |

The engine boundary, vendored:

| Vendored file | Min B |
|---|---:|
| `Item.js` | 11,721 |
| `ynode.js` | 10,094 |
| `encoding.js` | 4,770 |
| `ids.js` | 4,625 |
| `BlockSet.js` | 2,767 |
| `UpdateEncoder.js` | 2,444 |
| `marks.js` | 2,336 |
| `transaction-helpers.js` | 2,089 |
| `RangeCursor.js` | 1,956 |

The cost is spread thin. There are 1,741 declarations at depth 2. The 582 that weigh 50–500 B hold 87.0 KB, and the 62 above 500 B hold 62.9 KB (`flowOps.insertFlow` alone is 4.2 KB). There is no fat function to cut: only consolidating whole families of declarations moves the number.

### The 40 largest declarations (min B, nested functions included)

| Declaration | File | Min B |
|---|---|---:|
| `flowOps.insertFlow` | flow.ts | 4183 |
| `bindWebsocketProvider.WebsocketProvider` | providers/websocket.ts | 2809 |
| `rangeDeleteOps.prepare` | rangeDelete.ts | 2620 |
| `bindIndexeddbProvider.IndexeddbPersistence` | providers/indexeddb.ts | 2381 |
| `indexReporter.report` | text/index/report.ts | 1732 |
| `indexFold.makeEditIndex` | text/index/fold.ts | 1684 |
| `docSuggest.apply` | doc/suggest.ts | 1674 |
| `docFacade.facade` | edytor-doc.ts | 1511 |
| `propsProxy.proxy` | props.ts | 1511 |
| `indexPlacement.rebuildPlacements` | text/index/placement.ts | 1418 |
| `indexReporter.advance` | text/index/report.ts | 1248 |
| `indexFold.fold` | text/index/fold.ts | 1235 |
| `docSuggest.records` | doc/suggest.ts | 1101 |
| `moveOps.splitOut` | doc/moves.ts | 1085 |
| `bindProviders.createWebsocketSync` | providers/index.ts | 1070 |
| `writeFunnel.writeStep` | doc/funnel.ts | 1044 |
| `edits.apply` | data.ts | 1038 |
| `EdytorDocument.attachSync` | document.ts | 1006 |
| `UndoManager.#capture` | doc/history.ts | 974 |
| `EdytorDocument.constructor` | document.ts | 964 |
| `bindAttribution.attach` | attribution/attribution.ts | 942 |
| `docSuggest.compute` | doc/suggest.ts | 920 |
| `bindWebsocketProvider.OwnWrites` | providers/websocket.ts | 913 |
| `indexPlacement.ensurePlacements` | text/index/placement.ts | 883 |
| `indexStreams.placeHome` | text/index/streams.ts | 860 |
| `buildView.view` | text/runs.ts | 848 |
| `bindSync.foreignStamp` | protocols/sync.ts | 847 |
| `indexFold.foldTexts` | text/index/fold.ts | 841 |
| `indexState` | text/index/state.ts | 821 |
| `layoutOps.placeBeside` | doc/layout.ts | 820 |
| `indexClaims.ensureOwners` | text/index/claims.ts | 819 |
| `indexFold.foldBlock` | text/index/fold.ts | 816 |
| `indexLayout.redissolve` | text/index/layout.ts | 803 |
| `deleteOps.deleteBlocks` | doc/delete.ts | 795 |
| `bindWebsocketProvider.closeWebsocketConnection` | providers/websocket.ts | 789 |
| `UndoManager.#release` | doc/history.ts | 772 |
| `docSuggest.base` | doc/suggest.ts | 772 |
| `bindRoomProtocol.messageHandlers` | providers/room.ts | 745 |
| `indexFold.syncPending` | text/index/fold.ts | 741 |
| `bindWebsocketProvider.setupWS` | providers/websocket.ts | 726 |

### Every file of the area (min B; "gzip alone" is the gzip of that file's minified code by itself, so it overstates its share of the bundle's gzip)

| File (`src/lib/crdt/`) | Min B | Gzip alone B | Largest declarations (min B) |
|---|---:|---:|---|
| doc/suggest.ts | 9830 | 4229 | `apply` 1674, `records` 1101, `compute` 935, `base` 772 |
| text/index/placement.ts | 9249 | 3648 | `rebuildPlacements` 1500, `ensurePlacements` 883, `typeOf` 692, `noteKind` 680 |
| text/index/fold.ts | 8277 | 3422 | `makeEditIndex` 1684, `fold` 1235, `foldTexts` 841, `foldBlock` 816 |
| providers/websocket.ts | 7812 | 3189 | `WebsocketProvider` 2809, `OwnWrites` 913, `closeWebsocketConnection` 789, `setupWS` 726 |
| document.ts | 7330 | 2818 | `attachSync` 1006, `constructor` 964, `assertAttachCompatible` 497, `#releaseReference` 385 |
| data.ts | 7018 | 3090 | `apply` 1038, `common` 495, `assign` 366, `arrange` 361 |
| doc/history.ts | 5933 | 2329 | `#capture` 1001, `#release` 812, `#replay` 739, `constructor` 456 |
| providers/room.ts | 5219 | 2487 | `messageHandlers` 745, `onPageLeave` 368, `read` 367, `readMessage` 299 |
| flow.ts | 4702 | 1993 | `insertFlow` 4217, `endOf` 153, `roleOf` 126, `tableKind` 90 |
| edytor-doc.ts | 4681 | 2051 | `facade` 1511, `{ctx}` 996, `roles` 524, `prepare` 457 |
| placement/model.ts | 4401 | 1914 | `withdrawOnUndo` 347, `createBlock` 244, `placeBlocks` 209, `anchorIn` 202 |
| text/index/report.ts | 4177 | 1773 | `report` 1741, `advance` 1268, `reachable` 404, `onReport` 172 |
| doc/reads.ts | 3648 | 1662 | `tableGrid` 575, `docReads` 541, `step` 215, `ancestorsOf` 176 |
| providers/indexeddb.ts | 3561 | 1433 | `IndexeddbPersistence` 2381, `writeSnapshot` 370, `fetchUpdates` 367, `storeState` 179 |
| rangeDelete.ts | 3451 | 1479 | `prepare` 2649, `inTables` 745, `rangeDeleteOps` 57 |
| text/model.ts | 3426 | 1598 | `ownerOf` 355, `splitAt` 273, `findAtom` 226, `claimGraph` 223 |
| text/index/layout.ts | 3361 | 1340 | `redissolve` 803, `tableVisit` 652, `dissolveVisit` 402, `cellRank` 268 |
| doc/steps.ts | 3208 | 1552 | `dissolving` 621, `emptyingAll` 397, `planSteps` 240, `{ctx}` 238 |
| text/index/streams.ts | 3097 | 1356 | `placeHome` 860, `setRow` 441, `refreshDelims` 421, `rebuildTable` 253 |
| doc/moves.ts | 3027 | 1539 | `splitOut` 1144, `duplicateBlock` 445, `unNestBlocks` 412, `{ctx}` 258 |
| semantics.ts | 2955 | 1205 | `mergeSemantics` 402, `semanticsOf` 265, `constructor` 222, `same` 175 |
| props.ts | 2625 | 1234 | `proxy` 1511, `at` 137, `splice` 124, `idsOf` 102 |
| protocols/awareness.ts | 2600 | 1021 | `constructor` 501, `applyAwarenessUpdate` 494, `setLocalState` 457, `removeAwarenessStates` 290 |
| doc/meta.ts | 2462 | 1221 | `setBlock` 607, `patchData` 521, `dataSteps` 410, `retypeSteps` 321 |
| doc/funnel.ts | 2400 | 1178 | `writeStep` 1063, `close` 495, `apply` 382, `needStream` 139 |
| text/index/claims.ts | 2387 | 986 | `ensureOwners` 819, `walkOwner` 356, `invalidateBlock` 208, `topClaim` 190 |
| placement/slots.ts | 2384 | 1106 | `placeAfter` 532, `unitsOf` 221, `anchorOf` 163, `removeUnit` 126 |
| doc/layout.ts | 2300 | 1148 | `placeBeside` 820, `wrapInLayout` 713, `besideAt` 299, `{ctx}` 257 |
| placement/display.ts | 2220 | 1008 | `displaySlotOf` 448, `lineSlotOf` 282, `storedLineSlotOf` 151, `childrenIndex` 143 |
| protocols/sync.ts | 2217 | 1089 | `foreignStamp` 881, `applyRemote` 356, `writeSaved` 239, `bindSync` 195 |
| text/rows.ts | 2187 | 989 | `gapOfItem` 225, `rowOf` 223, `boundIn` 190, `placeRow` 177 |
| text/runs.ts | 1995 | 1037 | `view` 848, `{ctx}` 381, `buildView` 207, `ctx` 193 |
| placement/resolve.ts | 1972 | 948 | `read` 271, `ownerOfNode` 187, `slotOwner` 170, `slotsBefore` 147 |
| text/index/cache.ts | 1955 | 931 | `computeFresh` 488, `reconcile` 393, `debug` 379, `computeRuns` 136 |
| doc/plan.ts | 1894 | 804 | `effectOf` 651, `sanitizeItem` 88, `applied` 84, `argsOf` 83 |
| doc/split-merge.ts | 1850 | 963 | `mergeBackward` 508, `splitBlock` 373, `{ctx}` 335, `mergeForward` 199 |
| providers/index.ts | 1770 | 885 | `createWebsocketSync` 1070, `bindProviders` 272, `localSync` 229, `targetOf` 158 |
| structs.ts | 1678 | 819 | `walkIdSet` 315, `latest` 168, `followRedone` 124, `structAt` 100 |
| attribution/block.ts | 1471 | 676 | `stampCreated` 230, `blockAttributionOf` 194, `ensureRecord` 192, `contributorsOfRecord` 118 |
| text/streams.ts | 1430 | 807 | `scanText` 310, `walk` 282, `locate` 154, `rangesOf` 120 |
| doc/capability.ts | 1419 | 752 | `canPlace` 404, `{ctx}` 207, `canMerge` 158, `docCapability` 153 |
| attribution/attribution.ts | 1372 | 674 | `attach` 942, `sanitizeProfile` 109, `profileOf` 85, `bound` 77 |
| text/index/records.ts | 1338 | 733 | `updateBlockRec` 411, `buildRec` 262, `noteShell` 167, `syncIncarnations` 164 |
| doc/seed.ts | 1304 | 818 | `seedUpdate` 687, `init` 368, `stamp` 126, `seed` 48 |
| text/index/shared.ts | 1242 | 598 | `sameShape` 280, `runEquals` 192, `facetOf` 157, `keyOf` 85 |
| doc/delete.ts | 1095 | 607 | `deleteBlocks` 807, `{ctx}` 205, `deleteOps` 48, `deleteBlock` 35 |
| doc/content.ts | 1005 | 518 | `formatRange` 222, `insertText` 151, `insertInline` 125, `deleteText` 122 |
| operations.ts | 966 | 497 | `DOCUMENT_OPERATIONS` 624, `DOCUMENT_WRITES` 336, `(top-level)` 6 |
| text/index/state.ts | 887 | 431 | `indexState` 821, `foldStats` 46, `kids0` 10, `slots0` 10 |
| text/ranges.ts | 887 | 516 | `readRange` 334, `canonKey` 160, `inlineItemOf` 99, `deepFreeze` 92 |
| doc/anchors.ts | 881 | 515 | `resolveAnchor` 425, `anchorAt` 224, `followUndo` 157, `docAnchors` 54 |
| providers/container.ts | 841 | 499 | `openContainer` 221, `readRow` 130, `verifyOrStamp` 124, `rtop` 95 |
| text/marks.ts | 812 | 468 | `fitMarks` 144, `writeRunMarks` 116, `writeMarks` 88, `sidesOf` 80 |
| doc/gate.ts | 794 | 434 | `checkSchema` 213, `constructor` 190, `registryEmpty` 59, `schemaName` 55 |
| anchors.ts | 680 | 372 | `seam` 247, `last` 81, `pick` 67, `found` 65 |
| protocols/envelope.ts | 573 | 411 | `constructor` 248, `isGenerationRecord` 93, `GENERATION_RECORD` 43, `frame` 36 |
| incarnations.ts | 562 | 382 | `incarnationsOf` 185, `incarnationNode` 77, `keepRegistryLosers` 67, `incarnationId` 50 |
| admission.ts | 532 | 389 | `admitUpdate` 219, `constructor` 207, `assertAdmission` 59, `UndecodableUpdateError` 23 |
| placement/keys.ts | 494 | 360 | `keyBetween` 96, `denseKey` 79, `ALPHABET` 70, `claimedRank` 44 |
| schema.ts | 438 | 295 | `hasWithdrawMark` 52, `hasDeleteMark` 49, `isNodeLike` 44, `metaAttrs` 39 |
| engine.ts | 435 | 289 | `Y` 434, `(top-level)` 1 |
| protocols/comments.ts | 376 | 284 | `readCommentsMessage` 226, `COMMENT_STATUS` 90, `writeCommentsSubscribe` 30, `snapshot` 19 |
| storage.ts | 308 | 224 | `through` 81, `gunzip` 58, `packed` 48, `out` 43 |
| doc/events.ts | 258 | 214 | `emitChange` 82, `onChange` 77, `docEvents` 38, `close` 25 |
| tables.ts | 254 | 192 | `columnIds` 90, `unlistedOrder` 64, `listedColumns` 59, `columns` 13 |
| rand.ts | 239 | 217 | `hash32` 88, `hash53` 42, `randOf` 29, `setDocRand` 24 |
| protocols/observable.ts | 204 | 180 | `callEach` 99, `emit` 78, `IsolatedObservable` 20, `listener` 5 |
| text/items.ts | 144 | 104 | `isBoundary` 61, `isClaimItem` 52, `isRowMark` 18, `nodeStart` 11 |
| purge.ts | 126 | 132 | `readHorizon` 102, `h` 24 |
| protocols/auth.ts | 125 | 128 | `readAuthMessage` 104, `READ_ONLY_DENIAL` 15, `authMessageType` 6 |
| providers/bound.ts | 10 | 32 | `providers` 9, `(top-level)` 1 |

## 2. Fact map (step 3)

| Fact | Computed by (shape) | Consumed by | Re-derived, converted or re-checked where |
|---|---|---|---|
| A kind's roles | `semantics.ts` `BlockRole`, then `mergeSemantics`, then `facadeConfigOf` lookups | the index, the op families, `flow`, the view | `EdytorDocument` constructor forwarding lambdas (`roleOf`, `kinds`, `defaultChildOf`, `rendersContent`, `markEdge`, 149 B). `EdytorDocument.defaultChild`/`rendersContent` (119 B) recompute the facade's answer. 11 `DisplayRoles` closures in `edytor-doc` (524 B). `flow.roleOf`/`tableKind` (216 B). Index `role`/`lineKind`/`itemKind`/`rowKind`/`rowOfTable`/`cellKind`/`declaredItems`/`declaredRows` (~470 B). Per-block `kindsOf` + `noteKind` (446 B). `sameShape`, which rebuilds 4 Sets on every retype (455 B). `reads.isRowKind`/`isCellKind`, which scan `tableKinds()` on every call (166 B). The view re-asks the kind catalogue: `definitionOf(kind).void` in the virtual lens, `Block.isContainer`/`convertible`, `attributes.insideVoid`. **P2 makes one memoized record (measured −613 B).** |
| Declared kind sets (line, item, row, cell kinds) | `config.kinds()` filtered through the roles | the index's layout and table rules, `sameShape`, the reads | Derived 5 times: `edytor-doc` `*Kinds()`, `layout.declared*`, `sameShape`, `reads.is*Kind`, `placement.rebuildPlacements`. P2: `roles.declared()`, computed once. |
| The op set (names, arity) | the `DocumentWrites` types | facade, document, view, dispatcher, suggestions, hooks | `DOCUMENT_WRITES`/`DOCUMENT_OPERATIONS` strings (960 B). Each family's `return {…}`. The facade's destructures (438 B) and `prepare` keys (352 B). The facade's keys with `byRef` (956 B). `applied()`. The virtual lens's `ops` (a copy of `applied`). `Dispatcher.operate.prepare` arity special cases. `ARGS` + `effectOf` + `writeStep` + `#touched` (one dispatch over `PlanStep`, written 4 times). **P1+P3 measured −1,485 B.** |
| Id normalization (`ref` = `toWellFormed`) | `doc/plan.ts` `ref` | every facade read and op | `byRef` around about 40 reads, about 30 `id = ref(id)` sites inside the ops, and custom wrappers for `canPlace`/`fits`/`nestParent`/`landingOf`/`canMerge`/`compare`. `nestBlock` normalizes, then `moveBlocks` normalizes again. |
| Claim owners | `index/claims.ts` incremental `walkOwner` | display, placement | First build through `claimGraph` (`text/model.ts`, 628 B), a rebuild twin. **F1 measured −895 B.** |
| Children index and slots | `index/placement.ts` `patch` (incremental) | reads, report, order | First build through `childrenIndex` (display.ts), then converted back into a Slot map (`rebuildPlacements.index`). Slot ↔ ChildSlot conversions (`reset: null` vs absent) in `slotIn`, `patch`, `childrenIndex`. |
| Stream table | `index/streams.ts` `setRow`/`refreshDelims` | the fold, runs | `rebuildTable` repeats `setRow`'s `boundsBy` loop. The `runs.ts` initial scan repeats `rows.set`/`homeOfText.set`. |
| Change report | `index/report.ts` `advance` (incremental) | `onChange`, cells, the virtual lens | A full-diff twin (`reachable` + the `after !== before` branch, about 0.9 KB). `reachable` and `advance.add` each build the published node. `typeOf` is called twice per added node. |
| What a transaction changed | engine `transaction.changed`/`holds`/`moves` + id sets | the fold | `syncPending`, `makeEditIndex.build` and `buildSeqs` each walk `ins`/`del` again. The `(c,k,len)` triple loop is written 3 times. |
| The block shown at a sequence entry | the index's accepted edges | `leftKey`, rebuild keying, `placement/model.shownIn` | Decided 3 times (`slotOwner` → home `sameUnit` → not rejected → same `via`). |
| Liveness | `display.ts` `isLiveIn` (a walk up display parents, each step a `displaySlotOf` walk: O(depth²)) | every op precondition, `live`, `isVisibleBlock`, `contentTarget` | The index already holds reachability (`order.at`, `slots`). |
| Document order and neighbours | index `order {ids, at}`, `reads.step` | navigation, selection, visibility | `navigation.displayable`/`stopBelow` and `selection.between` use `order().indexOf` (O(n)). `visibility.shown` repeats `blockAfter`. |
| Self or nearest ancestor | `reads.ancestorsOf` | capability, layout, steps, navigation, selection, composition | `[x, ...ancestorsOf(x)]` at 11 sites. Separate `islandOf` copies in `navigation` and `projectRange`. |
| A block's visible content | index `runs` (frozen `ContentRun[]`) | cells, handles, selection, steps, text handle | Split into segments/atoms with offsets 5 times (`cells.partsOf`, `handles.contentParts`, `selection.segmentsOf` over `contentItems` copies, `steps.spans`). The offset → segment rule 3 times (`textAtOffset`, `textSegmentAt`, `observer.#adoptAt`). Marks over a range 3 times. Runs → string 4 times. |
| A data target | `DataTarget` (`id`, `{block, atom}`, `null`) | `dataItemIds`, `dataPreview`, `dataSteps`, `patchData` | Normalized 3 times, a 4th shape in `patchData.t`, converted back in `ARGS.patchData`. `treeOf(leavesOf, slotsOf)` written 4 times. `idsAt` re-walks `edits.reach`. `session/props` asks `dataPreview` twice per target. |
| Plan steps | each op family builds literals | funnel, hooks, effect | `{op:'deleteText'…}` behind a `len > 0` guard (9 sites). `{op:'insertBlocks'…}` (10 sites). `splitBlock` (2). `{...plan, at}` (11). The layout host rule (3 copies). "Roots of a removal set" (5 ways). |
| Awareness change | `setLocalState` / `applyAwarenessUpdate` / `removeAwarenessStates` | providers, presence | The same diff → meta → emit body written 3 times (1,146 B). |
| Provider lifecycle and faults | `room.ts` behaviours | websocket, indexeddb | Listener wiring and teardown written twice. `'message-error'` emitted at 11 sites. Server/room trimmed 4 times, joined 5 times, the room id validated 3 times. State-vector coverage in 3 shapes. |

## 3–5. Ranked opportunities (steps 4 and 5)

Pattern numbers follow the guide: 1 one idea/several shapes, 2 a check at every layer, 3 special cases a rule covers, 4 impossible-state guards, 5 private copies of a helper, 6 a walk written per caller, 7 engine could hold it, 8 a missing provider. Bytes are `minimal` min.

"Measured" means prototyped in this export. Every other row is an estimate from the attribution table; the guide's history says estimates miss by 2× to 5×.

| # | Opportunity | Pattern | Producer (+B) | Consumers (−B) | Net | Risk |
|---|---|---|---|---|---|---|
| O1 | **The op set stated once: the facade is the table.** P1+P3, measured. Still to do: one ingress rule for id-first reads instead of `byRef` plus about 30 in-op `ref`s (−340 est.), the virtual lens reusing `applied` (−60 est.), and the arity special cases in `Dispatcher.operate` (−0.1 est.). | 1, 8 | `facade.api` + spread families (+~100) | `operations.ts` −966, `edytor-doc` re-keying −700, loops | **−1,485 measured**; about −1.9 KB with the rest | low. The rest: an ill-formed `besideAt` kind or data path would start being normalized (behaviour, see §6). |
| O2 | **The index's rebuild twins go through their incremental paths:** owners (F1, measured), children index + slots (F4, `patch` from empty, −350 est.), stream table (F5, −230 est.), `lineCounts` maintained but read only at rebuild (F9, −85 est.). | 1, 6 | 0 | claims −267, `claimGraph` −628, `rebuildPlacements`, `childrenIndex`, `rebuildTable` | **−895 measured**; about −1.55 KB in all | low to medium. First-build cost: binary-insert into lists built in document order (mostly appends). |
| O3 | **One kind record and one declared set** (P2, measured). Still to do: the document's forwarding lambdas and its `defaultChild`/`rendersContent` read the facade's record (−180 est.); `atomic` paths normalized at merge (−80 est.). | 1, 8 | memoized `of`/`declared` (+600 measured) | index −631, `flow` −106, reads −97, meta −40 | **−613 measured**; about −0.85 KB with the rest | low. The memo is cleared on every `adoptSemantics` (`rolesChanged(place)`), so answers stay as live as before. |
| O4 | **One closure for the six op families** (they share 64 names destructured 159 times, about 1.05 KB of re-destructuring). `docCapability` folded into `planSteps` (−200). `flow`/`rangeDelete` destructure the names they use at least twice (−320). `REFUSED` imported, not passed (−70). | 5 | 0 | the family destructures (2.85 KB in all) | about −1.5 KB est. | low (only file churn; no rule moves) |
| O5 | **Step builders in `doc/steps`:** `cut(id, at, end)` (9 sites, −300), `insertStep` (10 sites, −200), `splitStep` (−60), `plan(ids, writes, at?)` (11 sites, −70), one content-op prologue (−80), one layout-host rule (3 copies, −150), `emptyingAll(pred, dest)` + `removeRoots` shared with `rangeDelete` (−250), `caretIn` (−90). | 5, 3 | +~250 | `rangeDelete`, `flow`, `doc/layout`, `meta`, `moves`, `content` | about −1.2 KB est. | low to medium. `removeRoots` changes the order of plan steps hooks see: check `docs/editor-delete-contract.md` rows. |
| O6 | **Providers and awareness:** one awareness `commit` core (−380), `fault`/`unknown` helpers and the catch inside `readMessage` (−280), `room.join` returning one teardown (−200), `channelOf` + one room-id validation (−150), auth reader returns `undefined` for unknown (−70), one `covers` (−60). | 1, 5, 2 | +~300 | `websocket`, `indexeddb`, `room`, `awareness`, `sync`, `Edytor.svelte` | about −1.2 KB est. | low to medium (awareness is an upstream port, covered by its tests) |
| O7 | **One content-parts producer in `crdt/text`:** memoized `partsOf(runs)` (key, ordinal, start, end, text, runs/atom) with `textAt(parts, offset)`, `runsIn(part, from, to)` and its text. Cells, handles, selection and steps read it. | 8, 1 | +~400 | cells −321, handles −300, selection −300, text/observer/navigation −250 | about −0.9 KB est. | medium. `projectRange` compares segments by identity: keep a per-block wrapper. |
| O8 | **Index walks and helpers:** one eager pass over `ins → log → del → moves` in the fold (F6, −250); `eachTriple`; `getOr`; `seekSlot` shared with `positionInView`; `relist` shared by `setPlacement`/`patch`; `homeOf`; `rejectedList`; `idKey` (F8, −350); one `shownAt(entry)` on `ModelView` (F7, −150). | 6, 5 | +~200 | `fold`, `placement`, `placement/model`, `cache` | about −0.8 KB est. | medium. `foldedStructs` counters are asserted in 5+ tests and must count the same. |
| O9 | **Order, ancestry and points as reads:** `step(id, dir, {sealed, accept})` + `between(a, b)` (−150); `ancestry`/`closest` (−120); one `comparePoints` (−110); the `#shown.ids` guard (`tableOf(id) ?? id` covers it, −45). | 8, 5, 4 | +~80 | navigation, selection, visibility, capability, steps | about −0.4 KB est. | low |
| O10 | **Data:** one `targetIds(target)` normalizer (−120), `idsAt` through `reach` (−110), `rootOf(node)` (4 sites, −60), cache `dataPreview` in `session/props` (−40). | 1, 6 | +~60 | `data`, `reads`, `meta`, `plan.ARGS`, `session/props` | about −0.33 KB est. | low to medium |

The measured cuts (O1–O3 parts) total −2,993 B. The remaining no-behaviour-change rows are estimated at about −7.7 KB, so likely between −4 and −10 KB given estimate error. That puts the cross-module total at about **−10 KB**: about 6 % of the area's 168.8 KB, or 2.3 % of the `minimal` probe.

### Engine-first (pattern 7): the fork holds the fact, and edytor's layer goes

| # | Fact the fork could hold | Edytor layer that disappears | Producer (+B, engine) | Consumers (−B) | Net | Risk |
|---|---|---|---|---|---|---|
| E1 | The live positions of each text's boundary and claim items (an ordered bound list with a Fenwick over its gaps, kept by `integrate`/`delete`/hold) | `text/rows.ts` (2,187), `index/streams` `setRow`/`refreshDelims` (~860), `fold.foldTexts`/`gapsIn`/`holdsBoundary` (~1,030) | +1,200 est. | −3,000 est. | about −1.8 KB est. | high: fork core plus the keystroke scaling contract. Needs a YP patch. |
| E2 | A per-node edit log on the transaction (struct, len, deleted), like YP20's `holds` and YP22's `moves` | `makeEditIndex` id-set walks (1,684), part of `syncPending` (741) | +500 est. | −1,700 est. | about −1.2 KB est. | medium to high |
| E3 | Each unit's movers kept sorted by `(priority, client, clock)`: the engine already picks the winner, and must find the next one on undo | `resolve.candidatesOf`, `collectSlots.read`, part of `slots.unitsOf` | +300 est. | −800 est. | about −0.5 KB est. | medium |
| E4 | Suggestions (`doc/suggest` 9.8 KB + `session/suggestions` 9.9 KB) | — | — | — | being done on `suggestions-in-engine`; not counted here | — |

## 6. Behaviour changes not made (for the user to decide; none built)

- **Id tie-breaks disagree** (a possible bug, about 0 B): `display.ts` `bySlot` uses `localeCompare`, while `anchors.before` and `resolve.byTail` use `<`. On a rank tie, `seam` can pick a different neighbour than the children list shows.
- **Report rebuilt through `advance`** (F2, about −700 B est.): the insertion order of `added`/`moved`/`removed` would follow list order instead of DFS order. `checkPublished` would move into the test oracle.
- **One ingress rule for every string argument** (about −140 B est. on top of O1): `besideAt`'s `kind` and `dataItemIds`' `path` would start being normalized (ill-formed strings only).
- **`adoptSemantics` stops re-checking `defaultType`** (about −130 B est.): when a config conflicts on both a role and `defaultType`, a different error would be thrown first.
- **The virtual lens and `Block` read void/container from the document's roles** instead of the kind catalogue (about −100 B est.). The answers differ only if a document's semantics disagree with the view's definitions.
- **Liveness as `order.at.has(id)`** (about −100 B est.): the cost profile changes (an O(n) order rebuild after a structural change, instead of an O(depth²) walk per call).
- **Providers:** IndexedDB's `destroy` never calls `super.destroy()`, and only IndexedDB ends with its doc (inconsistencies, about 0 B). Merging awareness's 3 s timer with the websocket liveness timer (−50 B) changes tick order.
- **Outside the rules:** the bare `<Edytor />` ships the whole provider stack (about 22 KB). Only lazy loading would remove it, and that is forbidden (collaboration is the default).

## 7. Modules to rewrite at −30 % (step 8.2 input)

These are the 10 largest modules of the area, `doc/suggest` excluded (it is being rewritten on another branch). They are ordered by expected gain: the −30 % budget, with what this study has already identified inside each. Identified gains cover a third to a half of each budget. The rest has to come from stating each rule once during the rewrite itself; this study has not found it, so treat it as a target, not a finding.

| # | Module | Min B | −30 % budget | Identified (measured / est.) | Patterns seen |
|---|---|---:|---:|---:|---|
| 1 | `text/index/placement.ts` | 9,249 | −2,775 | −153 measured (P2) + about −850 est. (F4, F7, F8, F9) | rebuild twin of `patch`/`slotIn`; Slot ↔ ChildSlot conversions; private seek/relist/home/tail helpers; the shown-at entry predicate twice; role re-derivation; dead `lineCounts` maintenance |
| 2 | `text/index/fold.ts` | 8,277 | −2,483 | about −450 est. (F6, triples, get-or-create ×6, `ins/del` guards ×3); about −1,700 more with E2 | the same id-set walk three times; lazy memo plumbing around the walks |
| 3 | `providers/websocket.ts` | 7,812 | −2,344 | about −600 est. (O6) | lifecycle twin of IndexedDB; handlers registered two ways; faults ×2; naming and validation ×3; `covers` |
| 4 | `document.ts` | 7,330 | −2,199 | +11 measured (P1/P2) + about −500 est. | semantics forwarded in 5 lambdas; `defaultChild`/`rendersContent` recomputed; `adoptSemantics` re-checks the merge; listener sets ×4; create/load sync-or-destroy ×2; the data setter re-implements `facade.patchData` |
| 5 | `data.ts` | 7,018 | −2,105 | about −300 est. (O10) | `reach`/`idsAt`/`collapse`/`treeOf` path walks; `treeOf(leavesOf, slotsOf)` ×4 |
| 6 | `doc/history.ts` | 5,933 | −1,780 | about −250 est. | mirrored `undo`/`redo` and `canUndo`/`canRedo`; `#capture`/`#replay`/`#release` each walk step records |
| 7 | `providers/room.ts` | 5,219 | −1,566 | about −400 est. (O6) | `'message-error'` ×5; "unknown type" ×3; two try/catch around `readMessage`; `onPageLeave` order rules |
| 8 | `flow.ts` | 4,702 | −1,411 | −106 measured (P2) + about −500 est. | a fourth role view (gone in P2); `c.x` access instead of destructuring; hand-built `splitBlock`/`insertBlocks`/`moveBlocks` steps; clamp/holds copied from `rangeDelete`; table classification copied from the reads |
| 9 | `edytor-doc.ts` | 4,681 | −1,404 | −338 measured (P1+P3, after P2's +285 producer) + about −500 est. (O1 ingress, O4) | names re-keyed by hand (gone); `byRef` per member; contexts spread then re-destructured |
| 10 | `placement/model.ts` | 4,401 | −1,320 | about −250 est. | `shownIn` re-derives the index's acceptance; `placeAfter` call ×3; `v.blocks.get(id)?.home` ×6; `insertBlocks` validation kept only for the seed |

Next by size: `text/index/report.ts` 4,177 (the F2 twin, behaviour-sensitive), `doc/reads.ts` 3,648, `providers/indexeddb.ts` 3,561, `rangeDelete.ts` 3,451, `text/model.ts` 3,426 (−628 measured: `claimGraph` gone), `text/index/layout.ts` 3,361 (−249 measured).

## 8. What is reachable without behaviour change

- **Measured:** −2,993 B min / −768 B gzip on `minimal` (−2,981 / −799 on `all`; `export` unchanged).
- **Identified cross-module rows:** about −10 KB in all, i.e. the measured −3.0 KB plus about −7.7 KB estimated.
- **Engine-first E1–E3:** about −3.5 KB more (estimated).
- **Rewriting the 10 modules above to −30 %:** about −19 KB, which includes most of their identified rows. Only about 40 % of that is backed by findings.

Realistic area total: **−14 to −20 KB** (8–12 % of the area's 168.8 KB). −30 % across the whole area (about −50 KB) is not supported by anything found.
