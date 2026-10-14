/**
 * A panel the app draws by an element of the page (the code language list
 * by its button, the callout icon picker by its icon, the equation editor
 * by its equation): that element as the panel's `anchor`, which the app's
 * markup places itself by, and the one rule that closes the panel without
 * moving the keys: its anchor gone, a press or a focus outside the panel
 * and its anchor, the view turning readonly.
 */
import type { Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import { onPress } from '$lib/events/onFocus.js';
import { mountChrome, virtualAnchor } from './chrome.js';

export class Anchored {
	constructor(
		private edytor: Edytor,
		/** The overlay host's name: its element is `[data-<name>]`. */
		private name: string,
		/** The element the panel stands by: `null` when it left the page, `undefined` while closed. */
		private element: () => Element | null | undefined,
		/** Close the panel, the keys where they are. */
		private dismiss: () => void
	) {}

	/** Where the panel stands: its element's box, read on every call (`ChromeAnchor`). */
	readonly anchor = virtualAnchor(
		() => this.element()?.getBoundingClientRect(),
		() => this.element()
	);

	/** `at` is outside the panel's host and its element: the panel closes. */
	#outside = (at: EventTarget | null, host: Element | null | undefined) => {
		if (!(at instanceof Node)) return;
		if (!host?.contains(at) && !this.element()?.contains(at)) this.dismiss();
	};

	/**
	 * Focus left a field of the panel (its `focusout`): for somewhere outside
	 * the panel and its element, it closes; with no new focus (the window
	 * went to the background), it stays.
	 */
	blurred = (event: FocusEvent) =>
		this.#outside(
			event.relatedTarget,
			(event.currentTarget as Element | null)?.closest(`[data-${this.name}]`)
		);

	/**
	 * Mount the app's `snippet` with `payload` in the overlay at `zIndex`
	 * (above the block handles, 5, by default) while `shown` holds, with a
	 * press listener (capture) on `node`'s document, the anchor-gone rule
	 * (on the overlay's frames) and the readonly rule. Answers the teardown,
	 * which closes it.
	 */
	mount = <T>(
		node: HTMLElement,
		snippet: Snippet<[T]>,
		payload: T,
		shown: () => unknown,
		zIndex = 7
	) => {
		const { edytor } = this;
		const offPress = onPress(
			edytor,
			node.ownerDocument,
			(event) =>
				this.element() !== undefined &&
				this.#outside(
					event.target,
					(event.target as Element | null)?.closest?.(`[data-${this.name}]`)
				),
			true
		);
		const unmount = mountChrome(
			edytor,
			snippet,
			payload,
			shown,
			{
				name: this.name,
				zIndex,
				measure: () => (this.element() === null ? this.dismiss : undefined)
			},
			this.dismiss
		);
		return () => {
			offPress();
			unmount();
			this.dismiss();
		};
	};
}
