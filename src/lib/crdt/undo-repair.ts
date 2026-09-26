/**
 * Undo-resurrection ownership repair (R3) — the deepest vendor-internal
 * coupling in the codebase, extracted from `edytor-doc.ts` so the blast
 * radius is visible in one module.
 *
 * `Y.UndoManager.undo()` recreates deleted atoms as NEW items — the
 * tombstones keep a LOCAL `item.redone` pointer to their copies that is
 * never serialized. Slice records anchored on those tombstones then
 * resolve PAST the resurrected atoms (anchors resolve with
 * `followUndoneDeletions=false` — the convergent rule), so the revived
 * content gets swallowed by whichever record still covers its gap —
 * the R3 defect: a split-off tail's deleted text comes back inside the
 * source paragraph. (docs/crdt-v14-undo-ownership-adr.md)
 *
 * DETECTION IS STRUCTURAL — never origin-based (Gate-H): any outer
 * `transact` wrapper or custom origin hides the UndoManager from
 * `transaction.origin` (`ed.transact(() => um.undo())`,
 * `doc.transact(fn, customOrigin)`), so the old
 * `origin instanceof UndoManager` gate was bypassable through the
 * public API. The signature instead reads what the transaction DID:
 *
 *   - `redoItem` (vendor UndoManager.js) mints each copy and marks it
 *     `keepItem(copy, true)`. `keep` is a local-only bit — never
 *     serialized — and during transaction execution NOTHING else sets
 *     it (`keepItem` for tombstones runs in `afterTransaction`, i.e.
 *     after `beforeObserverCalls`; `split`/`mergeWith` inheritance
 *     produces structs whose id range is not in this transaction's
 *     `insertSet`).
 *   - `redoItem` also writes `tombstone.redone = copyId`: a `redone`
 *     pointer landing inside this transaction's `insertSet` proves the
 *     copy was minted HERE — keep-inheritance on a neighboring item
 *     can never forge that.
 *
 * So: a live countable `content` atom in `insertSet` carrying `keep`
 * raises suspicion; a tombstone `redone` pointer into `insertSet`
 * confirms it. Both hold for `undo()` AND `redo()` (redo can resurrect
 * too), under ANY origin — nested transactions, custom origins, raw
 * `Y.UndoManager`s, multi-manager docs. Plain inserts/deletes carry no
 * kept atoms → the planner never runs → no spurious claims; remote
 * `applyUpdate` transactions carry neither `keep` nor `redone` →
 * receivers converge on the replicated claims instead of re-deriving.
 * TIMING — the repair runs on `beforeObserverCalls`: BEFORE the
 * committing transaction's observer pass (deep-observe / delta /
 * `afterTransaction` / `update`). The claim writes land in a follow-up
 * transaction appended to the in-flight cleanup sweep, and — the
 * load-bearing trick for Gate-H's torn-frame finding — the repair
 * transaction's `changed` entries are UNIONED into the committing
 * transaction's `changed` map, so the runs view's `observeDeep`
 * handler invalidates/recomputes against post-repair state in the
 * SAME frame: `subscribeBlock`/`onChange` subscribers see exactly one
 * notification carrying the repaired ownership, never the broken
 * intermediate. The wire still gets two `update` messages (the repair
 * is its own replicated transaction) — receivers converge after both,
 * exactly as before; only the LOCAL observer frame is merged.
 *
 * The claims are written under {@link UNDO_REPAIR_ORIGIN} — a
 * module-level origin no UndoManager tracks — so the repair never
 * enters an undo stack ('one user action = one undo group') and never
 * recurses (it inserts `slices` records, not `content` atoms — the
 * detector finds nothing).
 *
 * Attachment is once per DOC for the doc's whole lifetime, not per
 * facade or per binding ({@link undoRepairAttached}): raw
 * `Y.UndoManager` consumers (e.g. the peer harness's `enableUndo`) get
 * the same repair as `createUndoManager()`, repeated facade creation
 * cannot double-write claims, and an undo landing after the last
 * facade `dispose()` is still repaired — Gate-H showed the refcounted
 * release left a permanently-broken window there.
 */
import type { EngineApi, EngineDoc, EngineNode, YDoc } from './engine-api.js';
import type { BlockId } from './placement/model.js';
import type { Ownership, SliceRecord, TextBlockRec } from './text/model.js';
import {
	clientsOf,
	structAt,
	walkIdSetStructs,
	type IdSetLike,
	type StoreStruct
} from './structs.js';

