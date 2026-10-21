/**
 * The types flow placement (`insertFlow`: the `flow.*` rows, prepared in
 * `doc/ops.ts`) reads, and where the caret ends a placed block.
 */
import type { BlockId, BlockSpec, Destination } from './placement/model.js';
import type { DocPosition, RangeView } from './rangeDelete.js';

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

/** The units of a line's content (an atom counts 1). */
export const lengthOf = (l: FlowLine) =>
	(l.content ?? []).reduce((n, i) => n + (i.kind === 'text' ? i.text.length : 1), 0);

/**
 * Where the caret ends a placed block: its own content's end when it shows a
 * line (renders its content, no void; a toggle's header, never its body),
 * else its last child's (a list's last item, a code block's last line),
 * else nowhere (a divider). The flow and the emptied document's virtual
 * paragraph (`doc.empty.virtual`) place the caret by it.
 */
export const placedEnd = (
	roleOf: (kind: string) => { childless: boolean; rendersContent: boolean }
) => {
	const endOf = (s: BlockSpec): DocPosition | undefined => {
		const role = roleOf(s.type);
		if (role.rendersContent && !role.childless) return { block: s.id, offset: lengthOf(s) };
		for (const kid of [...(s.children ?? [])].reverse()) {
			const at = endOf(kid);
			if (at) return at;
		}
		return undefined;
	};
	return endOf;
};
