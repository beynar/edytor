/**
 * Purge of deleted content past a horizon (H7, `room.purge.what` in
 * `docs/editor-delete-contract.md`). The room calls it from its purge task
 * inside ONE transaction of its own (tracked by no history); it writes real
 * engine deletes, relayed like any edit, so every replica applies them and
 * the engine collects the content everywhere. Worker-safe; DOM- and
 * Svelte-free.
 *
 * The horizon is a state vector: an item whose clock is below it was
 * stored by the room before the horizon's time (`room.purge.timing`). A
 * deletion's time is the struct that made it: a block's oldest live delete
 * mark (a withdrawn block: its withdraw mark, and the marks of what it last
 * held), a text delete mark record, a placement candidate.
 */
import type { EngineApi, EngineDoc, EngineNode } from './engine-api.js';
import type { BlockId, BlockRec, PlacementModel } from './placement/model.js';
import type { Stream, TextEngine } from './text/model.js';
import {
	AT,
	BLOCK_ATTR_ROOT,
	DATA,
	DATA_LEAF_PREFIX,
	DEL_PREFIX,
	HORIZON_ATTR,
	HORIZON_ROOT,
	isNodeLike,
	REC_PREFIX,
	REGISTRY_KEY,
	WITHDRAW_PREFIX
} from './schema.js';
import { bindDeletes, type Span } from './text/deletes.js';
import { baseIdOf, isIncarnationId } from './incarnations.js';

/** The horizon: the time and encoded state vector of the room's epoch (`room.purge.timing`). */
export type Horizon = { at: number; sv: Uint8Array };

/** What one purge wrote. */
export type PurgeReport = {
	/** Blocks removed: registry entry deleted, node collected. */
	removed: number;
	/** Deleted blocks kept (they delimit a live text, or a block is placed under them) whose stream, data and claims were deleted. */
	emptied: number;
	/** Text delete mark records deleted. */
	marks: number;
	/** Restoration records deleted (their copies collected). */
	records: number;
	/** Placement candidates dropped (runner-ups of an old, accepted winner). */
	candidates: number;
	/** Claims naming a removed block, deleted from the blocks that hold them. */
	claims: number;
};

type Item = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	countable?: boolean;
	right: Item | null;
	content: { arr?: unknown[] };
};