/**
 * Per-doc attach table for the shared undo-repair `beforeObserverCalls`
 * listener — MODULE level on purpose: every `Edytor` binds its own engine
 * surface (`bindCrdt(Y)` per editor, edytor.svelte.ts), so a binding-scoped
 * dedupe never dedupes across editors and each facade leaked one permanent
 * doc listener (U4/gate-3 listener-retention defect).
 *
 * The listener is installed ONCE per doc — by whichever binding's facade
 * `create()` runs first — and NEVER detached. Gate-H: a refcounted
 * release on last `dispose` opened a window where an undo landing while
 * no facade was live produced permanently unrepaired (and broadcast)
 * ownership. Keeping the listener for the doc's lifetime closes it; the
 * `WeakMap` entry dies with the doc and the listener is held only by the
 * doc's own observer table, so nothing leaks (a doc that is GC'd takes
 * its listener with it). All bindings close over the same vendored `Y`,
 * so the repair closures are interchangeable.
 */
const undoRepairAttached = new WeakMap<EngineDoc, true>();

/**
 * Origin of the undo-ownership repair's claim writes — an origin no
 * UndoManager tracks, so repair commits never enter an undo stack and
 * never recurse. Module-level (one canonical system origin shared by
 * every binding). Internal-only since the retired U6 capture was its
 * last external consumer.
 */
const UNDO_REPAIR_ORIGIN = Symbol('edytor.undo-ownership-repair');

type TransactionLike = {
	insertSet?: IdSetLike;
	changed?: Map<EngineNode, Set<string | null>>;
};

/**
 * The minimal slice of the bound model/text layers the repair walks —
 * injected by `edytor-doc.ts` at bind time (same convention as the rest
 * of the bound layers; keeps this module a leaf). `contentNodeName` is
 * `SCHEMA.nodes.content` — passed rather than imported so this module
 * does not depend back on the facade's schema manifest.
 *
 * The `insertSet`/`redone` walks go through `./structs.js` (`clientsOf`,
 * `walkIdSetStructs`, `structAt`) — the shared vendor-internals surface;
 * a missing `store.clients` throws a descriptive error there (fail-fast
 * on vendored-layout change) instead of silently skipping the repair.
 */
export type UndoRepairLayers = {
	collectBlocks: (doc: EngineDoc) => Map<BlockId, TextBlockRec>;
	computeOwnership: (doc: EngineDoc, blocks: Map<BlockId, TextBlockRec>) => Ownership;
	undoRepairClaims: (
		doc: EngineDoc,
		blocks: Map<BlockId, TextBlockRec>,
		own: Ownership,
		t: string,
		text: EngineNode,
		spans: { i0: number; i1: number }[],
		freshClaim?: (client: number, clock: number) => boolean
	) => Map<BlockId, Map<number, SliceRecord[]>>;
	/** `SCHEMA.nodes.content` — the content-list node name atoms parent to. */
	contentNodeName: string;
};

/**
 * Bind the repair to one engine — returns the once-per-doc attach
 * function `edytor-doc.ts` calls from facade `create()`.
 */
