/**
 * Restore a version as a forward edit (H11, `room.history.restore` in
 * `docs/editor-delete-contract.md`): make the visible document equal a
 * JSON snapshot, inside the caller's ONE transaction, keeping every block
 * id the registry still holds and writing only what differs. Worker-safe
 * (the room runs it); DOM- and Svelte-free.
 *
 * What it writes, in order (each step reads the index the previous ones
 * left, mid-transaction):
 *
 * 1. a snapshot block whose node exists loses its delete and withdraw
 *    marks; every merge claim a live (or revived) block holds on a
 *    snapshot block is removed, so it displays on its own;
 * 2. its type and data, per leaf, where they differ;
 * 3. its place: under its snapshot parent, in the snapshot's order (the
 *    longest run of that parent's children already in order stays; each
 *    other block gets a placement candidate between its neighbours); a
 *    snapshot block the registry no longer holds is created there;
 * 4. its content, where it differs: its own claims removed, then its
 *    stream's text replaced through the facade's per-stream delete and
 *    insert, the common prefix and suffix kept;
 * 5. every visible block outside the snapshot gets the writer's delete
 *    mark, with every block it displays (R3);
 * 6. the document's data, patched to the snapshot's.
 */
import type { EngineDoc, EngineNode } from './engine-api.js';
import type {
	BlockId,
	BlockSpec,
	ContentItem,
	InlineSpec,
	PlacementModel
} from './placement/model.js';
import type { DataPatch } from './data.js';
import { DEL_PREFIX, TYPE, WITHDRAW_PREFIX } from './schema.js';
import { patchWrites, writeLeaves } from './data.js';
import { canonKey } from './text/model.js';
import { randOf } from './rand.js';
import type { JSONDoc } from '../utils/json.js';
import { toBlockSpec } from '../utils/json.js';

type Unit = { key: string; item: ContentItem };

/** `items` one unit each (a character with its marks, or an atom), keyed for comparison. */
const unitsOf = (items: readonly ContentItem[]): Unit[] => {
	const out: Unit[] = [];
	for (const item of items) {
		if (item.kind === 'inline') {
			out.push({
				key: `@${item.id}|${item.type}|${canonKey(item.data ?? {})}`,
				item: { kind: 'inline', id: item.id, type: item.type, data: item.data ?? {} }
			});
			continue;
		}
		const marks = item.marks ?? {};
		const tag = canonKey(marks);
		for (const ch of item.text)
			out.push({ key: `${ch}|${tag}`, item: { kind: 'text', text: ch, marks } });
	}
	return out;
};

/** Units back to runs: consecutive characters with the same marks joined. */
const runsOf = (units: readonly Unit[]): ContentItem[] => {
	const out: ContentItem[] = [];
	let tag: string | null = null;
	for (const { key, item } of units) {
		const last = out[out.length - 1];
		if (item.kind === 'text') {
			const mine = key.slice(key.indexOf('|') + 1);
			if (last?.kind === 'text' && tag === mine) last.text += item.text;
			else out.push({ kind: 'text', text: item.text, marks: item.marks });
			tag = mine;
		} else {
			out.push(item);
			tag = null;
		}
	}
	return out;
};

/** Visible-tree order of `specs` with each block's snapshot parent. */
const walk = (
	specs: readonly BlockSpec[],
	parent: BlockId | null,
	into: Map<BlockId, { spec: BlockSpec; parent: BlockId | null }>
) => {
	for (const spec of specs) {
		into.set(spec.id, { spec, parent });
		walk(spec.children ?? [], spec.id, into);
	}
	return into;
};

/** The ids of `list` (positions in another order, `-1` absent) on its longest increasing run. */
const longestRun = (positions: readonly number[]): Set<number> => {
	const tails: number[] = [];
	const tailAt: number[] = [];
	const links: number[] = new Array(positions.length).fill(-1);
	positions.forEach((position, i) => {
		if (position < 0) return;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (tails[mid] < position) lo = mid + 1;
			else hi = mid;
		}
		tails[lo] = position;
		tailAt[lo] = i;
		links[i] = lo > 0 ? tailAt[lo - 1] : -1;
	});
	const kept = new Set<number>();
	for (let i = tails.length ? tailAt[tails.length - 1] : -1; i !== -1; i = links[i]) kept.add(i);
	return kept;
};

export type RestoreReport = {
	/** Blocks revived (their delete or withdraw marks removed). */
	revived: number;
	/** Blocks given another place. */
	moved: number;
	/** Blocks whose content was rewritten. */
	rewritten: number;
	/** Blocks created (absent from the registry). */
	created: number;
	/** Blocks deleted (visible, absent from the snapshot). */
	deleted: number;
};

/** What a restore reads and writes through: the facade over the document (structurally). */
export type RestoreFacade<Plan> = {
	model: PlacementModel;
	childSlots(parent: BlockId | null): readonly { id: BlockId; rank: string }[];
	contentItems(id: BlockId): ContentItem[];
	apply(plan: Plan): unknown;
	prepare: {
		deleteText(id: BlockId, offset: number, length: number): Plan;
		insertText(id: BlockId, offset: number, text: string, marks?: Record<string, unknown>): Plan;
		insertInline(id: BlockId, offset: number, atom: InlineSpec): Plan;
		patchData(target: null, ops: DataPatch[]): Plan;
	};
};

/**
 * Make the visible document `doc` (through `facade`, the facade over it)
 * equal `json`. Runs inside the caller's transaction; the writer is
 * `doc.clientID`. See the module comment for what it writes.
 */
