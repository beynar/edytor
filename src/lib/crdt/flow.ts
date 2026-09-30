/**
 * Placement of an admitted flow — one prepared document operation (R6) for
 * paste, drop and fragment insertion. The rules are the `flow.*` rows of
 * `docs/editor-delete-contract.md`:
 *
 * - a flow is lines with fresh ids: a kinded block, or an inline run (no
 *   `type`); an empty flow changes nothing (`flow.shape`);
 * - one line joins the text at the position; an empty block takes a kinded
 *   line's kind (`flow.inline`);
 * - several lines split the block: the first joins the head, the last is the
 *   tail's block and takes the text after the position and the block's
 *   children, the rest go between (`flow.split`, D-4) — children the view
 *   hides (a closed toggle's body) stay with the head, as Enter keeps them;
 * - a `whole` flow (a block-selection copy) goes after the block, replacing
 *   it when empty (`flow.whole`); over selected blocks the lines take their
 *   slot (`flow.slot`), both at plain ranks (`insertBlocks`: their order
 *   against a peer's split beside them is not claimed, DR-crdt-1); a void
 *   takes one run (`flow.void`);
 * - a plain line that lands directly in a container takes its item kind
 *   (the document's `fitted`: a pasted paragraph in a list is its item,
 *   ZW-01), and so does a line of the list's flat item kind (the view's
 *   `itemKind`: a pasted numbered item in an `ordered-list`, AW-08); any
 *   other kind keeps its kind and data (a pasted image stays an image, a
 *   bulleted item in an `ordered-list` a bulleted item, DR-crdt-1).
 */
import type { BlockId, BlockSpec, Destination, SplitTail } from './placement/model.js';
import type { PlanStep, Prepared } from './edytor-doc.js';
import type { DocPosition, RangeDeleteContext, RangeView } from './rangeDelete.js';

/** One line of a flow: a kinded block, or an inline run when it has no `type`. */
export type FlowLine = Omit<BlockSpec, 'type'> & { type?: string };
/** An admitted flow (§2.4): lines in order, ids fresh; `whole`: a block-selection copy. */
export type Flow = { lines: FlowLine[]; whole?: boolean };
/**
 * What the view tells flow placement beyond range deletion's view: a
 * container's flat item kind (`numbered-list-item` for an `ordered-list`).
 */
export type FlowView = RangeView & { itemKind?: (parent: BlockId) => string | undefined };
/** A position, or the blocks the flow replaces (`flow.slot`). */
export type FlowTarget = DocPosition | { replace: readonly BlockId[] };

/** What flow placement reads beyond range deletion's context. */
export type FlowContext = RangeDeleteContext & {
	defaultChild: (parent: BlockId | null) => string;
	/** `kind`, or `parent`'s item where it does not fit there (the container rule). */
	fitted: (parent: BlockId | null, kind: string | undefined) => string | undefined;
	retype: (id: BlockId, type: string) => PlanStep[];
	sanitize: (spec: BlockSpec) => BlockSpec;
	collides: (specs: readonly BlockSpec[]) => boolean;
	isVoid: (id: BlockId) => boolean;
	tailOf: (id: BlockId) => SplitTail;
	ranksFor: (parent: BlockId | null, index: number, count: number) => string[];
	/** Ranks for the `count` blocks a split of `id` at `at` puts after it, by that offset. */
	pieceRanks: (id: BlockId, at: number, count: number) => string[];
	redata: (id: BlockId, data: Record<string, unknown>) => PlanStep[];
	deleteBlocks: (ids: readonly BlockId[]) => Prepared;
	insertBlocks: (dest: Destination, specs: readonly BlockSpec[]) => Prepared;
};

const lengthOf = (l: FlowLine) =>
	(l.content ?? []).reduce((n, i) => n + (i.kind === 'text' ? i.text.length : 1), 0);

