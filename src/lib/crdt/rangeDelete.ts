/**
 * Range deletion between two positions — one prepared document operation
 * (R6) whose merge is the document's `canMerge` (R5). The rules are the
 * `del.range.*` rows of `docs/editor-delete-contract.md`:
 *
 * - the head keeps `[0, start)`, the tail keeps `[end, len)`, and every
 *   block strictly between them in document order dies;
 * - the head dies iff its prefix is empty (never for a replacement,
 *   `del.range.replace`, nor when nothing else would be left to hold the
 *   caret, `del.range.whole-doc`: the head is kept, emptied, with its id,
 *   type and data, so peers deleting the same range keep the same block)
 *   and the tail then keeps its id; the tail dies iff
 *   its suffix is empty; otherwise the tail's suffix merges into the head
 *   when `canMerge(tail, head)` allows it (`del.range.island-seal`) — an end
 *   at the tail's start included: the seam between them is deleted;
 * - what follows the range end survives: the dying tail's children and the
 *   later siblings inside every container the range dies through take the
 *   topmost such container's slot, unless that would cross an island seal —
 *   then those containers stay (`del.range.outside-survives`);
 * - a container (a list: the document's `isContainer`) never dies because
 *   the range starts before it: it keeps what follows the range end, like
 *   the keys (`del.merge.container`); it dies only when it loses every
 *   child and holds no text of its own — the document's `emptiable`, the
 *   keys' rule (`del.range.empty-container`, ZW-05). An island that renders
 *   no content dies when it loses every child too, except a `lines` island
 *   (a code block) the range lies in: its head is then kept, emptied
 *   (`del.range.island-kept`);
 * - what a range rescues takes the kind it shows in its new slot (the
 *   document's `settle`: a paragraph rescued into a list is its item);
 * - blocks the view hides (a closed toggle's body) are not in the range:
 *   they go only with a block that goes, so a surviving head keeps its
 *   hidden children, unless it is kept only to hold the caret; a dying
 *   closed tail's body takes its place, shown (`del.range.hidden-body`);
 * - a layout the range leaves with one column dissolves, in the same plan
 *   (`layout.dissolving`);
 * - the plan's `at` is where the caret lands (`del.range.caret`).
 */
import type { BlockId, Destination } from './placement/model.js';
import type { Plan, PlanStep, Prepared } from './edytor-doc.js';

/** A position in one document version: a block and a display offset (R4). */
export type DocPosition = { block: BlockId; offset: number };

/** What range deletion reads from the document and the step writers it composes. */
export type RangeDeleteContext = {
	ref: (id: BlockId) => BlockId;
	refused: Prepared;
	plan: (ids: readonly BlockId[], writes: PlanStep[]) => Plan;
	order: () => { ids: readonly BlockId[]; at: ReadonlyMap<BlockId, number> };
	positionOf: (id: BlockId) => Destination | null;
	/** Display ancestors, nearest first (the root excluded). */
	ancestorsOf: (id: BlockId) => BlockId[];
	childrenIds: (parent: BlockId | null) => BlockId[];
	displayLength: (id: BlockId) => number;
	/** Live, with its own content node. */
	contentTarget: (id: BlockId) => boolean;
	rendersContent: (id: BlockId) => boolean;
	canMerge: (from: BlockId, into: BlockId) => boolean;
	isIsland: (id: BlockId) => boolean;
	/** An island declared `lines` (a code block): it holds only lines. */
	isLines: (id: BlockId) => boolean;
	move: (ids: BlockId[], parent: BlockId | null, index: number) => PlanStep[];
	/** A block that shows only its children: a list, a table row, a column. */
	isContainer: (id: BlockId) => boolean;
	/** A container that goes once it loses every child (it holds no text of its own). */
	emptiable: (id: BlockId) => boolean;
	/** The kind steps for `from`'s children `kids` landing under `parent` (island and container rules). */
	settle: (from: BlockId | null, kids: readonly BlockId[], parent: BlockId | null) => PlanStep[];
	remove: (id: BlockId, kept: readonly BlockId[]) => PlanStep;
	/**
	 * The steps that dissolve each layout the plan leaves with one item or
	 * none (`layout.dissolving`): `gone` it removes, `leaving` it moves.
	 */
	dissolving: (
		gone: readonly BlockId[],
		leaving: readonly BlockId[],
		writes: readonly PlanStep[]
	) => PlanStep[];
};

