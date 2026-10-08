/**
 * The step writers every prepared op composes: the plan itself, ranks (a
 * move's, a source rank by where blocks come from, a split's pieces), type
 * steps and the kind a block shows where it lands (`settle`), the
 * containers and layouts a write leaves empty (`emptying`, `dissolving`),
 * delete and merge steps, and display spans of a block's content.
 */
import { randOf } from '../rand.js';
import { TYPE } from '../schema.js';
import { promotedRank, sourceRank, SOURCE_SIDE, type BlockId } from '../placement/model.js';
import { refused, effectOf } from './plan.js';
import type { Plan, PlanStep } from './types.js';
import type { DocBase, DocReads } from './reads.js';
import type { DocCapability } from './capability.js';

/** What the step writers read: the reads and the structural capability. */
export type StepsContext = DocBase & DocReads & DocCapability;

/** The step writers of one facade. */
export const planSteps = (c: StepsContext) => {
	const {
		doc,
		M,
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
		order,
		next,
		displayLength,
		contentItems,
		live,
		isContainer,
		fits,
		fitted,
		emptiable,
		rendersContent,
		defaultChild
	} = c;

	// ── prepared ops (R6) ─────────────────────────────────────────────
	// Every op is `prepare` (pure: `refused`, or a plan of named steps plus
	// its effect summary, against the current version) then `apply(plan)`;
	// composites compose their steps into one plan, so a hook sees the
	// whole command before any write and a refusal refuses before one.
	// Each prepare normalizes its inputs once, here at ingress (O1): ids
	// and strings as the wire would deliver them, payloads cloned.

	const REFUSED = refused(null);
	/** `exitRanks` parts, in their order at one block. */
	const [HEAD, KEPT, WITH, SELF, AFTER] = [0, 1, 2, 3, 5];
	const plan = (ids: readonly BlockId[], writes: PlanStep[]): Plan => ({
		ids,
		writes,
		effect: effectOf(writes),
		version: runsView.version()
	});

	/** This client's next clock: what its source ranks are tied by (`sourceRank`, DW-05). */
	const clock = () => doc.store?.getClock(doc.clientID) ?? 0;
	/**
	 * `count` ranks at `index` among `parent`'s children, the moving
	 * `exclude` left out. `run`: new blocks, which extend this client's run
	 * after a block it ranked (H1, `order.insert.run`); a move never does
	 * (the rank-growth guard).
	 */
	const ranksFor = (
		parent: BlockId | null,
		index: number,
		count: number,
		exclude: readonly BlockId[] = [],
		run = false
	): string[] => {
		const v = view();
		const all = v.kids.get(parent) ?? [];
		// The moving blocks' own slots left out: index → the list's index past them.
		const gone = exclude
			.map((id) => M.positionInView(v, id))
			.filter((p) => p !== null && p.parent === parent)
			.map((p) => p!.index)
			.sort((a, b) => a - b);
		const raw = (i: number) => {
			for (const g of gone) if (g <= i) i++;
			return i;
		};
		const at = Math.max(0, Math.min(index, all.length - gone.length));
		const pair = [at > 0 ? all[raw(at - 1)] : undefined, all[raw(at)]];
		return M.ranksAt(pair as readonly { rank: string }[], 1, count, doc.clientID, randOf(doc), run);
	};
	/**
	 * Move `ids` to `ranks` under `parent` (`index`: the slot hooks see).
	 * Every planned move carries the type steps that keep what the moved
	 * blocks show: one displayed out of an island as another kind than its
	 * stored one (`displayType`) gets that kind written, so leaving the
	 * island's slot never brings the island's child kind back (RW-01).
	 */
	const moveTo = (
		ids: BlockId[],
		parent: BlockId | null,
		index: number,
		ranks: string[]
	): PlanStep[] =>
		ids.length === 0
			? []
			: [
					{ op: 'moveBlocks', ids, parent, index, ranks },
					...ids.flatMap((id) => {
						const shown = runsView.displayType(id);
						return shown === undefined ? [] : attr(id, TYPE, shown);
					})
				];
	/** Move `ids` to `index` among `parent`'s children. */
	const move = (ids: BlockId[], parent: BlockId | null, index: number): PlanStep[] =>
		moveTo(ids, parent, index, ranksFor(parent, index, ids.length, ids));
	/**
	 * Ranks for blocks leaving `outer` for the gap right before it (`after`:
	 * right after it), in the order they come from (`sourceRank`, CW-01):
	 * two peers that split or lift out of the same list at once keep the
	 * text in its order, whatever their client ids. Each part names the
	 * block in `outer` it stands at (`at`; one that shows no text of its
	 * own, a list, stands at its first item) and its `part` there:
	 * - `HEAD`: a new list holding the items before `at`;
	 * - `KEPT`, index: a block placed after the items before `at`, which
	 *   stay (a divider inserted after an item: a peer's head that takes
	 *   them sorts before it);
	 * - `WITH`: a new list holding the items before `at` and `at` (`keep`);
	 * - `SELF`: `at` itself leaving (`SELF + 1` when it stands at its first item);
	 * - `AFTER`, index: a block placed after it.
	 * A degenerate gap ranks them as any insert.
	 */
	const exitRanks = (
		outer: BlockId,
		after: boolean,
		parts: readonly { at: BlockId; part: readonly number[] }[]
	): string[] => {
		const { kids } = view();
		const { parent, index } = positionOf(outer)!;
		const sibs = kids.get(parent) ?? [];
		const gap = after ? index + 1 : index;
		const ranks: string[] = [];
		for (let { at, part } of parts) {
			const own = at;
			while (!rendersContent(at) && childrenIds(at).length > 0) at = childrenIds(at)[0]!;
			if (part[0] === SELF && at !== own) part = [SELF + 1];
			const path: string[] = [];
			for (let c = at; c !== outer; c = positionOf(c)!.parent!) {
				const pos = positionOf(c)!;
				path.unshift(kids.get(pos.parent)![pos.index]!.rank);
			}
			const side = after ? SOURCE_SIDE.after : SOURCE_SIDE.before;
			const rank = sourceRank(
				sibs[gap - 1]?.rank,
				sibs[gap]?.rank,
				side,
				path,
				part,
				doc.clientID,
				clock()
			);
			if (rank === null) return ranksFor(parent, gap, parts.length);
			ranks.push(rank);
		}
		return ranks;
	};
	/**
	 * Ranks for the `count` blocks a split of `id` at `at` puts right after
	 * it (Enter, a paste of several lines), by where it splits
	 * (SW12-crdt-1, SW12-crdt-4): two peers splitting one block at once
	 * keep its pieces in text order, whatever their client ids. Counted
	 * from the end — the text after the split point, most first — so a
	 * peer's own edit before its split point (typing, then Enter; a paste
	 * over a selection) does not move it (DR-crdt-7); an unseen edit after
	 * it does (the residual, in the delete contract).
	 */
	const pieceRanks = (id: BlockId, at: number, count: number): string[] => {
		const { parent, index } = positionOf(id)!;
		const sibs = view().kids.get(parent) ?? [];
		const ranks: string[] = [];
		for (let i = 0; i < count; i++) {
			const rank = sourceRank(
				sibs[index]?.rank,
				sibs[index + 1]?.rank,
				SOURCE_SIDE.pieces,
				[],
				[at - displayLength(id), i],
				doc.clientID,
				clock()
			);
			if (rank === null) return ranksFor(parent, index + 1, count);
			ranks.push(rank);
		}
		return ranks;
	};
	/** `exitRanks` for `ids` themselves leaving `outer`. */
	const leaving = (outer: BlockId, after: boolean, ids: readonly BlockId[]) =>
		exitRanks(
			outer,
			after,
			ids.map((at) => ({ at, part: [SELF] }))
		);
	/**
	 * A type step, planned only when the kind differs (the one same-value
	 * guard). A kind counts as the same only when the block is stored and
	 * shown as it: a move in the same plan pins the kind a block shows
	 * (`moveTo`), so a paragraph shown as its list's item (`itemOf`) that
	 * an outdent settles back to a paragraph is written back (DR-crdt-3).
	 */
	const attr = (id: BlockId, key: typeof TYPE, value: string): PlanStep[] => {
		const same = M.blockNodeOf(doc, id)!.getAttr(key) === value;
		if (same && (runsView.displayType(id) ?? value) === value) return [];
		return [{ op: 'setBlockType', id, type: value }];
	};

	/**
	 * The kind `kid` shows once it leaves `from` for a slot under `parent`
	 * — the island and container rules, one answer:
	 * - an island's child takes `parent`'s default child (it leaves the
	 *   island's kinds) — unless that renders no content while the child
	 *   does: a line then takes the document's default kind (a code line
	 *   shed into a columns layout is a paragraph, AW-05), any other child
	 *   keeps its kind, as `typeOf` shows one a peer adds meanwhile;
	 * - a container's item (its default child) takes `parent`'s default
	 *   child — an item never shows outside its list (YW-02) — unless it
	 *   stays inside an outer container of that kind (a nested list,
	 *   SW8-roles-4), or that kind renders no content (a column in a
	 *   columns layout: its text would vanish, DR-crdt-1);
	 * - then a plain block that does not fit `parent` (`fits`: a paragraph
	 *   shed into a list) becomes its item, when that item renders content
	 *   (ZW-01, `fitted`). A block that cannot (a paragraph in a columns
	 *   layout) keeps its kind: its text never vanishes; any other kind (an
	 *   image, a code block, a heading) keeps its kind (DR-crdt-1).
	 */
	/**
	 * The kind a child of `island` (now `kind`) takes where the default
	 * child is `to`: `to` — unless `to` renders no content while the child
	 * does (its text would vanish): a line then takes the document's
	 * default kind, any other child keeps its kind (AW-05, as `typeOf`).
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
	 * too (SW9-containers-2). Then every layout the plan leaves with one
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
	 * deleted and the item's children moved to the layout's slot at the
	 * rank `layout.single` reads (`promotedRank` of the layout's, then the
	 * item's), as the kind they show there (`settle`); with none, the
	 * layout is deleted. One plan with the write that caused it.
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
			const { parent, index } = positionOf(layout)!;
			const rank = kids.get(parent)![index]!.rank;
			const last = items[0];
			if (last === undefined) {
				out.push(deleting(layout, [layout]));
				continue;
			}
			const moved = (kids.get(last.id) ?? []).filter((k) => !away.has(k.id));
			const ids = moved.map((k) => k.id);
			const ranks = moved.map((k) => promotedRank(rank, promotedRank(last.rank, k.rank)));
			out.push(
				...moveTo(ids, parent, index + 1, ranks),
				...settle(last.id, ids, parent),
				deleting(layout, [layout, last.id])
			);
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
	 * Delete (R3): `removes` leave. Every one is marked with what it
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
		HEAD,
		KEPT,
		WITH,
		SELF,
		AFTER,
		plan,
		ranksFor,
		moveTo,
		move,
		exitRanks,
		pieceRanks,
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
		spans,
		atomOf,
		textIn
	};
};

export type PlanSteps = ReturnType<typeof planSteps>;

/** What every op family is prepared over: the reads, the capability and the step writers. */
export type OpsContext = StepsContext & PlanSteps;
