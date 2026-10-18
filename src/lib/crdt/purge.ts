/**
 * Purge of deleted content past a horizon (`room.purge.what` in
 * `docs/editor-delete-contract.md`). The room calls it from its purge task
 * inside ONE transaction of its own (tracked by no history); it writes real
 * engine deletes, relayed like any edit, so every replica applies them and
 * the engine collects the content everywhere. Worker-safe; DOM- and
 * Svelte-free.
 *
 * The horizon is a state vector: an item whose clock is below it was
 * stored by the room before the horizon's time (`room.purge.timing`). A
 * deletion's time is the struct that made it: a block's oldest live delete
 * mark (a withdrawn block: its withdraw mark, and the records of what it last
 * held), a text hold record, a move record. A delete of a session whose
 * history ended (a release record, `hist.release.end`) is past the horizon
 * whatever its time: a delete or withdraw mark, a text hold record of that
 * writer below the record's clock. A move or a merge waits for the horizon.
 */
import type { EngineApi, EngineDoc, EngineNode } from './engine-api.js';
import {
	recordsOf,
	registryOf,
	view as modelView,
	type BlockId,
	type PlacementModel
} from './placement/model.js';
import { removeUnit, unitOf } from './placement/slots.js';
import {
	deleteClaims,
	purgeStreams,
	scanText,
	type Claim,
	type Stream,
	type TextEngine
} from './text/model.js';
import {
	BLOCK_ATTR_ROOT,
	DATA,
	DATA_LEAF_PREFIX,
	DEL_PREFIX,
	HORIZON_ATTR,
	HORIZON_ROOT,
	REGISTRY_KEY,
	RELEASE_ROOT,
	TEXT_DELETES_ROOT,
	WITHDRAW_PREFIX
} from './schema.js';
import { baseIdOf, isIncarnationId } from './incarnations.js';
import { attrItems, dropSearchMarkers, engineOps, firstItem, holdsIds } from './structs.js';

/** Engine ids `c:k … c:k+n-1`. */
type Span = { c: number; k: number; n: number };

/** The horizon: the time and encoded state vector of the room's epoch (`room.purge.timing`). */
export type Horizon = { at: number; sv: Uint8Array };

/** What one purge wrote. */
export type PurgeReport = {
	/** Blocks removed: registry entry deleted, node collected. */
	removed: number;
	/** Deleted blocks kept (a live block streams in their text, two boundaries name them, or a block is placed under them) whose stream, data and claims were deleted. */
	emptied: number;
	/** Text hold records deleted (what they held deleted with them). */
	marks: number;
	/** Move records dropped: old ones no block shows at any more (a lost move, a move of removed blocks). */
	records: number;
	/** Claims naming a removed block, deleted from the blocks that hold them. */
	claims: number;
	/**
	 * Attribution records of blocks merged away before the horizon (their
	 * text shows in the block that claimed them, which unioned their
	 * contributors at the merge): deleted, their registry entries kept.
	 */
	merged: number;
	/** Release records the horizon covers (`hist.release.end`): deleted. */
	released: number;
};

type Item = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	removed?: boolean;
	countable?: boolean;
	parent?: unknown;
	right: Item | null;
	content: { arr?: unknown[]; ids?: number[] };
	delete(tr: unknown): void;
};

const mapOf = (node: EngineNode): Map<string, Item> => attrItems<Item>(node);

/**
 * The ended histories a document holds (`hist.release.end`): per writer,
 * the clock its latest live release record ended at (what it wrote below
 * it is released).
 */
export const releasesOf = (doc: EngineDoc): Map<number, number> => {
	const out = new Map<number, number>();
	for (let it = firstItem<Item>(doc.get(RELEASE_ROOT)); it; it = it.right) {
		if (it.deleted) continue;
		const { client, clock } = it.id;
		out.set(client, Math.max(out.get(client) ?? 0, clock + it.length - 1));
	}
	return out;
};