const mapOf = (node: EngineNode): Map<string, Item> =>
	(node as unknown as { _map: Map<string, Item> })._map;

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
	const D = bindDeletes(Y);

	/**
	 * Purge from `doc` (through `facade`, the facade over it) what was
	 * deleted before `horizon`, and write the horizon record. Runs inside the
	 * caller's transaction.
	 */
	const purge = (
		doc: EngineDoc,
		facade: { model: PlacementModel; text: TextEngine },
		horizon: Horizon
	): PurgeReport => {
		const M = facade.model;
		const T = facade.text;
		const report: PurgeReport = {
			removed: 0,
			emptied: 0,
			marks: 0,
			records: 0,
			candidates: 0,
			claims: 0
		};
		const vector = Y.decodeStateVector(horizon.sv) as Map<number, number>;
		const old = (client: number, clock: number) => clock < (vector.get(client) ?? 0);
		const oldItem = (item: Item | undefined) =>
			item !== undefined && !item.deleted && old(item.id.client, item.id.clock);
		const view = M.view(doc);
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
			for (
				let it = (s.text as unknown as { _start: Item | null })._start;
				it !== null;
				it = it.right
			) {
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
		// stream held was deleted, and its children left, before the horizon.
		const children = new Map<BlockId, BlockId[]>();
		const add = (map: Map<BlockId, BlockId[]>, key: BlockId, id: BlockId) => {
			const list = map.get(key);
			if (list === undefined) map.set(key, [id]);
			else list.push(id);
		};
		for (const [id, rec] of blocks)
			for (const c of rec.cands) if (typeof c.p === 'string') add(children, c.p, id);
		const winnerOld = (rec: BlockRec) =>
			oldItem(mapOf(rec.node.getAttr(AT) as EngineNode)?.get(rec.cands[0]?.key));
		for (let grew = true; grew; ) {
			grew = false;
			for (const id of shells) {
				if (dead.has(id)) continue;
				const s = own.streamOf(id);
				if (s !== undefined && !D.heldBefore(doc, regionSpans(s), old)) continue;
				const left = (children.get(id) ?? []).every((child) => {
					const rec = blocks.get(child)!;
					return rec.cands[0]?.p === id ? dead.has(child) : winnerOld(rec);
				});
				if (!left) continue;
				dead.add(id);
				grew = true;
			}
		}
		// A losing incarnation (H13) dies with its key's block too.
		for (const id of blocks.keys()) if (isIncarnationId(id) && dead.has(baseIdOf(id))) dead.add(id);

		// ── Which of them go whole ────────────────────────────────────────
		// A text family: the blocks with a stream in one backing text, and the
		// block owning it. It goes whole or not at all: a stream whose
		// delimiting block went would join the stream before it.
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
			// A key's block and its losing incarnations go together or stay together (H13).
			if (isIncarnationId(id)) join(id, baseIdOf(id));
		}
		const families = new Map<BlockId, BlockId[]>();
		for (const id of blocks.keys()) add(families, root(id), id);
		const removable = new Set<BlockId>();
		for (const family of families.values())
			if (family.every((id) => dead.has(id))) for (const id of family) removable.add(id);
		// Nothing that stays may be placed under a block that goes.
		for (let shrank = true; shrank; ) {
			shrank = false;
			for (const [id, pl] of placements) {
				if (removable.has(id) || typeof pl.parent !== 'string' || !removable.has(pl.parent))
					continue;
				for (const member of families.get(root(pl.parent)) ?? []) removable.delete(member);
				shrank = true;
			}
		}

		// ── The writes ────────────────────────────────────────────────────
		// A deleted block that stays: its stream's text (boundaries kept), its
		// data leaves and its claims.
		const emptied = [...dead].filter((id) => !removable.has(id));
		T.purgeStreams(
			emptied.flatMap((id) => {
				const s = own.streamOf(id);
				return s === undefined || s.end - s.start <= s.inert.length ? [] : [s];
			})
		);
		for (const id of emptied) {
			const rec = blocks.get(id)!;
			for (const key of [...rec.node.attrKeys()])
				if (key === DATA || key.startsWith(DATA_LEAF_PREFIX)) rec.node.deleteAttr(key);
			if (rec.claimsNode !== undefined && rec.claims.length > 0)
				rec.claimsNode.delete(0, rec.claimsNode.length);
			report.emptied++;
		}
		// The blocks that go whole: their entries, attribution records and the claims naming them.
		const registry = doc.get(REGISTRY_KEY);
		const attribution = doc.get(BLOCK_ATTR_ROOT);
		for (const [id, rec] of blocks) {
			// An emptied block's claims are gone already (above).
			if (removable.has(id) || dead.has(id) || rec.claimsNode === undefined) continue;
			const named = rec.claims
				.filter((c) => removable.has(c.m))
				.map((c) => c.seqIndex)
				.filter((at) => at >= 0);
			for (const at of named.sort((a, b) => b - a)) rec.claimsNode.delete(at, 1);
			report.claims += named.length;
		}
		for (const id of removable) {
			if (isIncarnationId(id)) {
				// A losing incarnation is no registry value: its subtree goes (H13).
				// Its node is a deleted value, which the node API writes nothing to:
				// its attrs' items are deleted directly, in this transaction.
				const attrs = mapOf(blocks.get(id)!.node) as unknown as Map<
					string,
					{ deleted: boolean; delete(tr: unknown): void }
				>;
				doc.transact((tr) => {
					for (const item of attrs.values()) if (!item.deleted) item.delete(tr);
				});
				report.removed++;
				continue;
			}
			registry.deleteAttr(id);
			if (attribution.getAttr(`${REC_PREFIX}${id}`) !== undefined)
				attribution.deleteAttr(`${REC_PREFIX}${id}`);
			report.removed++;
		}
		// Runner-up candidates of an old winner that stands.
		for (const [id, rec] of blocks) {
			if (removable.has(id) || rec.cands.length < 2) continue;
			const winner = rec.cands[0];
			const at = rec.node.getAttr(AT);
			if (!isNodeLike(at) || !oldItem(mapOf(at).get(winner.key))) continue;
			const pl = placements.get(id);
			const p = winner.p !== null && !blocks.has(winner.p) ? null : winner.p;
			if (pl === undefined || pl.parent !== p || pl.rank !== winner.r) continue;
			for (const c of rec.cands.slice(1)) at.deleteAttr(c.key);
			report.candidates += rec.cands.length - 1;
		}
		// Text delete marks and restoration records past the horizon.
		const text = D.purge(doc, old);
		report.marks = text.marks;
		report.records = text.records;
		// The horizon record, last.
		doc.get(HORIZON_ROOT).setAttr(HORIZON_ATTR, { at: horizon.at, sv: horizon.sv });
		return report;
	};

	return { purge };
};

export type PurgeBinding = ReturnType<typeof bindPurge>;
