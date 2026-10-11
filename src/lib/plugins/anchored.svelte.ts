/**
 * A panel the overlay draws under an element of the page (the code
 * language list under its button, the equation editor under its
 * equation): the anchor's box, measured on the overlay's frames, and the
 * one rule that closes the panel without moving the keys: its anchor gone,
 * a press or a focus outside the panel and its anchor, the view turning
 * readonly.
 */
import type { Component } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import { onPress } from '$lib/events/onFocus.js';
import { layerBox, pin, sameValues, type LayerBox } from '$lib/surface/overlay.js';

export class Anchored {
	/** The anchor's box in the overlay's frame while the panel is open, else `null` (reactive). */
	box = $state.raw<LayerBox | null>(null);

	constructor(
		private edytor: Edytor,
		/** The overlay host's name: its element is `[data-<name>]`. */
		private name: string,
		/** The element the panel stands under: `null` when it left the page, `undefined` while closed. */
		private anchor: () => Element | null | undefined,
		/** Close the panel, the keys where they are. */
		private dismiss: () => void
	) {}

	/** Where the panel stands: `gap` under its anchor, from its middle with `center`, layer-relative. */
	place = (gap: number, center = false) => {
		const box = this.box;
		return box && { left: box.x + (center ? box.width / 2 : 0), top: box.y + box.height + gap };
	};

	/** `at` is outside the panel's host and its anchor: the panel closes. */
	#outside = (at: EventTarget | null, host: Element | null | undefined) => {
		if (!(at instanceof Node)) return;
		if (!host?.contains(at) && !this.anchor()?.contains(at)) this.dismiss();
	};

	/**
	 * Focus left a field of the panel (its `focusout`): for somewhere outside
	 * the panel and its anchor, it closes; with no new focus (the window went
	 * to the background), it stays.
	 */
	blurred = (event: FocusEvent) =>
		this.#outside(
			event.relatedTarget,
			(event.currentTarget as Element | null)?.closest(`[data-${this.name}]`)
		);

	/**
	 * Mount the panel in the overlay at `zIndex` (above the block handles, 5,
	 * by default), with a press listener (capture) on `node`'s document and
	 * the readonly rule. Answers the teardown, which closes it.
	 */
	mount = <Props extends Record<string, unknown>>(
		node: HTMLElement,
		component: Component<Props>,
		props: Props,
		zIndex = 7
	) => {
		const { edytor } = this;
		const offPress = onPress(
			edytor,
			node.ownerDocument,
			(event) =>
				this.anchor() !== undefined &&
				this.#outside(
					event.target,
					(event.target as Element | null)?.closest?.(`[data-${this.name}]`)
				),
			true
		);
		const unmount = edytor.overlay.mount(component, props, this.name, zIndex, (host, origin) => {
			const anchor = this.anchor();
			const box = layerBox(anchor, origin);
			return () => {
				pin(host);
				if (anchor === null) return this.dismiss();
				if (!sameValues(box, this.box)) this.box = box;
			};
		});
		const offLock = $effect.root(() => {
			$effect(() => {
				if (edytor.readonly) this.dismiss();
			});
		});
		return () => {
			offPress();
			offLock();
			unmount();
			this.dismiss();
		};
	};
}
