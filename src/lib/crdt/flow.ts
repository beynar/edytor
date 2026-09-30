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
 * - a line that joins no text (a list, a code block, a divider: it renders
 *   none of its own, or is a void or an island) is placed as a block, never
 *   joined; the text after the position stays in a shown line of the
 *   block's kind (`flow.apart`, GX-01), and the caret ends the last pasted
 *   shown line;
 * - in a code line (a `lines` island) the lines, nested ones included, are
 *   placed as plain lines (`flow.lines`);
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
import { id as freshId } from '../utils.js';

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
	/** A kind's display role: void, an island, whether it renders its own content. */
	roleOf: (kind: string) => { void: boolean; island: boolean; rendersContent: boolean };
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

/**
 * Where the caret ends a placed block: its own content's end when it shows a
 * line (renders its content, no void; a toggle's header, never its body),
 * else its last child's (a list's last item, a code block's last line),
 * else nowhere (a divider). The flow and the emptied document's virtual
 * paragraph (`doc.empty.virtual`) place the caret by it.
 */
export const placedEnd = (roleOf: (kind: string) => { void: boolean; rendersContent: boolean }) => {
	const endOf = (s: BlockSpec): DocPosition | undefined => {
		const role = roleOf(s.type);
		if (role.rendersContent && !role.void) return { block: s.id, offset: lengthOf(s) };
		for (const kid of [...(s.children ?? [])].reverse()) {
			const at = endOf(kid);
			if (at) return at;
		}
		return undefined;
	};
	return endOf;
};

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
		/** `l` and its nested lines as runs, each line that shows its own content one run. */
		const plain = (l: FlowLine): FlowLine[] => [
			...(!l.type || c.roleOf(l.type).rendersContent ? [{ id: l.id, content: l.content }] : []),
			...(l.children ?? []).flatMap(plain)
		];
		const endOf = placedEnd(c.roleOf);
		/** Whole blocks at a slot, after `pre`; the caret ends the last one's shown content. */
		const atSlot = (dest: Destination, pre: PlanStep[]): Prepared => {
			const placed = specs(dest.parent);
			const p = c.insertBlocks(dest, placed);
			const at = endOf(placed.at(-1)!) ?? { block: last().id, offset: lengthOf(last()) };
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
		// A line of a lines island (a code line) takes plain lines: every line the flow
		// shows, nested ones included, in order; no block lands in the island (`flow.lines`).
		const inLines = parent !== null && c.isLines(parent);
		if (inLines) lines = lines.flatMap(plain);
		if (lines.length === 0) return { ...c.plan([B], []), at: { block: B, offset: o } };
		if (flow.whole && !inLines)
			return atSlot({ parent, index: index + 1 }, empty ? [c.remove(B, [])] : []);
		// A void is never split: its caption takes the lines as one run.
		const br = { kind: 'text' as const, text: '\n' };
		if (c.isVoid(B)) {
			const content = lines.flatMap((l, i) => [...(i ? [br] : []), ...(l.content ?? [])]);
			lines = [{ id: lines[0]!.id, content }];
		}
		/**
		 * A line that joins no text (`flow.apart`): its kind renders none of its own, or
		 * is a void or an island (a list, a code block, a divider, an image). It is placed
		 * as a block, never joined, so no text lands where the view hides it (GX-01).
		 */
		const apart = (l: FlowLine) => {
			const kind = l.type && fit(parent, l.type);
			const role = kind ? c.roleOf(kind) : undefined;
			return !!role && (!role.rendersContent || role.void || role.island);
		};
		const first = lines[0]!;
		const [joinsHead, joinsTail] = [!apart(first), lines.length > 1 && !apart(last())];
		const all = specs(parent);
		const placed = all.slice(joinsHead ? 1 : 0, joinsTail ? -1 : undefined);
		const ids = placed.map((s) => s.id);
		if (c.collides([...(joinsHead ? (first.children ?? []) : []), ...all.slice(joinsHead ? 1 : 0)]))
			return c.refused;
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
		const kids = (to: BlockId, l: FlowLine | undefined, moved: BlockId[] = []) => {
			const k = l?.children?.length ?? 0;
			const ranks = c.ranksFor(to, 0, k + moved.length);
			if (k) writes.push({ op: 'insertBlocks', parent: to, index: 0, specs: l!.children!, ranks });
			if (moved.length)
				writes.push({ op: 'moveBlocks', ids: moved, parent: to, index: k, ranks: ranks.slice(k) });
		};
		/** `l` joins `B` at `at`: its content, its kind when `B` shows no text, its children first. */
		const join = (l: FlowLine, at: number): number => {
			const end = text(B, at, l);
			const kind = l.type && fit(parent, l.type);
			if (len === 0 && kind && kind === l.type)
				writes.push(...c.retype(B, kind), ...c.redata(B, l.data ?? {}));
			kids(B, l);
			return end;
		};
		/** The placed lines at `at` among `B`'s siblings, `ranks` theirs. */
		const place = (at: number, ranks: string[]) => {
			if (placed.length)
				writes.push({ op: 'insertBlocks', parent, index: at, specs: placed, ranks });
		};
		// Where the placed lines end the caret: after their last shown line (`flow.apart`).
		const end = placed.length ? endOf(placed.at(-1)!) : undefined;

		// Nothing before the position and the first line stands apart: the lines go before `B`,
		// which keeps its text and takes a joining last line, or goes when empty and not needed.
		if (!joinsHead && o === 0) {
			place(index, c.ranksFor(parent, index, placed.length));
			if (joinsTail) {
				const at = join(last(), 0);
				return { ...c.plan([...ids, B], writes), at: { block: B, offset: at } };
			}
			if (empty && end) return { ...c.plan(ids, [...writes, c.remove(B, [])]), at: end };
			return { ...c.plan([...ids, B], writes), at: end ?? { block: B, offset: 0 } };
		}

		const head = joinsHead ? join(first, o) : o;
		if (lines.length === 1 && joinsHead)
			return { ...c.plan([B], writes), at: { block: B, offset: head } };
		const moved = c.childrenIds(B).filter((id) => !view.hidden?.(id));
		// Nothing after the position to keep, and the caret has a line: no split.
		if (!joinsTail && o === len && moved.length === 0 && end) {
			place(index + 1, c.pieceRanks(B, o, placed.length));
			return { ...c.plan([B, ...ids], writes), at: end };
		}
		// The rest of `B` stays in a shown line: the last line's block when it joins, else
		// a line of `B`'s kind, as Enter makes; one made only for the caret (after a
		// divider at the end) is a fresh line of the parent's default kind.
		const T = joinsTail ? last().id : freshId('b');
		const lastType = joinsTail && last().type && fit(parent, last().type);
		const bare = !joinsTail && o === len && moved.length === 0;
		const tail = lastType
			? { type: lastType, data: last().data }
			: bare
				? { type: c.defaultChild(parent), data: {} }
				: c.tailOf(B);
		// By the offset the paste splits `B` at (SW12-crdt-4), as Enter's split.
		const ranks = c.pieceRanks(B, o, placed.length + 1);
		const rank = ranks.pop()!;
		const length = len - o;
		writes.push({ op: 'splitBlock', id: B, offset: head, length, newId: T, tail, parent, rank });
		kids(T, joinsTail ? last() : undefined, moved);
		place(index + 1, ranks);
		const at = joinsTail
			? { block: T, offset: text(T, 0, last()) }
			: (end ?? { block: T, offset: 0 });
		return { ...c.plan([B, ...ids, T], writes), at };
	}
});