export const bindUndoRepair = (
	Y: EngineApi,
	layers: UndoRepairLayers
): ((doc: EngineDoc) => void) => {
	/** Live index of the atom at `clock` inside `content` (`null` → unresolved). */
	const resurrectedIndex = (
		doc: EngineDoc,
		content: EngineNode,
		client: number,
		clock: number
	): number | null => {
		const typeId = (content._item as { id?: { client: number; clock: number } } | null)?.id;
		if (!typeId) return null;
		const abs = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON({
				type: { client: typeId.client, clock: typeId.clock },
				item: { client, clock },
				assoc: 0
			}),
			doc as unknown as YDoc,
			false
		);
		return abs === null ? null : abs.index;
	};

	const repairUndoOwnership = (doc: EngineDoc, transaction: unknown): void => {
		const tr = transaction as TransactionLike | null;
		const insertSet = tr?.insertSet;
		if (insertSet === undefined || insertSet.clients.size === 0 || tr?.changed === undefined) {
			return;
		}
		// `clientsOf` throws on a missing struct store — fail-fast on a
		// vendored-layout change (the observer boundary catches + logs; a
		// silent `return` here was the S11 "repair quietly stops" hazard).
		const clients = clientsOf(doc);

		// Phase 1 — suspicion gate: `keep` on a live countable `content`
		// atom minted in this transaction. At `beforeObserverCalls` time no
		// post-commit `keepItem` has run yet, so this bit is a faithful
		// `redoItem` marker — plain inserts never carry it.
		let suspicious = false;
		walkIdSetStructs(Y, doc, insertSet, (it) => {
			if (
				it.parentSub === null &&
				!it.deleted &&
				it.keep === true &&
				it.countable !== false &&
				(it.parent as EngineNode | null)?.name === layers.contentNodeName
			) {
				suspicious = true;
				return false; // halt the walk
			}
			return;
		});
		if (!suspicious) return;

		// Phase 2 — confirmation: collect the `redone` pointers tombstones
		// gained during THIS transaction (targets inside `insertSet`).
		// O(store), but only ever reached on undo-shaped transactions.
		const redoneTargets: { client: number; clock: number }[] = [];
		clients.forEach((structs) => {
			for (const it of structs) {
				const r = it.redone;
				if (r != null && insertSet.has(r.client, r.clock)) redoneTargets.push(r);
			}
		});
		if (redoneTargets.length === 0) return;

		// Phase 3 — copy spans per content node. Each redone target names
		// the first clock of a copy minted by this transaction; absorb
		// contiguous same-client pieces to its right that were also minted
		// now (a copy can have been split inside the same transaction —
		// the pieces inherit `keep` and share the insertSet'd id range).
		// Every walked piece is a resurrection — `resurrectedRanges` lets
		// the planner distinguish same-transaction records that were
		// RESTORED by the undo (still valid pre-delete witnesses) from
		// records freshly minted alongside it (not pre-delete evidence).
		const spansByContent = new Map<EngineNode, { i0: number; i1: number }[]>();
		const resurrectedRanges = new Map<number, { clock: number; len: number }[]>();
		for (const r of redoneTargets) {
			const structs = clients.get(r.client);
			if (structs === undefined) continue;
			let it: StoreStruct | undefined = structAt(Y, structs, r.clock) ?? undefined;
			// `redone` names the copy's first clock — OR a mid-copy clock
			// when a tombstone split propagated `redone` with an offset
			// (Item.mergeWith/splitStruct: `rightItem.redone = redone+diff`).
			// The containing piece is still wholly part of the copy, so the
			// whole piece contributes; mid-piece starts are covered anyway
			// by the merge below. Anything failing the keep/insertSet checks
			// simply isn't a piece minted by this transaction.
			for (;;) {
				if (
					it === undefined ||
					it.id.client !== r.client ||
					it.keep !== true ||
					it.deleted ||
					!insertSet.has(it.id.client, it.id.clock)
				) {
					break;
				}
				let ranges = resurrectedRanges.get(it.id.client);
				if (ranges === undefined) {
					resurrectedRanges.set(it.id.client, (ranges = []));
				}
				ranges.push({ clock: it.id.clock, len: it.length });
				const parent = it.parent as EngineNode | null;
				if (
					it.parentSub === null &&
					parent !== null &&
					parent.name === layers.contentNodeName &&
					it.countable !== false
				) {
					const pos = resurrectedIndex(doc, parent, r.client, it.id.clock);
					if (pos !== null) {
						let arr = spansByContent.get(parent);
						if (arr === undefined) spansByContent.set(parent, (arr = []));
						arr.push({ i0: pos, i1: pos + it.length });
					}
				}
				// Split pieces of one copy stay contiguous (same client,
				// adjacent clocks) and share the parent — walk them; a
				// kept item from a different list or a gap ends the piece.
				const nxt: StoreStruct | null | undefined = it.right;
				if (
					nxt == null ||
					nxt.id.client !== it.id.client ||
					nxt.id.clock !== it.id.clock + it.length ||
					nxt.parent !== it.parent
				) {
					break;
				}
				it = nxt;
			}
		}
		if (spansByContent.size === 0) return;

		// Fresh replicated-state view — the maintained view has not observed
		// this transaction yet (we run before its observer pass).
		const blocks = layers.collectBlocks(doc);
		const own = layers.computeOwnership(doc, blocks);
		const contentToId = new Map<EngineNode, BlockId>();
		for (const [id, rec] of blocks) {
			if (rec.content !== undefined) contentToId.set(rec.content, id);
		}
		// Records minted in THIS transaction that are NOT resurrections
		// cannot witness pre-delete ownership — e.g. an insertText
		// edge-rewrite batched with the undo widened an `e` anchor to the
		// live end and would otherwise "win" the copies in both spaces.
		const freshClaim = (client: number, clock: number): boolean => {
			if (!insertSet.has(client, clock)) return false;
			const ranges = resurrectedRanges.get(client);
			if (ranges === undefined) return true;
			for (const r of ranges) {
				if (clock >= r.clock && clock < r.clock + r.len) return false;
			}
			return true;
		};

		const writes = new Map<BlockId, Map<number, SliceRecord[]>>();
		spansByContent.forEach((spans, content) => {
			const t = contentToId.get(content);
			if (t === undefined) return;
			// Merge overlapping/adjacent spans: a contiguous run of copies
			// minted by separate `redoItem` calls (consecutive clocks, same
			// parent) is walked once from the FIRST `redone` target and then
			// re-walked from each later target — without merging, the shared
			// region would emit the same claim twice.
			spans.sort((a, b) => a.i0 - b.i0);
			const merged: { i0: number; i1: number }[] = [];
			for (const s of spans) {
				const last = merged[merged.length - 1];
				if (last !== undefined && s.i0 <= last.i1) {
					if (s.i1 > last.i1) last.i1 = s.i1;
				} else {
					merged.push({ i0: s.i0, i1: s.i1 });
				}
			}
			layers
				.undoRepairClaims(doc, blocks, own, t, content, merged, freshClaim)
				.forEach((groups, holder) => {
					let mine = writes.get(holder);
					if (mine === undefined) writes.set(holder, (mine = new Map()));
					groups.forEach((recs, seqIndex) => {
						mine!.set(seqIndex, (mine!.get(seqIndex) ?? []).concat(recs));
					});
				});
		});
		if (writes.size === 0) return;

		// The claim transaction commits inside the in-flight cleanup sweep:
		// `doc._transaction` is null here, so `doc.transact` opens tr1 and
		// defers its cleanup to right after this transaction's — one logical
		// commit, two wire updates (same as the old `update`-time write).
		let repairChanged: TransactionLike['changed'];
		doc.transact((t) => {
			repairChanged = (t as TransactionLike).changed;
			for (const [holder, groups] of writes) {
				const slices = blocks.get(holder)?.slicesNode;
				if (slices === undefined) continue;
				// Descending seqIndex so earlier inserts never shift later
				// targets; same-index groups insert position-ordered.
				for (const [seqIndex, recs] of [...groups.entries()].sort((a, b) => b[0] - a[0])) {
					slices.insert(seqIndex, recs);
				}
			}
		}, UNDO_REPAIR_ORIGIN);

		// Fold the repair's changed types into the committing transaction's
		// `changed` map. The observer pass about to run (`callAll` over the
		// per-type observers, then the deep/delta dispatch) reads this map,
		// so the runs view invalidates the slices facet and recomputes
		// post-repair runs in the SAME committed frame — subscribers never
		// observe the unrepaired intermediate (Gate-H R5-D6). The repair
		// transaction still gets its own cleanup + `update` afterwards;
		// the second pass recomputes identical state and publishes nothing.
		repairChanged?.forEach((subs, type) => {
			const into = tr.changed!;
			let target = into.get(type);
			if (target === undefined) into.set(type, (target = new Set()));
			for (const s of subs) target.add(s);
		});
	};

	/**
	 * The doc-level repair observer, bound once per doc for the doc's
	 * lifetime. `beforeObserverCalls` (not `update`) so the repair commit
	 * lands BEFORE the committing transaction's observer pass — see the
	 * module header for why that ordering removes the torn committed
	 * frame. A failure inside the repair must NEVER propagate: throwing
	 * here would skip the whole observer pass for the host transaction —
	 * an unrepaired resurrection still converges to pre-repair semantics.
	 */
	const onBeforeObserverCalls = (transaction: unknown, doc: EngineDoc): void => {
		try {
			repairUndoOwnership(doc, transaction);
		} catch (err) {
			console.error('[edytor-doc] undo-ownership repair failed; leaving unrepaired state', err);
		}
	};

	/**
	 * Attach the doc's shared R3 repair observer — installed on the FIRST
	 * facade (across all bindings — the table is module-level) and never
	 * detached: an undo landing while no facade is live is still repaired,
	 * and the `WeakMap` entry + the doc-held listener are freed with the
	 * doc (no leak). Idempotent by construction.
	 */
	return (doc: EngineDoc): void => {
		if (undoRepairAttached.has(doc)) return;
		undoRepairAttached.set(doc, true);
		(
			doc as unknown as {
				on(name: 'beforeObserverCalls', f: (t: unknown, d: EngineDoc) => void): void;
			}
		).on('beforeObserverCalls', onBeforeObserverCalls);
	};
};
