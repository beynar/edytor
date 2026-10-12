import type { Edytor } from '$lib/edytor.svelte.js';
import { takeKeys } from '$lib/events/onFocus.js';

/**
 * A resize drag from its press (the image's handles, a table column's and
 * a layout gap's bands): the press's default and propagation stop; a
 * `pointerdown` tracks its pointer (captured, on the document), a lone
 * `mousedown` (`isLonePress`: WebKit's first press after a native drag)
 * tracks the mouse on the window. `move` takes each move's client x, then
 * the overlay measures again; `end` takes the release's x, or `null` when
 * the drag ends without one (Escape, a cancel, the answered cancel, the view
 * no longer permitting a write), and nothing is to be written. After a
 * release the editor takes the keys (Notion: Mod+Z right after). Answers the
 * cancel (for the view turning readonly mid-drag).
 */
export const trackDrag = (
	edytor: Edytor,
	press: PointerEvent | MouseEvent,
	move: (x: number) => void,
	end: (x: number | null) => void
): (() => void) => {
	press.preventDefault();
	press.stopPropagation();
	const target = press.currentTarget as HTMLElement | null;
	const pointer = press.type === 'pointerdown';
	if (pointer) target?.setPointerCapture?.((press as PointerEvent).pointerId);
	const document = target?.ownerDocument ?? edytor.node?.ownerDocument;
	const tracked = pointer ? document : document?.defaultView;
	const [moves, ups] = pointer ? ['pointermove', 'pointerup'] : ['mousemove', 'mouseup'];
	const moved = (event: Event) => {
		if (!edytor.dispatcher.permits()) return finish(event);
		move((event as MouseEvent).clientX);
		edytor.overlay.invalidate();
	};
	const finish = (event: Event) => {
		tracked?.removeEventListener(moves, moved);
		tracked?.removeEventListener(ups, finish);
		tracked?.removeEventListener('pointercancel', finish);
		document?.removeEventListener('keydown', escape, true);
		const released = event.type === ups;
		end(released ? (event as MouseEvent).clientX : null);
		edytor.overlay.invalidate();
		if (released) takeKeys(edytor);
	};
	const escape = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		finish(event);
	};
	tracked?.addEventListener(moves, moved);
	tracked?.addEventListener(ups, finish);
	if (pointer) tracked?.addEventListener('pointercancel', finish);
	document?.addEventListener('keydown', escape, true);
	edytor.overlay.invalidate();
	return () => finish(new Event('cancel'));
};
