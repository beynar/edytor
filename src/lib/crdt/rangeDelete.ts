/**
 * Range deletion between two positions — one prepared document operation
 * (R6) whose merge is the document's `canMerge` (R5). The rules are the
 * `del.range.*` rows of `docs/editor-delete-contract.md`:
 *
 * - the head keeps `[0, start)`, the tail keeps `[end, len)`, and every
 *   block strictly between them in document order dies;
 * - the head dies iff its prefix is empty (never for a replacement,
 *   `del.range.replace`); the tail dies iff it was cut and its suffix is
 *   empty; otherwise, a cut tail's suffix merges into a surviving head when
 *   `canMerge(tail, head)` allows it (`del.range.island-seal`);
 * - an end at a block's start is the end of the block before it when that
 *   block renders content; otherwise the tail is untouched (`yEnd == 0`);
 * - what follows the range end survives: the dying tail's children and the
 *   later siblings inside every container the range dies through take the
 *   topmost such container's slot, unless that would cross an island seal —
 *   then those containers stay (`del.range.outside-survives`);
 * - a container that renders no content and loses every child dies too
 *   (`del.range.empty-container`); a document left with nothing to hold the
 *   caret gets one survivor (`del.range.whole-doc`);
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
	insertBlocks: (dest: Destination, specs: { id: BlockId; type: string }[]) => Prepared;
};

/** `deleteRange` and `replaceRange` (the head kept), prepared. */
export const rangeDeleteOps = (c: RangeDeleteContext) => {
	const prepare =
		(keepHead: boolean) =>
		(from: DocPosition, to: DocPosition, newId: BlockId): Prepared => {
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
			const before = e.offset === 0 && e.block !== s.block ? ids[at.get(e.block)! - 1] : undefined;
			if (before !== undefined && holds(before))
				e = { block: before, offset: c.displayLength(before) };
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
			const tailDies = e.offset > 0 && e.offset === lenE;
			const merges = !headDies && e.offset > 0 && !tailDies && c.canMerge(E, S);
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

			// Rescue what follows the range end into the topmost dying container's slot.
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
				writes.push(...c.move(rescued, dest.parent, dest.index));
				if (tailGone && c.isIsland(E)) {
					const type = c.defaultChild(dest.parent);
					c.childrenIds(E).forEach((kid) => writes.push(...c.retype(kid, type)));
				}
			}
			if (merges) {
				// The whole tail merges, then its cut prefix goes: E's own text is never written.
				writes.push({ op: 'mergeBlocks', from: E, into: S, at: s.offset, length: lenE });
				writes.push({ op: 'deleteText', id: S, offset: s.offset, length: e.offset });
			}
			const kept = [...rescued, ...(merges ? [E] : [])];
			for (const id of doomed) if (!doomed.has(parent(id)!)) writes.push(c.remove(id, kept));

			const caret = ((): DocPosition => {
				if (!doomed.has(S)) return s;
				if (!gone(E)) return { block: E, offset: 0 };
				const survives = (id: BlockId | null): boolean =>
					id === null || rescued.includes(id) || (!gone(id) && survives(parent(id)));
				const shown = (id: BlockId) => survives(id) && holds(id);
				const prev = ids.slice(0, at.get(S)).findLast(shown);
				if (prev !== undefined) return { block: prev, offset: c.displayLength(prev) };
				return { block: ids.slice(at.get(E)! + 1).find(shown) ?? newId, offset: 0 };
			})();
			if (caret.block === newId) {
				// Nothing left can hold the caret: one survivor where the range was (whole-doc).
				const index = Math.max(0, c.childrenIds(null).findIndex(gone));
				const add = c.insertBlocks({ parent: null, index }, [
					{ id: newId, type: c.defaultChild(null) }
				]);
				if (!('writes' in add)) return c.refused;
				writes.push(...add.writes);
			}
			return { ...c.plan([caret.block], writes), at: caret };
		};
	return { deleteRange: prepare(false), replaceRange: prepare(true) };
};
