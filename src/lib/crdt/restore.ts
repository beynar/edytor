/**
 * Restore a version as a forward edit (`room.history.restore` in
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
 *    other block is moved after the one before it); a snapshot block the
 *    registry no longer holds is created there;
 * 4. its content, where it differs: its own claims removed, then its
 *    stream's text replaced through the facade's per-stream delete and
 *    insert, the common prefix and suffix kept;
 * 5. every visible block outside the snapshot gets the writer's delete
 *    mark, with every block it displays;
 * 6. the document's data, patched to the snapshot's.
 */
import type { EngineDoc, EngineNode } from './engine-api.js';
import {
	blockNodeOf,
	insertSpecsAt,
	moveBlocksTo,
	view as modelView,
	type BlockId,
	type BlockSpec,
	type ContentItem,
	type InlineSpec,
	type PlacementModel
} from './placement/model.js';
import type { DataPatch } from './data.js';
import { DEL_PREFIX, TYPE, WITHDRAW_PREFIX } from './schema.js';
import { common, patchWrites, writeData } from './data.js';
import { canonKey, deleteClaims } from './text/model.js';
import { randOf } from './rand.js';
import type { JSONDoc } from '../utils/json.js';
import { toBlockSpec } from '../utils/json.js';

/** One display unit: a character (a code point) with its marks, or an inline atom, keyed for comparison. */
export type Unit = { key: string; item: ContentItem };

/** `items` one unit each (a character with its marks, or an atom), keyed for comparison. */
export const unitsOf = (items: readonly ContentItem[]): Unit[] => {
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

/** The one changed stretch from `x` to `y`: `x[p, e)` became `mid`. */
export const hunk = (x: readonly Unit[], y: readonly Unit[]) => {
	let p = 0;
	while (p < x.length && p < y.length && x[p].key === y[p].key) p++;
	let q = 0;
	while (
		q < x.length - p &&
		q < y.length - p &&
		x[x.length - 1 - q].key === y[y.length - 1 - q].key
	)
		q++;
	return { p, e: x.length - q, mid: y.slice(p, y.length - q) };
};

/** A unit's width in the block's offsets (a character's UTF-16 length; an atom counts 1). */
const width = (u: Unit) => (u.item.kind === 'text' ? u.item.text.length : 1);

/**
 * Make block `id`'s content, `have` (its units now), read `want`: the one
 * changed stretch between their common prefix and suffix is deleted and
 * written again through the facade (an atom without an id gets a fresh
 * one). Whether it wrote anything.
 */
export const rewriteContent = <Plan>(
	facade: Pick<RestoreFacade<Plan>, 'apply' | 'prepare'>,
	id: BlockId,
	have: readonly Unit[],
	want: readonly Unit[]
): boolean => {
	const { p, e, mid } = hunk(have, want);
	if (p === e && mid.length === 0) return false;
	let at = have.slice(0, p).reduce((n, u) => n + width(u), 0);
	const gone = have.slice(p, e).reduce((n, u) => n + width(u), 0);
	if (gone > 0) facade.apply(facade.prepare.deleteText(id, at, gone));
	for (const item of runsOf(mid)) {
		if (item.kind === 'text') {
			facade.apply(facade.prepare.insertText(id, at, item.text, item.marks ?? {}));
			at += item.text.length;
		} else {
			const atom = { id: item.id || crypto.randomUUID(), type: item.type, data: item.data };
			facade.apply(facade.prepare.insertInline(id, at, atom));
			at += 1;
		}
	}
	return true;
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
	const report: RestoreReport = { revived: 0, moved: 0, rewritten: 0, created: 0, deleted: 0 };
	const specs = json.children.map((block) => toBlockSpec(block));
	const all = walk(specs, null, new Map());
	const node = (id: BlockId): EngineNode | null => blockNodeOf(doc, id);

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
		const { blocks } = modelView(doc);
		for (const rec of blocks.values()) {
			// A deleted holder's claims are void (and stay so): only the others.
			if (!rec.deleted)
				deleteClaims(
					doc,
					rec.claims.filter((claim) => all.has(claim.m))
				);
		}
	}

	// 2 · Type and data, per leaf, where they differ.
	for (const [id, { spec }] of all) {
		const n = node(id);
		if (n === null) continue;
		if (n.getAttr(TYPE) !== spec.type) n.setAttr(TYPE, spec.type);
		writeData(
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
		// What a longest common run of the two orders keeps stays where it is.
		const kept = new Set(
			common(
				slots.map((slot) => slot.id),
				list.map((spec) => spec.id)
			).map(([, j]) => j)
		);
		let prev: BlockId | null = null;
		list.forEach((spec, i) => {
			if (kept.has(i)) {
				prev = spec.id;
				return;
			}
			const v = modelView(doc);
			// Right after the block before it in the snapshot (the list as it stands, the block itself left out).
			const shown = (v.kids.get(parent) ?? []).map((k) => k.id).filter((id) => id !== spec.id);
			const at = prev === null ? 0 : shown.indexOf(prev) + 1;
			const n = node(spec.id);
			if (n === null) {
				insertSpecsAt(doc, v, parent, at, [{ ...spec, children: [] }]);
				report.created++;
			} else {
				moveBlocksTo(doc, v, [spec.id], parent, at);
				report.moved++;
			}
			prev = spec.id;
		});
	}

	// 4 · Content, where it differs: own claims removed, the stream rewritten.
	for (const [id, { spec }] of all) {
		const want = unitsOf(spec.content ?? []);
		let have = unitsOf(facade.contentItems(id));
		if (have.length === want.length && have.every((u, i) => u.key === want[i].key)) continue;
		const claims = modelView(doc).blocks.get(id)?.claims ?? [];
		if (claims.some((c) => c.stamp.c >= 0)) {
			deleteClaims(doc, claims);
			have = unitsOf(facade.contentItems(id));
		}
		rewriteContent(facade, id, have, want);
		report.rewritten++;
	}

	// 5 · Every visible block outside the snapshot is deleted, with what it displays.
	for (let round = 0; round < 8; round++) {
		const view = modelView(doc);
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
