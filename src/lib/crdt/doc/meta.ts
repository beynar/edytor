/**
 * A block's meta: its type (`setBlockType`, the steps a retype implies) and
 * its data, a block's, an atom's or the document's (`patchData`, the data
 * steps of a patch), and the baseline `setBlock`.
 */
import { randOf } from '../rand.js';
import { TYPE } from '../schema.js';
import { sanitizeSpec, sanitizeWireJson } from '../../utils/json.js';
import { patchWrites, leafKey, isObject, type DataPatch } from '../data.js';
import {
	promotedRank,
	type BlockId,
	type BlockSpec,
	type ContentItem
} from '../placement/model.js';
import { ref, refused, sanitizeItem } from './plan.js';
import type { Prepared, PlanStep, DataTarget } from './types.js';
import type { OpsContext } from './steps.js';

/** The meta ops of one facade, prepared. */
export const metaOps = (c: OpsContext) => {
	const {
		doc,
		M,
		roles,
		roleOf,
		dataNode,
		view,
		blockTypeOf,
		blockDataOf,
		childrenIds,
		positionOf,
		is,
		isVoid,
		displayLength,
		live,
		contentTarget,
		REFUSED,
		plan,
		moveTo,
		attr,
		leavingIsland,
		settle,
		remove,
		atomOf
	} = c;

	/**
	 * The data step of `patches` (sanitized) on a block, one of its atoms or
	 * the document (`crdt/data.ts`): none when it changes nothing, `null`
	 * when a patch is refused.
	 */
	const dataSteps = (target: DataTarget, patches: DataPatch[]): PlanStep[] | null => {
		const [id, inlineId] =
			typeof target === 'object' && target ? [target.block, target.atom] : [target ?? undefined];
		const node = dataNode(id, inlineId);
		// A block kind's atomic paths are written as one leaf each (`data.atomic`, H8).
		const type = inlineId === undefined && id !== undefined ? blockTypeOf(id) : undefined;
		const atomic = (type === undefined ? undefined : roleOf(type)?.atomic) ?? [];
		const leaves = node
			? patchWrites(
					node,
					patches,
					doc.clientID,
					randOf(doc),
					atomic.map((p) => leafKey(typeof p === 'string' ? [p] : p))
				)
			: [];
		if (leaves === null) return null; // a patch fits no value there
		if (leaves.length === 0) return [];
		const offset = inlineId === undefined ? undefined : atomOf(id!, inlineId)?.at;
		return [
			{
				op: 'patchData',
				...(id !== undefined && { id }),
				...(inlineId !== undefined && { inlineId, offset }),
				ops: patches,
				leaves
			}
		];
	};
	/** A whole-data replace: a patch of the root. */
	const replaceData = (data: unknown): DataPatch[] => [{ path: [], value: sanitizeWireJson(data) }];
	/**
	 * `data`'s leaves as sets over `current` (`data.retype.keep`, H4): a
	 * plain object's keys, recursively where `current` holds an object
	 * there too; anything else (an array, a primitive, an empty object, an
	 * object where `current` holds none) as one value at its path. Nothing
	 * else under the root is touched.
	 */
	const leafSets = (data: unknown, current: unknown): DataPatch[] => {
		const out: DataPatch[] = [];
		const plainObject = (v: unknown): v is Record<string, unknown> =>
			v !== null && typeof v === 'object' && !Array.isArray(v);
		const walk = (v: unknown, at: unknown, path: string[]): void => {
			if (plainObject(v) && Object.keys(v).length > 0 && (path.length === 0 || plainObject(at)))
				for (const [k, x] of Object.entries(v))
					walk(x, plainObject(at) ? at[k] : undefined, [...path, k]);
			else if (path.length > 0) out.push({ path, value: v });
		};
		walk(sanitizeWireJson(data), current, []);
		return out;
	};

	/**
	 * The target role decides (UW-21): nothing renders a void's children,
	 * so a block retyped to a void kind hands them to the slot right after
	 * it, as the kind they show there (`settledKind`). Each moves to the
	 * rank the read-time
	 * shedding gives it (`promotedRank`, UW-21b), so a child a peer adds
	 * meanwhile keeps its place in the void's order among them. An island
	 * declared `lines` retyped to an ordinary kind keeps its lines, each
	 * retyped to the new kind's default child (the document's where that
	 * renders no content): no line kind outside its island. Any other
	 * island's children keep their kinds (a table's rows stay rows), as
	 * `typeOf` shows a child a peer adds meanwhile (DR-crdt-2).
	 */
	const retypeSteps = (id: BlockId, type: string): PlanStep[] => {
		const { kids } = view();
		const pos = positionOf(id);
		const steps = attr(id, TYPE, type);
		const moved = kids.get(id) ?? [];
		// A code block retyped to an ordinary kind keeps its lines as that kind's children
		// (`leavingIsland`: never a kind that hides their text, AW-05).
		const lined = is(id, (t) => roles.line(t) !== undefined);
		if (lined && !roles.island(type) && !roles.childless(type)) {
			const to = roles.defaultChild(type);
			return [
				...steps,
				...moved.flatMap((k) => {
					const kind = leavingIsland(id, blockTypeOf(k.id), to);
					return kind === undefined ? [] : attr(k.id, TYPE, kind);
				})
			];
		}
		if (!roles.childless(type) || moved.length === 0 || pos === null) return steps;
		const slotRank = kids.get(pos.parent)![pos.index]!.rank;
		const ids = moved.map((k) => k.id);
		return [
			...steps,
			...moveTo(
				ids,
				pos.parent,
				pos.index + 1,
				moved.map((k) => promotedRank(slotRank, k.rank))
			),
			...settle(id, ids, pos.parent)
		];
	};

	/** Set the block type (attr write — the block keeps its identity; see `retypeSteps`). */
	const setBlockType = (id: BlockId, type: string): Prepared => {
		id = ref(id);
		return live(id) ? plan([id], retypeSteps(id, ref(type))) : REFUSED;
	};

	/**
	 * Patch the data of a block, one of its inline atoms or the document
	 * (`null`), in order (`crdt/data.ts`): each patch replaces the value at
	 * its path (`value` absent deletes it), `splice` and `order` edit the
	 * array there; a path addresses array items by index, resolved here
	 * to the items' ids. Only the leaves it changes are written, so a
	 * peer's edit of another key or item is kept. Refused for an absent
	 * target, a path that is no array of strings, a root value that is no
	 * object, or an op that fits no value at its path.
	 */
	const patchData = (target: DataTarget, patches: readonly DataPatch[]): Prepared => {
		const valid = (p: DataPatch) =>
			Array.isArray(p?.path) &&
			p.path.every((k) => typeof k === 'string') &&
			(p.path.length > 0 || p.value === undefined || isObject(p.value));
		if (!Array.isArray(patches) || !patches.every(valid)) return REFUSED;
		// Only the fields a patch has: an absent one is no non-JSON value to report.
		const clean = patches.map(({ path, value, splice, order }) =>
			sanitizeWireJson({
				path,
				...(value !== undefined && { value }),
				...(splice !== undefined && { splice }),
				...(order !== undefined && { order })
			})
		);
		const t: DataTarget =
			target === null
				? null
				: typeof target === 'string'
					? ref(target)
					: { block: ref(target.block), atom: ref(target.atom) };
		if (typeof t === 'string' ? !live(t) : t !== null && atomOf(t.block, t.atom) === undefined)
			return REFUSED;
		const steps = dataSteps(t, clean);
		return steps ? plan(t === null ? [] : [typeof t === 'string' ? t : t.block], steps) : REFUSED;
	};

	/**
	 * Baseline `setBlock`: `type` updates the block in place and `data`
	 * sets the leaves it names, removing none (`data.retype.keep`, H4: a
	 * retype keeps the block's properties, as Notion's Turn into does;
	 * `setBlockData` replaces them); `content`/`children` REPLACE
	 * wholesale — explicit replacement is a
	 * new-identity operation; a retype to a void kind without `children`
	 * unnests the current ones (`retypeSteps`). All-or-nothing (D-12): children
	 * for a block that is `void` after the write, or a replacement id that
	 * is already taken (a live or deleted
	 * block, the replaced children included, or a duplicate inside the
	 * replacement), refuses before any write — `id-collision` for the
	 * latter. A caller wanting a child back re-creates it with a fresh id.
	 */
	const setBlock = (
		id: BlockId,
		value: {
			type?: string;
			data?: Record<string, unknown>;
			content?: ContentItem[];
			children?: BlockSpec[];
		}
	): Prepared => {
		id = ref(id);
		const content = value.content?.map(sanitizeItem);
		const children = value.children?.map(sanitizeSpec);
		if (!live(id) || (content !== undefined && !contentTarget(id))) return REFUSED;
		const type = value.type === undefined ? undefined : ref(value.type);
		const toVoid = type === undefined ? isVoid(id) : roles.childless(type);
		if (children?.length && toVoid) return REFUSED;
		if (children !== undefined && M.collides(doc, children)) return refused('id-collision');
		const data =
			value.data === undefined ? [] : dataSteps(id, leafSets(value.data, blockDataOf(id)));
		if (data === null) return REFUSED;
		const writes: PlanStep[] = [
			...(type === undefined
				? []
				: children === undefined
					? retypeSteps(id, type)
					: attr(id, TYPE, type)),
			...data
		];
		if (content !== undefined) {
			const length = displayLength(id);
			if (length > 0) writes.push({ op: 'deleteText', id, offset: 0, length });
			let at = 0;
			for (const item of content) {
				if (item.kind === 'inline')
					writes.push({ op: 'insertInline', id, offset: at++, atom: item });
				else if (item.text !== '') {
					writes.push({ op: 'insertText', id, offset: at, text: item.text, marks: item.marks });
					at += item.text.length;
				}
			}
		}
		if (children !== undefined) {
			for (const kid of childrenIds(id)) writes.push(remove(kid));
			// Every current child is deleted, so the new ones rank from an empty list.
			const ranks = M.ranksAt([], 0, children.length, doc.clientID, randOf(doc));
			if (children.length > 0)
				writes.push({ op: 'insertBlocks', parent: id, index: 0, specs: children, ranks });
		}
		return plan([id], writes);
	};

	return {
		dataSteps,
		replaceData,
		leafSets,
		retypeSteps,
		setBlockType,
		patchData,
		setBlock
	};
};