export const restoreDocument = <Plan>(
	doc: EngineDoc,
	facade: RestoreFacade<Plan>,
	json: JSONDoc
): RestoreReport => {
	const M = facade.model;
	const report: RestoreReport = { revived: 0, moved: 0, rewritten: 0, created: 0, deleted: 0 };
	const specs = json.children.map((block) => toBlockSpec(block));
	const all = walk(specs, null, new Map());
	const node = (id: BlockId): EngineNode | null => M.blockNodeOf(doc, id);

	// 1 · Revive, and free every snapshot block from the claims on it.
	for (const id of all.keys()) {
		const n = node(id);
		if (n === null) continue;
		const marks = [...n.attrKeys()].filter(
			(key) => key.startsWith(DEL_PREFIX) || key.startsWith(WITHDRAW_PREFIX)
		);
		for (const key of marks) n.deleteAttr(key);
		if (marks.length > 0) report.revived++;
	}
	{
		const { blocks } = M.view(doc);
		for (const rec of blocks.values()) {
			// A deleted holder's claims are void (and stay so): only the others.
			if (rec.deleted || rec.claimsNode === undefined) continue;
			// The claims its list stores (an anchor may show one in another block).
			const named = (rec.listClaims ?? rec.claims)
				.filter((claim) => all.has(claim.m))
				.map((c) => c.seqIndex)
				.filter((at) => at >= 0);
			for (const at of named.sort((a, b) => b - a)) rec.claimsNode.delete(at, 1);
		}
	}

	// 2 · Type and data, per leaf, where they differ.
	for (const [id, { spec }] of all) {
		const n = node(id);
		if (n === null) continue;
		if (n.getAttr(TYPE) !== spec.type) n.setAttr(TYPE, spec.type);
		writeLeaves(
			n,
			patchWrites(n, [{ path: [], value: spec.data ?? {} }], doc.clientID, randOf(doc)) ?? []
		);
	}

	// 3 · Places, parent by parent in snapshot order (the root first).
	const parents: Array<[BlockId | null, BlockSpec[]]> = [[null, specs]];
	for (const [id, { spec }] of all) parents.push([id, spec.children ?? []]);
	for (const [parent, list] of parents) {
		if (list.length === 0) continue;
		const slots = facade.childSlots(parent);
		const index = new Map(slots.map((slot, i) => [slot.id, i] as const));
		const kept = longestRun(list.map((spec) => index.get(spec.id) ?? -1));
		let prev: string | undefined;
		list.forEach((spec, i) => {
			if (kept.has(i)) {
				prev = slots[index.get(spec.id)!].rank;
				return;
			}
			let next: string | undefined;
			for (let j = i + 1; j < list.length; j++)
				if (kept.has(j)) {
					next = slots[index.get(list[j].id)!].rank;
					break;
				}
			const bounds = [
				...(prev === undefined ? [] : [{ rank: prev }]),
				...(next === undefined ? [] : [{ rank: next }])
			];
			const [rank] = M.ranksAt(bounds, prev === undefined ? 0 : 1, 1, doc.clientID, randOf(doc));
			const n = node(spec.id);
			if (n === null) {
				M.materializeSpec(doc, { ...spec, children: [] }, parent, rank);
				report.created++;
			} else {
				M.writePlacement(doc, n, parent, rank);
				report.moved++;
			}
			prev = rank;
		});
	}

	// 4 · Content, where it differs: own claims removed, the stream rewritten.
	for (const [id, { spec }] of all) {
		const want = unitsOf(spec.content ?? []);
		let have = unitsOf(facade.contentItems(id));
		if (have.length === want.length && have.every((u, i) => u.key === want[i].key)) continue;
		const rec = M.view(doc).blocks.get(id);
		const claims = rec?.claimsNode;
		if (claims !== undefined && claims.length > 0) {
			claims.delete(0, claims.length);
			have = unitsOf(facade.contentItems(id));
		}
		let head = 0;
		while (head < have.length && head < want.length && have[head].key === want[head].key) head++;
		let tail = 0;
		while (
			tail < have.length - head &&
			tail < want.length - head &&
			have[have.length - 1 - tail].key === want[want.length - 1 - tail].key
		)
			tail++;
		const removed = have.length - head - tail;
		if (removed > 0) facade.apply(facade.prepare.deleteText(id, head, removed));
		let at = head;
		for (const item of runsOf(want.slice(head, want.length - tail))) {
			if (item.kind === 'text') {
				facade.apply(facade.prepare.insertText(id, at, item.text, item.marks ?? {}));
				at += item.text.length;
			} else {
				facade.apply(
					facade.prepare.insertInline(id, at, { id: item.id, type: item.type, data: item.data })
				);
				at += 1;
			}
		}
		report.rewritten++;
	}

	// 5 · Every visible block outside the snapshot is deleted, with what it displays.
	for (let round = 0; round < 8; round++) {
		const view = M.view(doc);
		const extra = view.order.ids.filter((id) => !all.has(id));
		if (extra.length === 0) break;
		for (const id of extra) {
			for (const shown of view.displays(id)) {
				if (all.has(shown)) continue;
				const n = node(shown);
				if (n === null || n.getAttr(DEL_PREFIX + doc.clientID) === true) continue;
				n.setAttr(DEL_PREFIX + doc.clientID, true);
				report.deleted++;
			}
		}
	}

	// 6 · The document's data.
	facade.apply(facade.prepare.patchData(null, [{ path: [], value: json.data ?? {} }]));
	return report;
};
