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
 * - a container that renders no content and loses every child dies too
 *   (`del.range.empty-container`);
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
	defaultChild: (parent: BlockId | null) => string;
	move: (ids: BlockId[], parent: BlockId | null, index: number) => PlanStep[];
	retype: (id: BlockId, type: string) => PlanStep[];
	remove: (id: BlockId, kept: readonly BlockId[]) => PlanStep;
};

/** `deleteRange` and `replaceRange` (the head kept), prepared. */
export const rangeDeleteOps = (c: RangeDeleteContext) => {
	const prepare =
		(keepHead: boolean) =>
		(from: DocPosition, to: DocPosition): Prepared => {
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
			const between = ids.slice(at.get(S)! + 1, at.get(E)!);
			const headDies = !keepHead && s.offset === 0;
			const lenE = c.displayLength(E);
			const tailDies = e.offset === lenE;
			const merges = !headDies && !tailDies && c.canMerge(E, S);
			const tailGone = tailDies || merges;

			// E's ancestors the range starts before die unless the rescue would cross an island.
			const partial = chain.filter((a) => a === (headDies ? S : null) || between.includes(a));
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

			// A container that renders nothing and loses every child dies too.
			const gone = (id: BlockId) => doomed.has(id) || (merges && id === E);
			const emptied = (id: BlockId | null): void => {
				if (id === null || gone(id) || c.rendersContent(id) || id === dest?.parent) return;
				if (!c.childrenIds(id).every(gone)) return;
				doomed.add(id);
				emptied(parent(id));
			};
			[...doomed, ...(merges ? [E] : [])].forEach((id) => emptied(parent(id)));

			const lenS = c.displayLength(S);
			const writes: PlanStep[] = [];
			if (!doomed.has(S) && lenS > s.offset)
				writes.push({ op: 'deleteText', id: S, offset: s.offset, length: lenS - s.offset });
			if (!gone(E) && e.offset > 0)
				writes.push({ op: 'deleteText', id: E, offset: 0, length: e.offset });
			if (dest !== null) {
				writes.push(...c.move(rescued, dest.parent, dest.index + 1));
				if (tailGone && c.isIsland(E)) {
					const type = c.defaultChild(dest.parent);
					c.childrenIds(E).forEach((kid) => writes.push(...c.retype(kid, type)));
				}
			}
			if (merges) {
				// The whole tail merges, then its cut prefix goes: E's own text is never written.
				writes.push({ op: 'mergeBlocks', from: E, into: S, at: s.offset, length: lenE });
				if (e.offset > 0)
					writes.push({ op: 'deleteText', id: S, offset: s.offset, length: e.offset });
			}
			const kept = [...rescued, ...(merges ? [E] : [])];
			for (const id of doomed) if (!doomed.has(parent(id)!)) writes.push(c.remove(id, kept));

			const caret = ((): DocPosition | null => {
				if (!doomed.has(S)) return s;
				if (!gone(E)) return { block: E, offset: 0 };
				const survives = (id: BlockId | null): boolean =>
					id === null || rescued.includes(id) || (!gone(id) && survives(parent(id)));
				const shown = (id: BlockId) => survives(id) && holds(id);
				// Before the tail: blocks a sealed rescue spared between S and E count too.
				const prev = ids.slice(0, at.get(E)).findLast(shown);
				if (prev !== undefined) return { block: prev, offset: c.displayLength(prev) };
				const next = ids.slice(at.get(E)! + 1).find(shown);
				return next === undefined ? null : { block: next, offset: 0 };
			})();
			// Nothing else left to hold the caret: the head stays, emptied (whole-doc).
			if (caret === null) return prepare(true)(from, to);
			return { ...c.plan([caret.block], writes), at: caret };
		};
	return { deleteRange: prepare(false), replaceRange: prepare(true) };
};