/**
 * What the view knows of a range (view state the document does not hold):
 * whether it hides a block, and, given `removed`, whether the block stays
 * hidden once those go (a removed closed toggle's children take its place, shown).
 */
export type RangeView = { hidden?: (id: BlockId, removed?: ReadonlySet<BlockId>) => boolean };

/** `deleteRange` and `replaceRange` (the head kept), prepared. */
export const rangeDeleteOps = (c: RangeDeleteContext) => {
	// `headSpent`: a whole-doc retry keeps the head, but what it hid goes as if it went.
	const prepare =
		(keepHead: boolean, headSpent = false) =>
		(from: DocPosition, to: DocPosition, view: RangeView = {}): Prepared => {
			// A position names shown text: a live block that renders its own content.
			const holds = (id: BlockId) => c.contentTarget(id) && c.rendersContent(id);
			const pos = (p: DocPosition): DocPosition => {
				const block = c.ref(p.block);
				const len = holds(block) ? c.displayLength(block) : -1;
				return { block, offset: Math.max(0, Math.min(p.offset, len)) };
			};
			let [s, e] = [pos(from), pos(to)];
			if (!holds(s.block) || !holds(e.block)) return c.refused;
			const { ids, at } = c.order();
			if (at.get(s.block)! > at.get(e.block)! || (s.block === e.block && s.offset > e.offset))
				[s, e] = [e, s];
			const S = s.block;
			const E = e.block;
			if (S === E) {
				const length = e.offset - s.offset;
				const writes: PlanStep[] =
					length > 0 ? [{ op: 'deleteText', id: S, offset: s.offset, length }] : [];
				return { ...c.plan([S], writes), at: s };
			}

			const parent = (id: BlockId) => c.ancestorsOf(id)[0] ?? null;
			const chain = c.ancestorsOf(E);
			// What the view hides once `removed` go (nothing: as it is now).
			const hiddenOnce = (removed: readonly BlockId[]) => {
				const set = new Set(removed);
				return (id: BlockId) => !!view.hidden?.(id, set);
			};
			const headDies = !keepHead && s.offset === 0;
			// What the view hides is not in the range: it goes only with a block that goes,
			// a dying head's body included.
			const hidden = hiddenOnce(headDies || headSpent ? [S] : []);
			const between = ids.slice(at.get(S)! + 1, at.get(E)!).filter((id) => !hidden(id));
			const lenE = c.displayLength(E);
			const tailDies = e.offset === lenE;
			const merges = !headDies && !tailDies && c.canMerge(E, S);
			const tailGone = tailDies || merges;

			// E's ancestors the range starts before die unless the rescue would cross an island.
			// A container (a list) is not one: it dies only when the range empties it, and
			// keeps its later items like the keys do (`del.merge.container`, DR-crdt-4).
			const partial = chain.filter(
				(a) => (a === (headDies ? S : null) || between.includes(a)) && !c.isContainer(a)
			);
			const top = partial.at(-1);
			const sealed = top !== undefined && chain.slice(0, chain.indexOf(top) + 1).some(c.isIsland);
			const spared = new Set(sealed ? chain : []);
			const doomed = new Set(between.filter((id) => !spared.has(id) && !chain.includes(id)));
			if (!sealed) partial.forEach((a) => doomed.add(a));
			if (headDies && !spared.has(S)) doomed.add(S);
			if (tailDies) doomed.add(E);

			// Rescue what follows the range end right after the topmost dying container's slot
			// (after, not at it: a concurrent delete of S revives a merged E above them, UW-20).
			const home = sealed || top === undefined ? (tailGone ? E : undefined) : top;
			const rescued = home === undefined ? [] : tailGone ? c.childrenIds(E) : [E];
			for (let cur = E; home !== undefined && cur !== home; cur = parent(cur)!) {
				const sibs = c.childrenIds(parent(cur));
				rescued.push(...sibs.slice(sibs.indexOf(cur) + 1));
			}
			const dest = home === undefined || rescued.length === 0 ? null : c.positionOf(home)!;

			// A container (or an island that renders nothing) losing every child dies too.
			const gone = (id: BlockId) => doomed.has(id) || (merges && id === E);
			const dies = (id: BlockId) => c.emptiable(id) || (c.isIsland(id) && !c.rendersContent(id));
			const emptied = (id: BlockId | null): void => {
				if (id === null || gone(id) || !dies(id) || id === dest?.parent) return;
				if (!c.childrenIds(id).every(gone)) return;
				doomed.add(id);
				emptied(parent(id));
			};
			[...doomed, ...(merges ? [E] : [])].forEach((id) => emptied(parent(id)));
			// A range inside one `lines` island never removes it: the head stays, emptied
			// (a code block's Mod+A, `del.range.island-kept`).
			const island = c.ancestorsOf(S).find(c.isIsland);
			const linesIsland = island !== undefined && c.isLines(island);
			if (!keepHead && linesIsland && doomed.has(island) && chain.includes(island))
				return prepare(true, headDies)(from, to, view);

			const lenS = c.displayLength(S);
			const writes: PlanStep[] = [];
			if (!doomed.has(S) && lenS > s.offset)
				writes.push({ op: 'deleteText', id: S, offset: s.offset, length: lenS - s.offset });
			if (!gone(E) && e.offset > 0)
				writes.push({ op: 'deleteText', id: E, offset: 0, length: e.offset });
			if (dest !== null) {
				writes.push(...c.move(rescued, dest.parent, dest.index + 1));
				// Each shows the kind of its new slot (an island's line, a list's item leave theirs).
				for (const id of rescued) writes.push(...c.settle(parent(id), [id], dest.parent));
			}
			if (merges) {
				// The whole tail merges, then its cut prefix goes: E's own text is never written.
				writes.push({ op: 'mergeBlocks', from: E, into: S, at: s.offset, length: lenE });
				if (e.offset > 0)
					writes.push({ op: 'deleteText', id: S, offset: s.offset, length: e.offset });
			}
			const kept = [...rescued, ...(merges ? [E] : [])];
			for (const id of doomed) if (!doomed.has(parent(id)!)) writes.push(c.remove(id, kept));
			// A layout the range leaves with one column dissolves (`layout.dissolving`).
			writes.push(...c.dissolving([...doomed, ...(merges ? [E] : [])], rescued, writes));

			const caret = ((): DocPosition | null => {
				if (!doomed.has(S)) return s;
				if (!gone(E)) return { block: E, offset: 0 };
				const survives = (id: BlockId | null): boolean =>
					id === null || rescued.includes(id) || (!gone(id) && survives(parent(id)));
				// Shown once the plan runs: a dying closed tail's rescued body is.
				const hiddenAfter = hiddenOnce([...doomed, ...(merges ? [E] : [])]);
				const shown = (id: BlockId) => survives(id) && holds(id) && !hiddenAfter(id);
				// Before the tail: blocks a sealed rescue spared between S and E count too.
				const prev = ids.slice(0, at.get(E)).findLast(shown);
				if (prev !== undefined) return { block: prev, offset: c.displayLength(prev) };
				const next = ids.slice(at.get(E)! + 1).find(shown);
				return next === undefined ? null : { block: next, offset: 0 };
			})();
			// Nothing else left to hold the caret: the head stays, emptied (whole-doc).
			if (caret === null) return prepare(true, headDies)(from, to, view);
			return { ...c.plan([caret.block], writes), at: caret };
		};
	return { deleteRange: prepare(false), replaceRange: prepare(true) };
};
