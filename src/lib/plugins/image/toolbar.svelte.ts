/**
 * The image toolbar (Notion's), its own plugin: the app's `toolbar` over
 * the image the view's image chrome is on (`ImageControls`), at its top
 * right: the alignments and the alt text field. An alignment is one
 * `patchData` command; the alt text is written as it is typed (the
 * dispatcher groups the keystrokes into one step). While the alt field is
 * open the chrome stays on its image; a press outside the toolbar and the
 * field (`onPress`) or focus leaving the field closes it.
 */
import type { Attachment } from 'svelte/attachments';
import type { Snippet } from 'svelte';
import type { Plugin } from '$lib/plugins.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { pin } from '$lib/surface/overlay.js';
import { imageAlignOf, imageAltOf, type ImageAlign } from './image.js';
import { imageControls, type ImageControls } from './controls.svelte.js';
import { identify, keepFocus, onPressOutside } from '../chrome.js';
import { all, listen } from '$lib/utils/listen.js';
import ImageToolbarHost from './ImageToolbarHost.svelte';
import { keysOf } from '../list.svelte.js';

/** Where a press keeps the alt field open: the toolbar (its Alt button toggles it) and the field's own. */
const ALT_CHROME =
	'[data-edytor-image-alt-panel], [data-edytor-image-toolbar], [data-edytor-image-alt]';

/**
 * What a `toolbar` snippet receives: the image the chrome is on (`box`),
 * its alignment (`align`) and alt text (`alt`, `setAlt`), the alt field's
 * state (`editing`, `toggleAlt`, `closeAlt`) and the attachments that give
 * your markup its behavior (`bar`, `altField`).
 */
export class ImageToolbar {
	constructor(
		/** @internal */
		readonly controls: ImageControls
	) {}

	/** The measured image the toolbar is on (`null`: none). */
	get box() {
		return this.controls.box;
	}

	/** The view is readonly (reactive). */
	get readonly() {
		return this.controls.readonly;
	}

	/** The image whose alt field is open: the chrome stays on it. */
	get editing() {
		return this.controls.held;
	}
	set editing(id: string | null) {
		this.controls.held = id;
	}

	get #edytor() {
		return this.controls.edytor;
	}

	/** Set the target image's alignment: one `patchData` command. */
	align = (align: ImageAlign) => {
		const block = this.#block();
		if (block && imageAlignOf(block.data) !== align)
			block.edytor.patchData(block.id, [{ path: ['align'], value: align }]);
	};

	/** The target image's alt text. */
	get alt() {
		return imageAltOf(this.#block()?.data);
	}

	/** Write the alt text as it is typed: the dispatcher groups the keystrokes into one step. */
	setAlt = (alt: string) => {
		const block = this.#block();
		if (block && imageAltOf(block.data) !== alt)
			block.edytor.patchData(block.id, [{ path: ['alt'], value: alt }]);
	};

	/** Open (or close) the alt field of the target image. */
	toggleAlt = () => {
		this.editing = this.editing ? null : (this.box?.id ?? null);
		this.#edytor.overlay.invalidate();
	};

	/** Focus left the alt field: for somewhere outside its panel, the field closes. @internal */
	blurred = (event: FocusEvent) => {
		const to = event.relatedTarget;
		const field = event.currentTarget as Element | null;
		const panel = field?.closest('[data-edytor-image-alt-panel]') ?? field;
		// No new focus (the window went to the background): the field stays.
		if (!(to instanceof Node) || panel?.contains(to)) return;
		this.closeAlt();
	};

	/**
	 * The image's toolbar (`{@attach controls.bar}`, named by your markup): its
	 * `toolbar` role unless it has its own, the mark a press outside the alt field
	 * reads (a press on the toolbar keeps the field open, so its Alt button
	 * toggles it), and presses that keep the editor's focus.
	 */
	bar: Attachment<HTMLElement> = (node) => {
		if (!node.hasAttribute('role')) node.setAttribute('role', 'toolbar');
		node.setAttribute('data-edytor-image-toolbar', '');
		return listen(node, 'mousedown', keepFocus);
	};

	/**
	 * The alt text field (`{@attach controls.altField}`): focused when it
	 * opens; Enter or Escape closes it and gives the editor its keys back,
	 * focus moving out of it (or of the element marked
	 * `data-edytor-image-alt-panel` around it) closes it, and a press on it
	 * keeps it open. Write its value with `setAlt`.
	 */
	altField: Attachment<HTMLInputElement> = (node) => {
		identify(node, this.#edytor.popups.idOf('image-alt'));
		node.setAttribute('data-edytor-image-alt', '');
		node.focus({ preventScroll: true });
		const close = () => this.closeAlt(true);
		return all(
			listen(node, 'keydown', keysOf({ Enter: close, Escape: close })),
			listen(node, 'focusout', this.blurred)
		);
	};

	/** Close the alt field; with `keys`, the editor takes the keys back. */
	closeAlt = (keys = false) => {
		if (this.editing === null) return;
		this.editing = null;
		this.#edytor.overlay.invalidate();
		if (keys) takeKeys(this.#edytor);
	};

	#block = () => {
		const id = this.box?.id;
		const block = id ? this.#edytor.idToBlock.get(id) : undefined;
		return block?.isInTree ? block : undefined;
	};
}

export type ImageToolbarOptions = {
	/**
	 * The toolbar over the hovered image (the alignments and the alt field);
	 * it renders while the image chrome shows and no handle drags, at the
	 * image's top right. Keep its behaviour with `{@attach toolbar.bar}` on
	 * the toolbar and `{@attach toolbar.altField}` on the alt field.
	 */
	toolbar: Snippet<[ImageToolbar]>;
};

/** The image toolbar: your `toolbar` over the image the chrome is on. The first listed claims the view. */
export const createImageToolbarPlugin =
	({ toolbar }: ImageToolbarOptions): Plugin =>
	(edytor) => ({
		onEdytorAttached: ({ node }) => {
			const controls = imageControls.get(edytor);
			if (!controls || controls.toolbar) return;
			const bar = (controls.toolbar = new ImageToolbar(controls));
			return all(
				// A press outside the alt panel and the toolbar (whose Alt button toggles it)
				// closes it (WebKit's lone `mousedown` too).
				onPressOutside(edytor, node.ownerDocument, ALT_CHROME, () => bar.closeAlt()),
				edytor.overlay.mount(
					ImageToolbarHost,
					{ toolbar: bar, snippet: toolbar },
					'edytor-image-toolbar-host',
					// With the image chrome: above the block handles and the column bands.
					7,
					(host) => () => pin(host)
				),
				() => (controls.toolbar = undefined)
			);
		}
	});