/** The horizon a document holds (`null`: never purged). */
export const readHorizon = (doc: EngineDoc): Horizon | null => {
	const h = doc.get(HORIZON_ROOT).getAttr(HORIZON_ATTR) as
		| { at?: unknown; sv?: unknown }
		| undefined;
	return h != null && typeof h.at === 'number' && h.sv instanceof Uint8Array
		? { at: h.at, sv: h.sv }
		: null;
};

export const bindPurge = (Y: EngineApi) => {
	const ops = engineOps(Y);
	type Old = (client: number, clock: number) => boolean;
	/** One live hold record (fork patch YP20): its id and the range it holds. */
	type Hold = { client: number; clock: number } & Span;

	/** The live hold records of `doc`, one per held range. */
	const holdsOf = (doc: EngineDoc): Hold[] => {
		const out: Hold[] = [];
		for (let it = firstItem<Item>(doc.get(TEXT_DELETES_ROOT)); it; it = it.right) {
			const ids = it.content.ids;
			if (it.deleted || ids === undefined) continue;
			for (let j = 0; j < ids.length; j += 3)
				out.push({
					client: it.id.client,
					clock: it.id.clock + j / 3,
					c: ids[j],
					k: ids[j + 1],
					n: ids[j + 2]
				});
		}
		return out;
	};

	/**
	 * Whether every live record holding an item of `spans` was written where
	 * `old` says (a withdrawn block's content was deleted before the
	 * horizon). Items no record holds count as old.
	 */
	const heldBefore = (holds: readonly Hold[], spans: readonly Span[], old: Old): boolean =>
		holds.every(
			(h) =>
				old(h.client, h.clock) ||
				!spans.some((sp) => sp.c === h.c && sp.k < h.k + h.n && h.k < sp.k + sp.n)
		);

	/**
	 * The text's part (`room.purge.what`), inside the purge transaction:
	 * every hold record `old` names is deleted with what it holds (a real
	 * delete: the engine collects it everywhere; a newer record holding the
	 * same text has nothing to show again, the older delete is past the
	 * horizon). A record whose text the room lacks (lost, coming back with
	 * its author) is kept: it holds that text when it returns.
	 */
	const purgeText = (doc: EngineDoc, old: Old): number => {
		const tr = (doc as { _transaction?: unknown })._transaction;
		if (tr == null) throw new Error('purge: outside a transaction');
		const doomed = holdsOf(doc).filter(
			(h) => old(h.client, h.clock) && holdsIds(doc, h.c, h.k, h.n)
		);
		const ids = (spans: readonly Span[]) => {
			const set = ops.idSet();
			for (const sp of spans) set.add(sp.c, sp.k, sp.n);
			return set;
		};
		ops.iterate<Item>(tr, ids(doomed), (it) => {
			if (it.removed !== false) return;
			it.delete(tr);
			dropSearchMarkers(it.parent);
		});
		// The records are read first and deleted after: deleting one releases
		// its holds, which can split items of the store the walk is reading
		// (its writer's own text), and the walk would then visit the structs
		// written before the record (a delete mark beside it) as if they were it.
		const records: Item[] = [];
		ops.iterate<Item>(tr, ids(doomed.map((h) => ({ c: h.client, k: h.clock, n: 1 }))), (it) => {
			records.push(it);
		});
		for (const it of records) it.delete(tr);
		return doomed.length;
	};

	/**
	 * Purge from `doc` (through `facade`, the facade over it) what was
	 * deleted before `horizon`, and what the sessions whose history ended
	 * deleted (`hist.release.end`), and write the horizon record. With no
	 * horizon (`null`: the room's tick found none due), only the ended
	 * sessions' deletes go, and the horizon record is left as it is. Runs
	 * inside the caller's transaction.
	 */
	const purge = (
		doc: EngineDoc,
		facade: { model: PlacementModel; text: TextEngine },
		horizon: Horizon | null
	): PurgeReport => {
		const report: PurgeReport = {
			removed: 0,
			emptied: 0,
			marks: 0,
			records: 0,
			claims: 0,
			merged: 0,
			released: 0
		};
		const vector =
			horizon === null
				? new Map<number, number>()
				: (Y.decodeStateVector(horizon.sv) as Map<number, number>);
		const old = (client: number, clock: number) => clock < (vector.get(client) ?? 0);
		// A delete of an ended session is past the horizon (`hist.release.end`).
		const releases = releasesOf(doc);
		const freed = (client: number, clock: number) =>
			old(client, clock) || clock < (releases.get(client) ?? 0);
		const oldItem = (item: Item | undefined) =>
			item !== undefined && !item.deleted && freed(item.id.client, item.id.clock);
		const view = modelView(doc);
		const { blocks, own, placements } = view;
		const marks = (node: EngineNode, prefix: string) =>
			[...node.attrKeys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => mapOf(node).get(key));

		// ── Which deleted blocks are past the horizon ─────────────────────
		/** The items of `stream`'s region of its text, live or deleted, as spans. */
		const regionSpans = (s: Stream): Span[] => {
			const out: Span[] = [];
			let at = 0;
			let inside = s.start === 0;
			for (let it = firstItem<Item>(s.text); it !== null; it = it.right) {
				const live = !it.deleted && it.countable !== false;
				if (live && at >= s.end) break;
				if (inside) out.push({ c: it.id.client, k: it.id.clock, n: it.length });
				if (live) {
					at += it.length;
					if (at === s.start) inside = true;
				}
			}
			return out;
		};
		/** The paired mark items of `s`'s region whose start and end both lie in it. */
		const regionMarks = (s: Stream): Item[] => {
			const opened = new Map<string, Item>();
			const out: Item[] = [];
			let at = 0;
			let inside = s.start === 0;
			for (let it = firstItem<Item>(s.text); it !== null; it = it.right) {
				const live = !it.deleted && it.countable !== false;
				if (live && at >= s.end) break;
				const { key, value } = it.content as { key?: unknown; value?: unknown };
				if (inside && !it.deleted && typeof key === 'string' && Array.isArray(value)) {
					const role = key.charCodeAt(0);
					if (role === 1) opened.set(`${value[2]}:${value[3]}`, it);
					else if (role === 2) {
						const start = opened.get(`${value[0]}:${value[1]}`);
						if (start !== undefined) out.push(start, it);
					}
				}
				if (live) {
					at += it.length;
					if (at === s.start) inside = true;
				}
			}
			return out;
		};
		const dead = new Set<BlockId>();
		const shells: BlockId[] = [];
		for (const [id, rec] of blocks) {
			if (!rec.deleted) continue;
			const del = marks(rec.node, DEL_PREFIX).filter((item) => item && !item.deleted);
			if (del.length > 0) {
				if (del.some(oldItem)) dead.add(id);
				continue;
			}
			// A withdrawn block that holds nothing (`hist.undo.withdraw`).
			if (marks(rec.node, WITHDRAW_PREFIX).some(oldItem)) shells.push(id);
		}
		// A withdrawn block is hidden since it last held something: what its
		// stream held was deleted, and its children left (the move that took
		// them is old), before the horizon.
		const children = new Map<BlockId, BlockId[]>();
		const add = (map: Map<BlockId, BlockId[]>, key: BlockId, id: BlockId) => {
			const list = map.get(key);
			if (list === undefined) map.set(key, [id]);
			else list.push(id);
		};
		for (const [id, rec] of blocks) {
			const p = rec.home?.parent;
			if (typeof p === 'string') add(children, p, id);
		}
		/** The block's display edge is old: it shows at its home slot (written with the block), or at an old record. */
		const edgeOld = (id: BlockId): boolean => {
			const home = blocks.get(id)?.home;
			const r = home ? (unitOf(doc, home)?.item.mover ?? null) : null;
			return r === null ? true : old(r.id.client, r.id.clock);
		};
		const holds = shells.length > 0 ? holdsOf(doc) : [];
		for (let grew = true; grew; ) {
			grew = false;
			for (const id of shells) {
				if (dead.has(id)) continue;
				const s = own.streamOf(id);
				if (s !== undefined && !heldBefore(holds, regionSpans(s), freed)) continue;
				const left = (children.get(id) ?? []).every((child) =>
					placements.get(child)?.parent === id ? dead.has(child) : edgeOld(child)
				);
				if (!left) continue;
				dead.add(id);
				grew = true;
			}
		}
		// A losing incarnation dies with its key's block too.
		for (const id of blocks.keys()) if (isIncarnationId(id) && dead.has(baseIdOf(id))) dead.add(id);

		// ── Which of them go whole ────────────────────────────────────────
		// A text family: the blocks with a stream in one backing text, and the
		// block owning it. The block owning a text goes only with every block
		// streaming in it (its text goes with its node). A block streaming in
		// another's text, owning none, goes alone when one boundary names it:
		// that boundary stays and delimits the stream the purge empties, which
		// nobody shows (a removed key's, `text/streams.ts` `removedKeys`).
		const parent = new Map<BlockId, BlockId>();
		const root = (id: BlockId): BlockId => {
			let r = id;
			while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
			parent.set(id, r);
			return r;
		};
		const join = (a: BlockId, b: BlockId) => {
			const [x, y] = [root(a), root(b)];
			if (x !== y) parent.set(x, y);
		};
		for (const id of blocks.keys()) {
			const s = own.streamOf(id);
			if (s !== undefined && s.home !== id) join(id, s.home);
			// A key's block and its losing incarnations go together or stay together.
			if (isIncarnationId(id)) join(id, baseIdOf(id));
		}
		const families = new Map<BlockId, BlockId[]>();
		for (const id of blocks.keys()) add(families, root(id), id);
		const removable = new Set<BlockId>();
		for (const family of families.values())
			if (family.every((id) => dead.has(id))) for (const id of family) removable.add(id);
		// The live boundaries naming each block, and the keys with losing incarnations.
		const naming = new Map<BlockId, number>();
		for (const rec of blocks.values())
			if (rec.content)
				for (const b of scanText(rec.id, rec.content).bounds)
					if (b.m === undefined) naming.set(b.s, (naming.get(b.s) ?? 0) + 1);
		const incarnated = new Set<BlockId>();
		for (const id of blocks.keys()) if (isIncarnationId(id)) incarnated.add(baseIdOf(id));
		const lone = new Set<BlockId>();
		for (const id of dead) {
			if (removable.has(id) || isIncarnationId(id) || incarnated.has(id)) continue;
			const s = own.streamOf(id);
			if (s === undefined || s.home === id || blocks.get(id)!.content !== undefined) continue;
			if (naming.get(id) !== 1) continue;
			lone.add(id);
			removable.add(id);
		}
		// Nothing that stays may be placed under a block that goes, or keep its
		// home slot in the sequence of one (the slot goes with the node).
		for (let shrank = true; shrank; ) {
			shrank = false;
			for (const [id, rec] of blocks) {
				if (removable.has(id)) continue;
				for (const p of [placements.get(id)?.parent, rec.home?.parent]) {
					if (typeof p !== 'string' || !removable.has(p)) continue;
					for (const member of lone.has(p) ? [p] : (families.get(root(p)) ?? [])) {
						removable.delete(member);
						lone.delete(member);
					}
					shrank = true;
				}
			}
		}

		// ── The writes ────────────────────────────────────────────────────
		// A deleted block that stays: its stream's text (boundaries kept), its
		// data leaves and its claims; a block that goes alone: its stream's
		// text and its claims (the rest goes with its node).
		const emptied = [...dead].filter((id) => !removable.has(id));
		const purged = [...emptied, ...lone].flatMap((id) => {
			const s = own.streamOf(id);
			return s === undefined ? [] : [s];
		});
		// Their marks format nothing any reader shows: each pair whose start and
		// end lie in one of these streams goes (collected, it keeps its class).
		const tr = (doc as { _transaction?: unknown })._transaction;
		for (const s of purged) for (const item of regionMarks(s)) item.delete(tr);
		purgeStreams(purged.filter((s) => s.end - s.start > s.inert.length));
		for (const id of lone) deleteClaims(doc, blocks.get(id)!.claims);
		for (const id of emptied) {
			const rec = blocks.get(id)!;
			for (const key of [...rec.node.attrKeys()])
				if (key === DATA || key.startsWith(DATA_LEAF_PREFIX)) rec.node.deleteAttr(key);
			deleteClaims(doc, rec.claims);
			report.emptied++;
		}
		// The blocks that go whole: their entries, attribution records and the claims naming them.
		const registry = doc.get(REGISTRY_KEY);
		const attribution = doc.get(BLOCK_ATTR_ROOT);
		for (const [id, rec] of blocks) {
			// An emptied block's claims are gone already (above).
			if (removable.has(id) || dead.has(id)) continue;
			const named = rec.claims.filter((c) => c.stamp.c >= 0 && removable.has(c.m));
			deleteClaims(doc, named);
			report.claims += named.length;
		}
		for (const id of removable) {
			// Its home slot goes with it: nothing shows it any more.
			const home = blocks.get(id)?.home;
			if (home) removeUnit(doc, home);
			if (isIncarnationId(id)) {
				// A losing incarnation is no registry value: its subtree goes.
				// Its node is a deleted value, which the node API writes nothing to:
				// its attrs' items are deleted directly, in this transaction.
				const attrs = attrItems<{ deleted: boolean; delete(tr: unknown): void }>(
					blocks.get(id)!.node
				);
				doc.transact((tr) => {
					for (const item of attrs.values()) if (!item.deleted) item.delete(tr);
				});
				report.removed++;
				continue;
			}
			registry.deleteAttr(id);
			if (attribution.getAttr(id) !== undefined) attribution.deleteAttr(id);
			report.removed++;
		}
		// Blocks merged away before the horizon (`room.purge.merged`): live,
		// shown by the block that claims them, every claim on them old. Their
		// own attribution records go (no history reaches a step below the
		// horizon to split them out again); their registry entries stay.
		const claimsOn = new Map<BlockId, Claim[]>();
		for (const rec of blocks.values()) {
			if (rec.deleted) continue;
			for (const c of rec.claims) {
				const list = claimsOn.get(c.m);
				if (list === undefined) claimsOn.set(c.m, [c]);
				else list.push(c);
			}
		}
		const claimedOld = (id: BlockId): boolean =>
			(claimsOn.get(id) ?? []).every((c) => c.stamp.c >= 0 && old(c.stamp.c, c.stamp.k));
		for (const [id, rec] of blocks) {
			if (rec.deleted || removable.has(id) || dead.has(id) || isIncarnationId(id)) continue;
			const owner = own.ownerOf(id);
			if (owner === id || typeof owner !== 'string' || !claimedOld(id)) continue;
			if (attribution.getAttr(id) === undefined) continue;
			attribution.deleteAttr(id);
			report.merged++;
		}
		// Old move records no block shows at (lost to a newer move, or their blocks
		// removed): no undo below the horizon can make them movers again.
		const sequences: EngineNode[] = [registryOf(doc)];
		for (const [id, rec] of blocks) if (!removable.has(id)) sequences.push(rec.node);
		// A record a block shows at stays, though it is no unit's mover (a cycle
		// sent the block back to it): it is read before any record goes.
		const shownNow = modelView(doc);
		const listed = sequences.map((node) => [node, recordsOf(doc, node, shownNow)] as const);
		doc.transact((tr) => {
			for (const [node, records] of listed)
				for (const r of records) {
					if (r.wins || !old(r.item.id.client, r.item.id.clock)) continue;
					ops.remove(tr, r.item);
					dropSearchMarkers(node);
					report.records++;
				}
		});
		// Text hold records past the horizon, with what they hold.
		report.marks = purgeText(doc, freed);
		// Release records the horizon covers: what they released is past it.
		{
			const tr = (doc as { _transaction?: unknown })._transaction;
			for (let it = firstItem<Item>(doc.get(RELEASE_ROOT)); it; it = it.right) {
				if (it.deleted || !old(it.id.client, it.id.clock + it.length - 1)) continue;
				it.delete(tr);
				report.released++;
			}
		}
		// The horizon record, last.
		if (horizon !== null)
			doc.get(HORIZON_ROOT).setAttr(HORIZON_ATTR, { at: horizon.at, sv: horizon.sv });
		return report;
	};

	return { purge };
};

export type PurgeBinding = ReturnType<typeof bindPurge>;
