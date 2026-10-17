/**
 * The step writers every prepared op composes: the plan itself, moves (a
 * move's place and side), type steps and the kind a block shows where it
 * lands (`settle`), the containers and layouts a write leaves empty
 * (`emptying`, `dissolving`), delete and merge steps, and display spans of a
 * block's content.
 */
import { TYPE } from '../schema.js';
import { blockNodeOf, type BlockId, type ContentItem } from '../placement/model.js';
import { REFUSED, effectOf } from './plan.js';
import type { Plan, PlanStep } from './types.js';
import type { DocBase, DocReads } from './reads.js';
import type { DocCapability } from './capability.js';

/** What the step writers read: the reads and the structural capability. */
/**
 * A record's order among the records standing at one block, for the
 * engine's sort of two records at one origin (fork patch YP22): what a split
 * of a list around a block writes there — a new head list holding the items
 * before it (`head`), new blocks placed after the items before it, which
 * stay (`kept`), a head holding those items and the block (`with`), the
 * block itself leaving (`self`), new blocks after it (`after`) — in the
 * order every serial run of the gestures gives (`del.merge.container`).
 */
export const PART = { head: 0, kept: 1, with: 2, self: 3, after: 4 } as const;

export type StepsContext = DocBase & DocReads & DocCapability;

