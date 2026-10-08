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

/**
 * The view's dragged text dropped at `to` (`moveText`, one command and one
 * undo step): the range's deletion (`replaceRange`, the deletion half of a
 * replacement), then its content placed where the drop point is after it
 * (`insertFlow`, as a paste); with `copy`, the placement alone. A move
 * dropped inside its own range changes nothing. The content is selected
 * after. Answers whether it wrote.
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
	/** The plan hooks see: the move's deletion, or the copy's placement. */
	const prepare = (): Prepared =>
		copy ? place(to) : facade.prepare.replaceRange(start, end, view);
	// The drop point, bound to the text before it: the deletion before it moves it.
	const point: DocAnchor | null = facade.anchorAt(to.block, to.offset, 'left');
	const block = edytor.idToBlock.get(to.block);
	/** Where the content went: its start (bound to the text before it) and its end. */
	const placed: { from?: DocAnchor | null; to?: { block: string; offset: number } | null } = {};
	const payload = { from: { start, end }, to, copy };
	dispatcher.dispatch('moveText', payload, { block }, (_payload, plan = prepare()) => {
		if (!('writes' in plan)) return;
		let at: SelectionPoint | null = to;
		if (!copy) {
			applyAt(edytor, plan);
			const resolved = point && facade.resolveAnchor(point);
			at = resolved ? { block: resolved.blockId, offset: resolved.offset } : null;
		}
		if (!at) return;
		placed.from = facade.anchorAt(at.block, at.offset, 'left');
		placed.to = applyAt(edytor, copy ? plan : place(at));
	});
	if (dispatcher.last?.status !== 'applied' || !placed.to) return false;
	const first = placed.from && facade.resolveAnchor(placed.from);
	const [startText, startOffset] = caretOf.call(
		edytor,
		first ? { block: first.blockId, offset: first.offset } : null
	);
	const [endText, endOffset] = caretOf.call(edytor, placed.to);
	if (startText && endText) edytor.selection.setAtRange(startText, startOffset, endText, endOffset);
	else if (endText) edytor.selection.setAtTextOffset(endText, endOffset);
	return true;
};
