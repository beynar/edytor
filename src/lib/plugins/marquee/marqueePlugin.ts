import type { Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { onPress } from '$lib/events/onFocus.js';
import MarqueeBox from './MarqueeBox.svelte';
import { MarqueeController, type MarqueeBoxPayload } from './MarqueeController.svelte.js';

export type MarqueePluginOptions = {
	/**
	 * An element around the editor whose empty area starts a marquee too (the
	 * page, as in Notion): a CSS selector the editor's element is matched
	 * against with `closest()`, or a function of the editor's element. A
	 * press on that element itself, or on a wrapper between it and the
	 * editor, starts one; its other content (a title, a button) keeps its
	 * presses.
	 */
	container?: string | ((editor: HTMLElement) => Element | null | undefined);
	/** How far (px) the pointer moves before the rectangle starts: a shorter press is a click. Default 4. */
	threshold?: number;
	/** Replace the rectangle's markup; it renders in a host placed and sized to the rectangle. */
	box?: Snippet<[MarqueeBoxPayload]>;
};

/** The handle gutter: a block handle's own box, around its buttons (never a button). */
const HANDLE_HOST = '[data-edytor-block-handle-host]';

const controllers = new WeakMap<Edytor, MarqueeController>();

/** The marquee's controller of `edytor`; `undefined` when the plugin is not listed. @internal */
export const marqueeController = (edytor: Edytor): MarqueeController | undefined =>
	controllers.get(edytor);

/**
 * Block selection with a rectangle (Notion's rubber band), opt-in: a press
 * in the editor's empty area — the margins beside the blocks (the handle
 * gutter, not a handle), the space below the last block, an optional
 * `container` around the editor — then a drag draws a rectangle and selects,
 * live, the blocks it meets. Shift or Mod adds to the selection there was;
 * Escape gives it back. On release the block selection stays and the editor
 * has the keys. A click without a drag keeps what a press there did (below
 * the last block, the trailing paragraph).
 */
export const createMarqueePlugin =
	(options: MarqueePluginOptions = {}): Plugin =>
	(edytor) => {
		const controller = new MarqueeController(edytor, options.threshold ?? 4);
		controllers.set(edytor, controller);
		return {
			onEdytorAttached: ({ node }) => {
				const layer = edytor.overlay.layer!;
				const offs = [
					// The host's own area: classified with the editor's presses (`events/onFocus.ts`).
					edytor.selection.pointer.claimMargins((event) => controller.press(event, true)),
					onPress(edytor, layer, (event) => {
						const target = event.target as Element | null;
						if (target?.matches?.(HANDLE_HOST)) controller.press(event, false);
					})
				];
				const container =
					typeof options.container === 'string'
						? node.closest(options.container)
						: options.container?.(node);
				if (container)
					offs.push(
						onPress(edytor, container, (event) => {
							const target = event.target as Node | null;
							const around =
								target === container ||
								(target !== node && !!target?.contains(node) && container.contains(target));
							if (around) controller.press(event, false);
						})
					);
				const unmount = edytor.overlay.mount(
					MarqueeBox,
					{ controller, box: options.box },
					'edytor-marquee-host',
					6,
					(host) => {
						const rect = controller.rect;
						return () =>
							Object.assign(host.style, {
								pointerEvents: 'none',
								display: rect ? '' : 'none',
								...(rect && {
									left: `${rect.left}px`,
									top: `${rect.top}px`,
									width: `${rect.width}px`,
									height: `${rect.height}px`
								})
							});
					}
				);
				return () => {
					controller.destroy();
					offs.forEach((off) => off());
					unmount();
				};
			}
		};
	};

/** The marquee with the default rectangle. */
export const marqueePlugin = createMarqueePlugin();
