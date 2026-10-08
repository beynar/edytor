/**
 * The change report: the fold against the last published index, one per
 * commit that changed the visible document, and the projection it carries.
 */
import { cloneJsonSafe, sameIds } from '../../../utils/json.js';
import { readData } from '../../data.js';
import type { EngineDoc } from '../../engine-api.js';
import type { BlockId, ContentItem, ProjectedBlock } from '../../placement/model.js';
import { callEach } from '../../protocols/observable.js';
import { protectItems } from '../model.js';
import type { IndexReport } from '../runs.js';
import type { IndexCache } from './cache.js';
import type { IndexFold } from './fold.js';
import type { IndexPlacement } from './placement.js';
import { EMPTY_IDS, dataOf, indexChecks, keyOf } from './shared.js';
import type { IndexState, Published, Tx } from './state.js';

/** The change report of one doc's index. */
export const indexReporter = (ix: IndexState & IndexPlacement & IndexCache & IndexFold) => {
	const {
		T,
		doc,
		dataRoot,
		blocks,
		following,
		dirtyLists,
		leftLists,
		candidates,
		ownShim,
		ensurePlacements,
		typeOf,
		intern,
		runs,
		syncAll
	} = ix;

	const docData = (): Record<string, unknown> => cloneJsonSafe(readData(dataRoot) ?? {});
	let dataChanged = false;

	// ── projection ───────────────────────────────────────────────────

	/** `id`'s visible content items, canonical and frozen (R4). */
	const itemsOf = (id: BlockId): ContentItem[] =>
		protectItems(T.readSegs(ownShim.display(id) ?? []), intern) as ContentItem[];

	const projectBlock = (id: BlockId): ProjectedBlock => {
		const rec = blocks.get(id)!;
		const projected: ProjectedBlock = {
			id,
			type: typeOf(id),
			data: dataOf(rec),
			content: itemsOf(id),
			children: []
		};
		for (const k of ix.kidsMap.get(id) ?? []) projected.children.push(projectBlock(k.id));
		return projected;
	};

	// ── the change report: the fold against the last published index ─

	let published: Published | null = null;
	const reportSubs = new Set<(r: IndexReport, origin: unknown, local: boolean) => void>();

	/** The reachable tree — nodes carry `prev`'s published payloads where they exist. */
	const reachable = (prev?: Published['nodes']): Published => {
		ensurePlacements();
		const nodes: Published['nodes'] = new Map();
		const order: Published['order'] = new Map();
		const stack: (BlockId | null)[] = [null];
		for (let parent = stack.pop(); parent !== undefined; parent = stack.pop()) {
			const ks = ix.kidsMap.get(parent) ?? [];
			if (ks.length === 0) continue;
			order.set(parent, Object.freeze(ks.map((k) => k.id)));
			for (let index = ks.length - 1; index >= 0; index--) stack.push(ks[index].id);
			ks.forEach(({ id }, index) => {
				const old = prev?.get(id);
				const rec = blocks.get(id)!;
				nodes.set(
					id,
					old === undefined
						? { parent, index, type: typeOf(id), data: rec.data, runs: runs(id) }
						: { ...old, parent, index }
				);
			});
		}
		return { nodes, order, kids: ix.kidsVersion };
	};

	/**
	 * The report's structural part from the child lists patched since the
	 * last report (P3), advancing the published tree in place — what
	 * `reachable` would give, without walking the lists nothing changed:
	 * a published block no longer shown leaves (a root when its parent
	 * stays), its still-shown descendants staying; each patched list's
	 * new order is news, a block in it at a new parent or index moved, one
	 * not published before is added with its subtree.
	 */
	const advance = (
		pub: Published,
		r: IndexReport,
		covered: Set<BlockId>,
		reparented: Set<BlockId>
	): void => {
		const { nodes, order } = pub;
		const shown = (x: BlockId): boolean => {
			for (let c: BlockId | null = x; c !== null; ) {
				const slot = ix.slots.get(c);
				if (slot === undefined) return false;
				c = slot.parent;
			}
			return true;
		};
		const lists = [...dirtyLists];
		// Leaving: a published block of a patched list that no longer shows.
		const drop = (id: BlockId): void => {
			const ks = order.get(id);
			if (ks !== undefined) {
				order.delete(id);
				r.order.set(id, EMPTY_IDS);
				for (const k of ks) if (!shown(k)) drop(k);
			}
			nodes.delete(id);
		};
		for (const id of leftLists) {
			const o = nodes.get(id);
			if (o === undefined || shown(id)) continue;
			if (o.parent === null || shown(o.parent)) r.removed.add(id);
			drop(id);
		}
		// Each patched list that shows: its order, its moved and new blocks.
		const fresh = new Map<BlockId, { parent: BlockId | null; index: number }>();
		for (const p of lists) {
			if (p !== null && !shown(p)) continue;
			const ks = ix.kidsMap.get(p) ?? [];
			const prev = order.get(p);
			if (ks.length === 0) {
				if (prev !== undefined) {
					order.delete(p);
					r.order.set(p, EMPTY_IDS);
				}
				continue;
			}
			const ids = ks.map((k) => k.id);
			if (prev === undefined || !sameIds(prev, ids)) {
				const frozen = Object.freeze(ids);
				order.set(p, frozen);
				r.order.set(p, frozen);
			}
			ks.forEach(({ id }, index) => {
				const n = nodes.get(id);
				if (n === undefined) fresh.set(id, { parent: p, index });
				else if (n.parent !== p || n.index !== index) {
					r.moved.add(id);
					if (n.parent !== p) reparented.add(id);
					n.parent = p;
					n.index = index;
				}
			});
		}
		// New roots (no new ancestor) bring their subtree.
		const add = (b: ProjectedBlock, parent: BlockId | null, index: number): void => {
			if (!nodes.has(b.id)) {
				covered.add(b.id);
				const rec = blocks.get(b.id)!;
				nodes.set(b.id, { parent, index, type: typeOf(b.id), data: rec.data, runs: runs(b.id) });
			}
			if (b.children.length > 0 && !order.has(b.id)) {
				const ids = Object.freeze(b.children.map((c) => c.id));
				order.set(b.id, ids);
				r.order.set(b.id, ids);
			}
			b.children.forEach((c, i) => add(c, b.id, i));
		};
		for (const [id, at] of fresh) {
			let under = false;
			for (
				let c = ix.slots.get(id)?.parent ?? null;
				c !== null && !under;
				c = ix.slots.get(c)?.parent ?? null
			)
				under = fresh.has(c);
			if (under || covered.has(id)) continue;
			const b = projectBlock(id);
			r.added.set(id, b);
			add(b, at.parent, at.index);
		}
	};

	/** The blocks whose shown kind followed their slot at the last report. */
	let followingBefore: BlockId[] = [];
	/** The document data's key at the last report. */
	let dataKey = '';
	/** Build the commit's report and advance the published index to it. */
	const report = (): IndexReport | null => {
		const before = published!;
		// Fold every queued transaction first: a follow-up a cleanup
		// started (a delete-mark repair) has already written, and the
		// first content read below would fold it mid-report, after the
		// child lists were read (H7 fuzz, rich lane, seeds 651 and 1271).
		syncAll();
		ensurePlacements();
		const r: IndexReport = {
			added: new Map(),
			removed: new Set(),
			moved: new Set(),
			meta: new Map(),
			content: new Map(),
			order: new Map()
		};
		// The document's data is news when it differs from what was published.
		if (dataChanged) {
			dataChanged = false;
			const data = docData();
			const key = keyOf(data);
			if (key !== dataKey) [r.data, dataKey] = [data, key];
		}
		if (ix.kidsVersion === before.kids && candidates.size === 0) return r.data ? r : null;
		// Added subtrees carry their new descendants. A descendant that was
		// visible before is reported like any visible block (moved, retyped,
		// edited against its published baseline), so consumers keep it (K7).
		const covered = new Set<BlockId>();
		/** Moved to another display parent: only those can show another kind (an index never does). */
		const reparented = new Set<BlockId>();
		const lists = ix.kidsVersion !== before.kids && !ix.allListsDirty;
		const after = ix.kidsVersion === before.kids || lists ? before : reachable(before.nodes);
		if (lists) advance(before, r, covered, reparented);
		else if (after !== before) {
			for (const [parent, ids] of after.order) {
				const prev = before.order.get(parent);
				if (prev === undefined || !sameIds(prev, ids)) r.order.set(parent, ids);
			}
			for (const parent of before.order.keys()) {
				if (!after.order.has(parent)) r.order.set(parent, EMPTY_IDS);
			}
			const register = (b: ProjectedBlock): void => {
				if (!before.nodes.has(b.id)) covered.add(b.id);
				b.children.forEach(register);
			};
			for (const [id, n] of after.nodes) {
				if (!before.nodes.has(id)) {
					if (covered.has(id)) continue;
					const b = projectBlock(id);
					r.added.set(id, b);
					register(b);
				} else {
					const o = before.nodes.get(id)!;
					if (o.parent !== n.parent || o.index !== n.index) r.moved.add(id);
					if (o.parent !== n.parent) reparented.add(id);
				}
			}
			// Removed subtree ROOTS: a removed id whose before-parent stays
			// visible (or is the root). One under a removed parent leaves with
			// it; one under a surviving child of a removed subtree does not.
			for (const [id, o] of before.nodes) {
				if (after.nodes.has(id)) continue;
				if (o.parent === null || after.nodes.has(o.parent)) r.removed.add(id);
			}
		}
		const meta = (id: BlockId, n: NonNullable<ReturnType<typeof after.nodes.get>>) => {
			const rec = blocks.get(id)!;
			const type = typeOf(id);
			r.meta.set(id, { type, data: dataOf(rec) });
			n.type = type;
			n.data = rec.data;
		};
		for (const id of candidates) {
			const n = after.nodes.get(id);
			if (n === undefined || covered.has(id)) continue;
			const rec = blocks.get(id)!;
			if (typeOf(id) !== n.type || keyOf(rec.data) !== keyOf(n.data)) meta(id, n);
			const next = runs(id);
			if (next !== n.runs) {
				const key = keyOf(next);
				if ((n.key ??= keyOf(n.runs)) !== key) r.content.set(id, next);
				n.runs = next;
				n.key = key;
			}
		}
		// A block that starts or stops displaying a kind other than its
		// stored one moved, or its kind follows (or followed) its slot:
		// its kind is news. Without a placement change, only a retype
		// changes a shown kind — the retyped block's (a candidate) and the
		// kinds derived from it: a promoted or stray line shows its display
		// parent's default child (XW-08).
		if (after !== before || lists || ix.retyped) {
			const now = [...following];
			for (const id of [...reparented, ...now, ...followingBefore]) {
				const n = after.nodes.get(id);
				if (n !== undefined && !candidates.has(id) && !covered.has(id) && typeOf(id) !== n.type)
					meta(id, n);
			}
			followingBefore = now;
		}
		// A plain block directly in a list shows as its item (`itemOf`, AW-04):
		// a block whose shown kind changed re-reads its children's (a worklist:
		// the map visits the entries added meanwhile).
		for (const id of r.meta.keys())
			for (const { id: kid } of ix.kidsMap.get(id) ?? []) {
				const n = after.nodes.get(kid);
				if (n !== undefined && !covered.has(kid) && !r.meta.has(kid) && typeOf(kid) !== n.type)
					meta(kid, n);
			}
		ix.retyped = false;
		candidates.clear();
		published = after;
		after.kids = ix.kidsVersion;
		dirtyLists.clear();
		leftLists.clear();
		ix.allListsDirty = false;
		if (indexChecks.on) ix.checks!.checkPublished(published!);
		const empty =
			r.added.size + r.removed.size + r.moved.size + r.meta.size + r.content.size + r.order.size;
		return empty === 0 && !r.data ? null : r;
	};

	/** Report the commit (or role change) to every subscriber, when it changed the visible document. */
	const publish = (origin: unknown, local: boolean): void => {
		const r = report();
		if (r !== null) callEach('[edytor-doc] change', [...reportSubs], r, origin, local);
	};
	const onUpdate = (_u: Uint8Array, origin: unknown, _d: EngineDoc, tr: unknown): void => {
		if ((tr as Tx).changed?.has(dataRoot)) dataChanged = true;
		publish(origin, (tr as { local?: boolean }).local === true);
	};

	/** Subscribe to the change report; the first subscription takes the baseline. */
	const onReport = (
		cb: (r: IndexReport, origin: unknown, local: boolean) => void
	): (() => void) => {
		if (reportSubs.size === 0) {
			syncAll();
			published = reachable();
			dataKey = keyOf(docData());
			candidates.clear();
			ix.reporting = true;
			doc.on('update', onUpdate);
		}
		reportSubs.add(cb);
		return () => {
			if (!reportSubs.delete(cb) || reportSubs.size > 0) return;
			doc.off('update', onUpdate);
			published = null;
			ix.reporting = false;
			candidates.clear();
		};
	};
	const hasSubscribers = (): boolean => reportSubs.size > 0;

	return {
		itemsOf,
		projectBlock,
		reachable,
		publish,
		onUpdate,
		onReport,
		hasSubscribers
	};
};

export type IndexReporter = ReturnType<typeof indexReporter>;
