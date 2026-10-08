import type { Edytor } from '$lib/edytor.svelte.js';
import type { Flow } from '$lib/crdt/flow.js';
import type { Prepared } from '$lib/crdt/edytor-doc.js';
import type { DocAnchor } from '$lib/crdt/index.js';
import { project, type SelectionPoint, type SelectionValue } from '$lib/session/selection.js';
import { viewOf } from '$lib/selection/visibility.js';
import { applyAt, caretOf } from '$lib/edytor.utils.js';
import { flowOfFragment } from './insertClipboardFragment.js';
import type { EdytorClipboardFragment } from './types.js';

/**
 * A view's own text drag, from its `dragstart` to its `dragend`: the
 * selected range it moves (anchored: it follows concurrent edits) and its
 * content as a clipboard fragment, also on the drag's data for a drop
 * elsewhere.
 */
export type TextDrag = {
	range: SelectionValue & { kind: 'text' };
	fragment: EdytorClipboardFragment;
	/** The drop's: Alt was held (a copy). */
	copy: boolean;
	/** Set while the view's own drop runs. */
	dropping: boolean;
};

const drags = new WeakMap<Edytor, TextDrag>();

/** The view's text drag in progress, if any. */
export const textDragOf = (edytor: Edytor) => drags.get(edytor);
export const startTextDrag = (edytor: Edytor, drag: Omit<TextDrag, 'copy' | 'dropping'>) =>
	void drags.set(edytor, { ...drag, copy: false, dropping: false });
export const endTextDrag = (edytor: Edytor) => void drags.delete(edytor);

/** Document order of two positions. */
const compare = (edytor: Edytor, a: SelectionPoint, b: SelectionPoint) =>
	a.block === b.block ? a.offset - b.offset : edytor.facade.compare(a.block, b.block);

/** `moveText`'s payload: the dragged range, the drop point (block offsets), whether it copies. */
type MoveText = {
	from: { start: SelectionPoint; end: SelectionPoint };
	to: SelectionPoint;
	copy: boolean;
};

/**
 * The view's dragged text dropped at `to` (`moveText`, one command and one
 * undo step): its content placed at the drop point as a paste places a flow
 * (`insertFlow`), then, for a move, the range deleted as a replacement
 * deletes it (`replaceRange`); with `copy`, the placement alone. Both halves
 * are prepared before any write, so hooks see the command's effect and
 * every step of both, a veto of any of them keeps everything, and a drop
 * either half refuses writes nothing. A move dropped inside its own range
 * changes nothing. The content is selected after. Answers whether it wrote.
 */
export const dropText = (edytor: Edytor, drag: TextDrag, to: SelectionPoint): boolean => {
	const { facade, dispatcher } = edytor;
	const { start, end } = project(drag.range, facade);
	if (!start || !end) return false;
	const { copy } = drag;
	// A move onto itself: nothing to write.
	if (!copy && compare(edytor, start, to) <= 0 && compare(edytor, to, end) <= 0) return false;
	const flow: Flow = flowOfFragment(drag.fragment);
	const view = viewOf(edytor);
	const place = (at: SelectionPoint) =>
		facade.prepare.insertFlow({ block: at.block, offset: at.offset }, flow, view);
	const remove = ({ start, end }: MoveText['from']) =>
		facade.prepare.replaceRange(start, end, view);
	/** Both halves at the current version, as hooks see them (a copy: the placement). */
	const prepare = ({ from, to, copy }: MoveText): Prepared =>
		copy ? place(to) : facade.compose(place(to), remove(from));
	const block = edytor.idToBlock.get(to.block);
	/** Where the content went: its start and its end, bound to the placed text. */
	const placed: { from?: DocAnchor | null; to?: DocAnchor | null } = {};
	const payload: MoveText = { from: { start, end }, to, copy };
	dispatcher.dispatch(
		'moveText',
		payload,
		{ block },
		({ from, to, copy }, plan) => {
			if (!plan || !('writes' in plan)) return;
			// The range, bound to its own first and last units: the placement outside it leaves them.
			const first = facade.anchorAt(from.start.block, from.start.offset, 'right');
			const last = facade.anchorAt(from.end.block, from.end.offset, 'left');
			placed.from = facade.anchorAt(to.block, to.offset, 'left');
			const at = applyAt(edytor, place(to));
			placed.to = at && facade.anchorAt(at.block, at.offset, 'left');
			if (copy || !at) return;
			const [a, b] = [first && facade.resolveAnchor(first), last && facade.resolveAnchor(last)];
			if (!a || !b) return;
			applyAt(
				edytor,
				remove({
					start: { block: a.blockId, offset: a.offset },
					end: { block: b.blockId, offset: b.offset }
				})
			);
		},
		prepare
	);
	if (dispatcher.last?.status !== 'applied' || !placed.to) return false;
	const point = (anchor: DocAnchor | null | undefined) => {
		const hit = anchor && facade.resolveAnchor(anchor);
		return hit ? { block: hit.blockId, offset: hit.offset } : null;
	};
	const [startText, startOffset] = caretOf.call(edytor, point(placed.from));
	const [endText, endOffset] = caretOf.call(edytor, point(placed.to));
	if (startText && endText) edytor.selection.setAtRange(startText, startOffset, endText, endOffset);
	else if (endText) edytor.selection.setAtTextOffset(endText, endOffset);
	return true;
};
