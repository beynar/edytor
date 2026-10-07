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
 *   slot (`flow.slot`), and at a slot they are placed with nothing replaced
 *   (`flow.place`: an accepted suggestion), all at plain ranks (`insertBlocks`: their order
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
/** An admitted flow: lines in order, ids fresh; `whole`: a block-selection copy. */
export type Flow = { lines: FlowLine[]; whole?: boolean };
/**
 * What the view tells flow placement beyond range deletion's view: a
 * container's flat item kind (`numbered-list-item` for an `ordered-list`).
 */
export type FlowView = RangeView & {
	itemKind?: (parent: BlockId) => string | undefined;
	/**
	 * A container's header whose body shows (an open toggle, a callout or
	 * quote with nested lines): Enter at its end opens a first child, so what
	 * a flow places at its end leads its children, which stay (`flow.header`).
	 * `'closed'` (a closed toggle): it goes after, a joined line's children too, so
	 * none lands in the hidden body. An empty header keeps its kind.
	 */
	header?: (id: BlockId) => boolean | 'closed';
};
/** A position, the blocks the flow replaces (`flow.slot`), or a slot (`flow.place`). */
export type FlowTarget = DocPosition | { replace: readonly BlockId[] } | { slot: Destination };

/** What flow placement reads beyond range deletion's context. */
export type FlowContext = RangeDeleteContext & {
	defaultChild: (parent: BlockId | null) => string;
	/** `kind`, or `parent`'s item where it does not fit there (the container rule). */
	fitted: (parent: BlockId | null, kind: string | undefined) => string | undefined;
	retype: (id: BlockId, type: string) => PlanStep[];
	sanitize: (spec: BlockSpec) => BlockSpec;
	collides: (specs: readonly BlockSpec[]) => boolean;
	isVoid: (id: BlockId) => boolean;
	/**
	 * A kind's display role: void, an island, whether it renders its own
	 * content, and a layout's item kind (`layout.*`).
	 */
	roleOf: (kind: string) => {
		void: boolean;
		island: boolean;
		rendersContent: boolean;
		layout?: string;
	};
	/** `id` is a layout item or sits inside one (D2: no layout lands there). */
	insideItem: (id: BlockId) => boolean;
	tailOf: (id: BlockId) => SplitTail;
	ranksFor: (parent: BlockId | null, index: number, count: number) => string[];
	/** `ranksFor` for new blocks: after a block this client ranked, in its run there (H1). */
	insertRanks: (parent: BlockId | null, index: number, count: number) => string[];
	/** Ranks for the `count` blocks a split of `id` at `at` puts after it, by that offset. */
	pieceRanks: (id: BlockId, at: number, count: number) => string[];
	redata: (id: BlockId, data: Record<string, unknown>) => PlanStep[];
	/** `deleteBlocks`; `filled`: a parent the plan fills again, never emptied (`flow.slot`). */
	deleteBlocks: (ids: readonly BlockId[], filled?: BlockId | null) => Prepared;
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
		const specs = (parent: BlockId | null, of: FlowLine[] = lines): BlockSpec[] =>
			of.map((l) => ({ ...l, type: fit(parent, l.type) ?? c.defaultChild(parent) }));
		const last = () => lines.at(-1)!;
		/** `l` and its nested lines as runs, each line that shows its own content one run. */
		const plain = (l: FlowLine): FlowLine[] => [
			...(!l.type || c.roleOf(l.type).rendersContent ? [{ id: l.id, content: l.content }] : []),
			...(l.children ?? []).flatMap(plain)
		];
		const endOf = placedEnd(c.roleOf);
		/**
		 * A layout line, here or nested, as its items' lines in reading order, and
		 * any other child it holds (`flow.layout`, D2): no layout lands in an item.
		 */
		const unwrap = (l: FlowLine): FlowLine[] => {
			const item = l.type ? c.roleOf(l.type).layout : undefined;
			if (item === undefined)
				return [l.children ? { ...l, children: l.children.flatMap(unwrap) as BlockSpec[] } : l];
			return (l.children ?? []).flatMap((kid) =>
				kid.type === item ? (kid.children ?? []).flatMap(unwrap) : unwrap(kid)
			);
		};
		const intoItem = (parent: BlockId | null) => {
			if (parent !== null && c.insideItem(parent)) lines = lines.flatMap(unwrap);
		};
		/** Whole blocks at a slot, after `pre`; the caret ends the last one's shown content. */
		const atSlot = (dest: Destination, pre: PlanStep[]): Prepared => {
			const placed = specs(dest.parent);
			const p = c.insertBlocks(dest, placed);
			const at = endOf(placed.at(-1)!) ?? { block: last().id, offset: lengthOf(last()) };
			return 'writes' in p ? { ...c.plan(p.ids, [...pre, ...p.writes]), at } : p;
		};
		if ('replace' in target || 'slot' in target) {
			let slot: Destination;
			let pre: PlanStep[] = [];
			if ('slot' in target) slot = target.slot;
			else {
				// The lines fill the first block's slot: its parent is never emptied
				// by the delete, so a column keeps its layout (`layout.flow-slot`).
				const at = c.order().at;
				const first = target.replace
					.filter((id) => at.has(id))
					.sort((a, b) => at.get(a)! - at.get(b)!)[0];
				const del = c.deleteBlocks(
					target.replace,
					first === undefined ? undefined : c.positionOf(first)?.parent
				);
				if (!('writes' in del)) return del;
				if (first === undefined) return c.refused;
				slot = c.positionOf(first)!;
				pre = [...del.writes];
			}
			intoItem(slot.parent);
			if (lines.length === 0) return c.plan([], []);
			// In a code block (selected lines, a slot), the lines are plain lines too (`flow.lines`, HX-06).
			if (slot.parent !== null && c.isLines(slot.parent)) {
				const shown = lines.flatMap(plain);
				lines = shown.length ? shown : [{ id: lines[0]!.id, content: [] }];
			}
			return atSlot(slot, pre);
		}
		const B = c.ref(target.block);
		if (!c.contentTarget(B) || !c.rendersContent(B)) return c.refused;
		const len = c.displayLength(B);
		const o = Math.max(0, Math.min(target.offset, len));
		const { parent, index } = c.positionOf(B)!;
		intoItem(B);
		const empty = len === 0 && c.childrenIds(B).length === 0;
		// A line of a lines island (a code line) takes plain lines: every line the flow
		// shows, nested ones included, in order; no block lands in the island (`flow.lines`).
		const inLines = parent !== null && c.isLines(parent);
		if (inLines) lines = lines.flatMap(plain);
		// A line that joins no text under `under` (`flow.apart`, GX-01): its kind renders
		// none of its own (a list, a code block), or is a void or an island.
		const apart = (l: FlowLine, under: BlockId | null) => {
			const kind = l.type && fit(under, l.type);
			const role = kind ? c.roleOf(kind) : undefined;
			return !!role && (!role.rendersContent || role.void || role.island);
		};
		// At the end of a container's header whose body shows, what follows the caret
		// leads its children and the body stays, as Enter opens a first child
		// (`flow.header`, HX-10), unless the first line stands apart and replaces an empty
		// one (`flow.apart`); elsewhere it follows `B` among its siblings.
		const header = view.header?.(B);
		// A closed header shows no children: a line it takes brings none into its hidden
		// body; they follow it, shown (`flow.header`, DR-crdt-1).
		const shut = header === 'closed';
		const inside =
			o === len && !inLines && !flow.whole && header === true && !(empty && apart(lines[0]!, B));
		const home = inside ? B : parent;
		if (lines.length === 0) return { ...c.plan([B], []), at: { block: B, offset: o } };
		if (flow.whole && !inLines)
			return atSlot({ parent, index: index + 1 }, empty ? [c.remove(B, [])] : []);
		// A void is never split: its caption takes the lines as one run.
		const br = { kind: 'text' as const, text: '\n' };
		if (c.isVoid(B)) {
			const content = lines.flatMap((l, i) => [...(i ? [br] : []), ...(l.content ?? [])]);
			lines = [{ id: lines[0]!.id, content }];
		}
		// So a first line it joins leaves its nested lines as lines of the flow after it.
		if (shut && lines[0]!.children?.length && !apart(lines[0]!, home))
			lines = [{ ...lines[0]!, children: undefined }, ...lines[0]!.children!, ...lines.slice(1)];
		const first = lines[0]!;
		const [joinsHead, joinsTail] = [!apart(first, home), lines.length > 1 && !apart(last(), home)];
		const all = specs(home);
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
		const kids = (
			to: BlockId,
			l: FlowLine | undefined,
			moved: BlockId[] = [],
			ranks = c.ranksFor(to, 0, (l?.children?.length ?? 0) + moved.length)
		) => {
			const k = l?.children?.length ?? 0;
			if (k) writes.push({ op: 'insertBlocks', parent: to, index: 0, specs: l!.children!, ranks });
			if (moved.length)
				writes.push({ op: 'moveBlocks', ids: moved, parent: to, index: k, ranks: ranks.slice(k) });
		};
		/**
		 * `l` joins `B` at `at`: its content, its kind when `B` shows no text (a header
		 * keeps its own, as Enter does), its children first.
		 */
		const join = (l: FlowLine, at: number, ranks?: string[]): number => {
			const end = text(B, at, l);
			const kind = l.type && fit(parent, l.type);
			if (len === 0 && !header && kind && kind === l.type)
				writes.push(...c.retype(B, kind), ...c.redata(B, l.data ?? {}));
			if (!shut) kids(B, l, [], ranks);
			return end;
		};
		/** The placed lines at `at` under `home`, `ranks` theirs. */
		const place = (at: number, ranks: string[]) => {
			if (placed.length)
				writes.push({ op: 'insertBlocks', parent: home, index: at, specs: placed, ranks });
		};
		// Under a header, the first line's children, the placed lines and the rest, in order.
		const k = joinsHead ? (first.children?.length ?? 0) : 0;
		const lead = inside ? c.ranksFor(B, 0, k + placed.length + 1) : [];
		const slot = inside ? 0 : index + 1;
		// Where the placed lines end the caret: after their last shown line (`flow.apart`).
		const end = placed.length ? endOf(placed.at(-1)!) : undefined;

		// Nothing before the position and the first line stands apart: the lines go before `B`,
		// which keeps its text and takes a joining last line, or goes when empty and not needed.
		if (!joinsHead && o === 0 && !inside) {
			place(index, c.insertRanks(parent, index, placed.length));
			if (joinsTail) {
				const at = join(last(), 0);
				// A closed header's taken line's nested lines follow it, the caret ending them.
				const after = shut ? specs(parent, last().children ?? []) : [];
				if (after.length) {
					const ranks = c.insertRanks(parent, index + 1, after.length);
					const slot = index + placed.length + 1;
					writes.push({ op: 'insertBlocks', parent, index: slot, specs: after, ranks });
				}
				const caret = after.length ? endOf(after.at(-1)!) : undefined;
				const touched = [...ids, B, ...after.map((s) => s.id)];
				return { ...c.plan(touched, writes), at: caret ?? { block: B, offset: at } };
			}
			if (empty && end) return { ...c.plan(ids, [...writes, c.remove(B, [])]), at: end };
			return { ...c.plan([...ids, B], writes), at: end ?? { block: B, offset: 0 } };
		}

		const head = joinsHead ? join(first, o, inside ? lead.slice(0, k) : undefined) : o;
		if (lines.length === 1 && joinsHead)
			return { ...c.plan([B], writes), at: { block: B, offset: head } };
		const moved = inside ? [] : c.childrenIds(B).filter((id) => !view.hidden?.(id));
		// Nothing after the position to keep, and the caret has a line: no split.
		if (!joinsTail && o === len && moved.length === 0 && end) {
			place(slot, inside ? lead.slice(k, -1) : c.pieceRanks(B, o, placed.length));
			return { ...c.plan([B, ...ids], writes), at: end };
		}
		// The rest of `B` stays in a shown line: the last line's block when it joins, else
		// a line of `B`'s kind, as Enter makes; one made only for the caret (after a
		// divider at the end) or under a header is a fresh line of its parent's default kind.
		const T = joinsTail ? last().id : freshId('b');
		const lastType = joinsTail && last().type && fit(home, last().type);
		const bare = !joinsTail && o === len && moved.length === 0;
		const tail = lastType
			? { type: lastType, data: last().data }
			: bare || inside
				? { type: c.defaultChild(home), data: {} }
				: c.tailOf(B);
		// By the offset the paste splits `B` at (SW12-crdt-4), as Enter's split.
		const ranks = inside ? lead.slice(k) : c.pieceRanks(B, o, placed.length + 1);
		const rank = ranks.pop()!;
		const length = len - o;
		writes.push({
			op: 'splitBlock',
			id: B,
			offset: head,
			length,
			newId: T,
			tail,
			parent: home,
			rank
		});
		kids(T, joinsTail ? last() : undefined, moved);
		place(slot, ranks);
		const at = joinsTail
			? { block: T, offset: text(T, 0, last()) }
			: (end ?? { block: T, offset: 0 });
		return { ...c.plan([B, ...ids, T], writes), at };
	}
});