/** `insertFlow`, prepared. */
export const flowOps = (c: FlowContext) => ({
	insertFlow: (target: FlowTarget, flow: Flow, view: FlowView = {}): Prepared => {
		// Ingress (O1): a run carries a placeholder kind through the spec sanitizer.
		let lines: FlowLine[] = flow.lines
			.map((l) => c.sanitize({ ...l, type: l.type ?? '' }))
			.map((s) => ({ ...s, type: s.type || undefined }));
		if (lines.length === 0) return c.plan([], []);
		/** A line's kind under `parent`: the list's item for its flat item kind, then `fitted`. */
		const fit = (parent: BlockId | null, kind: string | undefined) =>
			c.fitted(
				parent,
				parent !== null && kind !== undefined && kind === view.itemKind?.(parent)
					? c.defaultChild(parent)
					: kind
			);
		const specs = (parent: BlockId | null): BlockSpec[] =>
			lines.map((l) => ({ ...l, type: fit(parent, l.type) ?? c.defaultChild(parent) }));
		const last = () => lines.at(-1)!;
		/** Whole blocks at a slot, after `pre`; the caret ends the last one's content. */
		const atSlot = (dest: Destination, pre: PlanStep[]): Prepared => {
			const p = c.insertBlocks(dest, specs(dest.parent));
			const at = { block: last().id, offset: lengthOf(last()) };
			return 'writes' in p ? { ...c.plan(p.ids, [...pre, ...p.writes]), at } : p;
		};
		if ('replace' in target) {
			const del = c.deleteBlocks(target.replace);
			if (!('writes' in del)) return del;
			const first = [...del.ids].sort((a, b) => c.order().at.get(a)! - c.order().at.get(b)!)[0];
			return first === undefined ? c.refused : atSlot(c.positionOf(first)!, [...del.writes]);
		}
		const B = c.ref(target.block);
		if (!c.contentTarget(B) || !c.rendersContent(B)) return c.refused;
		const len = c.displayLength(B);
		const o = Math.max(0, Math.min(target.offset, len));
		const { parent, index } = c.positionOf(B)!;
		const empty = len === 0 && c.childrenIds(B).length === 0;
		if (flow.whole) return atSlot({ parent, index: index + 1 }, empty ? [c.remove(B, [])] : []);
		// A void is never split: its caption takes the lines as one run.
		const br = { kind: 'text' as const, text: '\n' };
		if (c.isVoid(B)) {
			const content = lines.flatMap((l, i) => [...(i ? [br] : []), ...(l.content ?? [])]);
			lines = [{ id: lines[0]!.id, content }];
		}
		const [first, T] = [lines[0]!, last().id];
		if (c.collides([...(first.children ?? []), ...specs(parent).slice(1)])) return c.refused;
		const writes: PlanStep[] = [];
		const text = (id: BlockId, at: number, l: FlowLine): number => {
			for (const item of l.content ?? []) {
				if (item.kind === 'inline')
					writes.push({ op: 'insertInline', id, offset: at++, atom: item });
				else if (item.text !== '') {
					writes.push({ op: 'insertText', id, offset: at, text: item.text, marks: item.marks });
					at += item.text.length;
				}
			}
			return at;
		};
		/** A joined line's children lead the block it joins; `moved` follow them. */
		const kids = (to: BlockId, l: FlowLine, moved: BlockId[] = []) => {
			const k = l.children?.length ?? 0;
			const ranks = c.ranksFor(to, 0, k + moved.length);
			if (k) writes.push({ op: 'insertBlocks', parent: to, index: 0, specs: l.children!, ranks });
			if (moved.length)
				writes.push({ op: 'moveBlocks', ids: moved, parent: to, index: k, ranks: ranks.slice(k) });
		};
		const head = text(B, o, first);
		const firstType = first.type && fit(parent, first.type);
		if (len === 0 && firstType && firstType === first.type)
			writes.push(...c.retype(B, firstType), ...c.redata(B, first.data ?? {}));
		kids(B, first);
		if (lines.length === 1) return { ...c.plan([B], writes), at: { block: B, offset: head } };

		const middle = specs(parent).slice(1, -1);
		// By the offset the paste splits `B` at (SW12-crdt-4), as Enter's split.
		const ranks = c.pieceRanks(B, o, middle.length + 1);
		const lastType = last().type && fit(parent, last().type);
		const tail = lastType ? { type: lastType, data: last().data } : c.tailOf(B);
		const rank = ranks.pop()!;
		const moved = c.childrenIds(B).filter((id) => !view.hidden?.(id));
		const length = len - o;
		writes.push({ op: 'splitBlock', id: B, offset: head, length, newId: T, tail, parent, rank });
		kids(T, last(), moved);
		if (middle.length)
			writes.push({ op: 'insertBlocks', parent, index: index + 1, specs: middle, ranks });
		const at = { block: T, offset: text(T, 0, last()) };
		return { ...c.plan([B, ...middle.map((m) => m.id), T], writes), at };
	}
});