/** The step writers of one facade. */
export const planSteps = (c: StepsContext) => {
	const {
		doc,
		runsView,
		roles,
		rendersContentOf,
		view,
		blockTypeOf,
		childrenIds,
		positionOf,
		ancestorsOf,
		is,
		isIsland,
		itemKindOf,
		isLayout,
		displayLength,
		contentItems,
		live,
		isContainer,
		fitted,
		emptiable,
		defaultChild
	} = c;

	// ── prepared ops ─────────────────────────────────────────────
	// Every op is `prepare` (pure: `refused`, or a plan of named steps plus
	// its effect summary, against the current version) then `apply(plan)`;
	// composites compose their steps into one plan, so a hook sees the
	// whole command before any write and a refusal refuses before one.
	// Each prepare normalizes its inputs once, here at ingress: ids
	// and strings as the wire would deliver them, payloads cloned.

	const plan = (ids: readonly BlockId[], writes: PlanStep[]): Plan => ({
		ids,
		writes,
		effect: effectOf(writes),
		version: runsView.version()
	});

	/**
	 * Move `ids` to display index `index` among `parent`'s children (the
	 * slot hooks see). `side`: the move record's class among the items of
	 * its origin (`placement/slots.ts`) — `0`, the blocks stand after what
	 * precedes them (a move; blocks leaving a block for the gap after it:
	 * its children, a list's last items); `1`, before what follows them
	 * (blocks leaving a block for the gap before it: a list's first item
	 * lifted out). In one gap every serial order of the gestures puts a
	 * split's pieces first, then the after-records, then the before-records
	 * (`del.merge.container`), which the engine's sort gives whatever the
	 * client ids.
	 * Every planned move carries the type steps that keep what the moved
	 * blocks show: one displayed out of an island as another kind than its
	 * stored one (`displayType`) gets that kind written, so leaving the
	 * island's slot never brings the island's child kind back.
	 * `at`, `part`: the block the record stands at and its order among the
	 * records standing there, for the engine's sort of two records at one
	 * origin (`PART`; by default the first moved block, as itself).
	 */
	const moveTo = (
		ids: BlockId[],
		parent: BlockId | null,
		index: number,
		side: 0 | 1 = 0,
		at?: BlockId,
		part?: number
	): PlanStep[] =>
		ids.length === 0
			? []
			: [
					{
						op: 'moveBlocks',
						ids,
						parent,
						index,
						...(side === 1 && { side }),
						...(at !== undefined && { at }),
						...(part !== undefined && { part })
					},
					...ids.flatMap((id) => {
						const shown = runsView.displayType(id);
						return shown === undefined ? [] : attr(id, TYPE, shown);
					})
				];
	/** Move `ids` to `index` among `parent`'s children. */
	const move = (ids: BlockId[], parent: BlockId | null, index: number): PlanStep[] =>
		moveTo(ids, parent, index);
	/** The side of blocks leaving a block for the gap right after it (`after`) or right before it. */
	const leaving = (after: boolean): 0 | 1 => (after ? 0 : 1);
	/**
	 * A type step, planned only when the kind differs (the one same-value
	 * guard). A kind counts as the same only when the block is stored and
	 * shown as it: a move in the same plan pins the kind a block shows
	 * (`moveTo`), so a paragraph shown as its list's item (`itemOf`) that
	 * an outdent settles back to a paragraph is written back.
	 */
	const attr = (id: BlockId, key: typeof TYPE, value: string): PlanStep[] => {
		const same = blockNodeOf(doc, id)!.getAttr(key) === value;
		if (same && (runsView.displayType(id) ?? value) === value) return [];
		return [{ op: 'setBlockType', id, type: value }];
	};

	/**
	 * The kind `kid` shows once it leaves `from` for a slot under `parent`
	 * — the island and container rules, one answer:
	 * - an island's child takes `parent`'s default child (it leaves the
	 *   island's kinds) — unless that renders no content while the child
	 *   does: a line then takes the document's default kind (a code line
	 *   shed into a columns layout is a paragraph), any other child
	 *   keeps its kind, as `typeOf` shows one a peer adds meanwhile;
	 * - a container's item (its default child) takes `parent`'s default
	 *   child — an item never shows outside its list — unless it
	 *   stays inside an outer container of that kind (a nested list),
	 *   or that kind renders no content (a column in a
	 *   columns layout: its text would vanish);
	 * - then a plain block that does not fit `parent` (`fits`: a paragraph
	 *   shed into a list) becomes its item, when that item renders content
	 *   (`fitted`). A block that cannot (a paragraph in a columns
	 *   layout) keeps its kind: its text never vanishes; any other kind (an
	 *   image, a code block, a heading) keeps its kind.
	 */
	/**
	 * The kind a child of `island` (now `kind`) takes where the default
	 * child is `to`: `to` — unless `to` renders no content while the child
	 * does (its text would vanish): a line then takes the document's
	 * default kind, any other child keeps its kind (as `typeOf`).
	 */
	const leavingIsland = (island: BlockId, kind: string | undefined, to: string) => {
		if (rendersContentOf(to) || (kind !== undefined && !rendersContentOf(kind))) return to;
		return is(island, (type) => roles.line(type) !== undefined) ? defaultChild(null) : kind;
	};
	const settledKind = (
		from: BlockId | null,
		kid: BlockId,
		parent: BlockId | null
	): string | undefined => {
		let kind = blockTypeOf(kid);
		if (from !== null && isIsland(from)) kind = leavingIsland(from, kind, defaultChild(parent));
		else if (from !== null && isContainer(from) && kind === defaultChild(from)) {
			const within = parent === null ? [] : [parent, ...ancestorsOf(parent)];
			const to = defaultChild(parent);
			// An outer container of its kind keeps it an item (a nested list); a
			// column's default child is the document's: it holds no items of its own.
			const outer =
				kind !== defaultChild(null) &&
				within.some((a) => isContainer(a) && defaultChild(a) === kind);
			if (!outer && rendersContentOf(to)) kind = to;
		}
		return fitted(parent, kind);
	};
	/** The kind steps for the `kids` of `from` (`null`: the root) landing under `parent` (`settledKind`). */
	const settle = (
		from: BlockId | null,
		kids: readonly BlockId[],
		parent: BlockId | null
	): PlanStep[] =>
		kids.flatMap((kid) => {
			const kind = settledKind(from, kid, parent);
			return kind === undefined || kind === blockTypeOf(kid) ? [] : attr(kid, TYPE, kind);
		});
	/** `parent` and its display ancestors: where blocks landing under `parent` keep alive. */
	const landing = (parent: BlockId | null): Set<BlockId | null> =>
		new Set(parent === null ? [] : [parent, ...ancestorsOf(parent)]);
	/**
	 * `writes`, then every container one of `from` (the blocks' former
	 * parents) is left with no child but `leaving` removed
	 * (`del.range.empty-container`), and so on upward — never one of
	 * `kept`, and only an `emptiable` one (a container holding text of its
	 * own stays). The containers are found together, deepest first: a
	 * list that loses its last item along with a list nested in it goes
	 * too. Then every layout the plan leaves with one
	 * item or none dissolves (`dissolving`); `removed`: blocks the plan
	 * deletes besides (a block delete's members), which only that counts.
	 */
	const emptyingAll = (
		from: readonly (BlockId | null)[],
		leaving: readonly BlockId[],
		writes: readonly PlanStep[],
		kept: ReadonlySet<BlockId | null> = new Set(),
		removed: readonly BlockId[] = []
	): PlanStep[] => {
		const gone = new Set<BlockId>(leaving);
		const tops: BlockId[] = [];
		const deepest = [...new Set(from)]
			.filter((c): c is BlockId => c !== null)
			.sort((a, b) => ancestorsOf(b).length - ancestorsOf(a).length);
		for (const start of deepest) {
			let top: BlockId | null = null;
			for (
				let c: BlockId | null = start;
				c !== null && !gone.has(c) && !kept.has(c) && emptiable(c);
				c = positionOf(c)!.parent
			) {
				if (!childrenIds(c).every((kid) => gone.has(kid))) break;
				gone.add((top = c));
			}
			if (top !== null) tops.push(top);
		}
		const roots = tops.filter((t) => !ancestorsOf(t).some((a) => tops.includes(a)));
		const steps = [...writes, ...roots.map((t) => remove(t, leaving))];
		for (const id of removed) gone.add(id);
		return [...steps, ...dissolving(gone, leaving, steps)];
	};
	/**
	 * `layout.dissolving`: the steps that delete each layout a plan leaves
	 * with one item or none — `gone` (blocks the plan removes) and
	 * `leaving` (blocks it moves) no longer count, an item `writes` move or
	 * insert into it does. With one left, the layout and that item are
	 * deleted and the item's children moved right after the layout, where
	 * `layout.single` shows them, as the kind they show there (`settle`);
	 * with none, the layout is deleted. One plan with the write that caused
	 * it.
	 */
	const dissolving = (
		gone: ReadonlySet<BlockId>,
		leaving: readonly BlockId[],
		writes: readonly PlanStep[]
	): PlanStep[] => {
		const away = new Set([...gone, ...leaving]);
		const layouts = new Set<BlockId>();
		for (const id of away) {
			const parent = positionOf(id)?.parent;
			if (parent != null && isLayout(parent)) layouts.add(parent);
		}
		const { kids } = view();
		const out: PlanStep[] = [];
		for (const layout of layouts) {
			if ([layout, ...ancestorsOf(layout)].some((a) => gone.has(a))) continue;
			const item = itemKindOf(layout)!;
			const arriving = writes.reduce(
				(n, w) =>
					w.op === 'moveBlocks' && w.parent === layout
						? n + w.ids.filter((id) => blockTypeOf(id) === item).length
						: w.op === 'insertBlocks' && w.parent === layout
							? n + w.specs.filter((spec) => spec.type === item).length
							: n,
				0
			);
			const slots = kids.get(layout) ?? [];
			const items = slots.filter((k) => !away.has(k.id) && blockTypeOf(k.id) === item);
			if (items.length + arriving > 1) continue;
			const { parent } = positionOf(layout)!;
			const last = items[0];
			if (last === undefined) {
				out.push(deleting(layout, [layout]));
				continue;
			}
			// Its blocks keep their home slots: the read shows them in the layout's
			// slot (`layout.single`), settled for its parent.
			const moved = (kids.get(last.id) ?? []).filter((k) => !away.has(k.id));
			const ids = moved.map((k) => k.id);
			out.push(...settle(last.id, ids, parent), deleting(layout, [layout, last.id]));
		}
		return out;
	};
	/** `writes`, then `container` removed when they leave it no child but `leaving` (`emptyingAll`). */
	const emptying = (
		container: BlockId,
		leaving: readonly BlockId[],
		writes: readonly PlanStep[],
		kept?: ReadonlySet<BlockId | null>
	): PlanStep[] => emptyingAll([container], leaving, writes, kept);
	/**
	 * Delete: `removes` leave. Every one is marked with what it
	 * displays — an unmarked one would be promoted into the deleted slot
	 * (`displaySlotOf`).
	 */
	const deleting = (id: BlockId, removes: BlockId[]): PlanStep => {
		const marks = [...new Set(removes.flatMap((b) => view().displays(b)))];
		return { op: 'deleteBlock', id, marks, removes };
	};
	/** Delete `id` and its subtree, `kept` children aside. */
	const remove = (id: BlockId, kept: readonly BlockId[] = []): PlanStep => {
		const removes: BlockId[] = [];
		const skip = new Set(kept);
		const walk = (b: BlockId): void => {
			removes.push(b);
			for (const kid of childrenIds(b)) if (!skip.has(kid)) walk(kid);
		};
		walk(id);
		return deleting(id, removes);
	};
	const merge = (from: BlockId, into: BlockId): PlanStep => ({
		op: 'mergeBlocks',
		from,
		into,
		at: displayLength(into),
		length: displayLength(from)
	});
	/** `[at, end)` — `[offset, offset + length)` clamped to `id`'s display. */
	const clamp = (id: BlockId, offset: number, length: number): [number, number] => {
		const total = displayLength(id);
		const at = Math.max(0, Math.min(offset, total));
		return [at, Math.min(total, at + Math.max(0, length))];
	};
	/** `id`'s display items, each with its `[at, end)` display offsets. */
	const spans = (id: BlockId) => {
		let end = 0;
		return contentItems(id).map((item) => {
			const at = end;
			end += item.kind === 'text' ? item.text.length : 1;
			return { item, at, end };
		});
	};
	/** The live inline atom `atom` in `id`'s display, or undefined. */
	const atomOf = (id: BlockId, atom: string) =>
		live(id) ? spans(id).find(({ item }) => item.kind === 'inline' && item.id === atom) : undefined;
	/** Text items overlapping `[at, end)` of `id` (inline atoms carry no marks). */
	const textIn = (id: BlockId, at: number, end: number) =>
		spans(id).flatMap((s) => (s.item.kind === 'text' && s.at < end && s.end > at ? [s.item] : []));
	/** Push the steps writing `items` into `id` from `at` (text runs and atoms in order); the end offset. */
	const writeContent = (
		writes: PlanStep[],
		id: BlockId,
		at: number,
		items: readonly ContentItem[] = []
	): number => {
		for (const item of items) {
			if (item.kind === 'inline') writes.push({ op: 'insertInline', id, offset: at++, atom: item });
			else if (item.text !== '') {
				writes.push({ op: 'insertText', id, offset: at, text: item.text, marks: item.marks });
				at += item.text.length;
			}
		}
		return at;
	};

	/** `writes`, then every container the `leaving` blocks leave with no child removed. */
	const emptied = (
		leaving: readonly BlockId[],
		writes: PlanStep[],
		kept?: ReadonlySet<BlockId | null>
	): PlanStep[] =>
		emptyingAll(
			leaving.map((id) => positionOf(id)!.parent),
			leaving,
			writes,
			kept
		);

	return {
		REFUSED,
		plan,
		moveTo,
		move,
		leaving,
		attr,
		leavingIsland,
		settledKind,
		settle,
		landing,
		emptyingAll,
		dissolving,
		emptying,
		emptied,
		deleting,
		remove,
		merge,
		clamp,
		atomOf,
		textIn,
		writeContent
	};
};

export type PlanSteps = ReturnType<typeof planSteps>;

/** What every op family is prepared over: the reads, the capability and the step writers. */
export type OpsContext = StepsContext & PlanSteps;
