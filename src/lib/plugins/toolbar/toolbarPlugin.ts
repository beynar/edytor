import type { Snippet } from 'svelte';
import type { Plugin } from '$lib/plugins.js';
import { ToolbarController } from './ToolbarController.svelte.js';
import { mountChrome } from '../chrome.js';
import { placeNear } from '$lib/surface/overlay.js';
import { all, listen } from '$lib/utils/listen.js';

/** A press in a field of the chrome (an input, a select): it takes focus. */
const isNativeFieldEvent = (event: Event) =>
	event
		.composedPath()
		.some((target) => target instanceof Element && target.matches('input, textarea, select'));

export type ToolbarOptions = {
	/**
	 * The toolbar's markup; it renders while `controller.isVisible`, placed
	 * above the selection (without it, nothing shows). A press on it never takes the editor's focus (its
	 * fields, an input or a select, take their own). Give it the
	 * keyboard and ARIA with its attachments: `{@attach controller.popup}`
	 * and `{@attach controller.keys}` on the bar (its id, role, placement and
	 * publication; the shortcut that reaches it, the roving tab stop and
	 * Escape), `{@attach
	 * controller.linkField}` on a link field.
	 */
	toolbar?: Snippet<[ToolbarController]>;
	/**
	 * The card shown under a hovered link (`link.card`): it renders while
	 * `controller.card`, just below the hovered link (`controller.hoveredHref`,
	 * and `openHovered`, `editHovered`, `removeHovered`); without it, no
	 * card. A press on it never takes the editor's focus.
	 */
	card?: Snippet<[ToolbarController]>;
};

/** The selection toolbar, drawn by your `toolbar` snippet, and the link card by your `card`. */
export const createToolbarPlugin =
	(options: ToolbarOptions = {}): Plugin =>
	(edytor) => {
		const controller = new ToolbarController(edytor);

		/** Above the selection, kept in the viewport; measured in the overlay's frame, written after. */
		const positionToolbar = (host: HTMLElement) => {
			const editor = edytor.node;
			if (!editor || !controller.isVisible) return;
			const selection = editor.ownerDocument.getSelection();
			if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
			const range = selection.getRangeAt(0);
			if (typeof range.getBoundingClientRect !== 'function') return;
			return placeNear(host, range.getBoundingClientRect(), [460, 40], {
				above: true,
				center: true,
				// The bar, not its open panel: panels drop over the text below it.
				box: host.querySelector('[data-edytor-toolbar-bar]') ?? host.firstElementChild
			});
		};

		/** Just below the hovered link, flush with it (the host's top padding bridges the two). */
		const positionCard = (host: HTMLElement) => {
			const anchor = controller.hovered;
			if (!anchor || !controller.card) return;
			if (!anchor.isConnected) return () => controller.hover(null);
			const rect = anchor.getBoundingClientRect();
			const [left, top] = [`${Math.max(8, rect.left)}px`, `${rect.bottom}px`];
			return () => Object.assign(host.style, { left, top, paddingTop: '4px' });
		};

		/**
		 * The link card follows the pointer: over a link in the host it shows,
		 * and it stays while the pointer moves from that link onto the card;
		 * leaving both, or reaching another part of the host, hides it.
		 */
		const trackLinks = (node: HTMLElement, card: Element) => {
			const linkOf = (target: EventTarget | null) => {
				const element = target instanceof Element ? target : null;
				// A link the editor renders (a mark element), not a kind's own chrome.
				const anchor = element?.closest('a[href][data-edytor-mark]');
				return anchor instanceof HTMLAnchorElement && node.contains(anchor) ? anchor : null;
			};
			const inside = (target: EventTarget | null) =>
				target instanceof Node && (card.contains(target) || controller.hovered?.contains(target));
			const over = (event: MouseEvent) => {
				const anchor = linkOf(event.target);
				if (anchor) controller.hover(anchor);
				else if (!inside(event.target)) controller.hover(null);
			};
			const out = (event: MouseEvent) => {
				if (!inside(event.relatedTarget) && !linkOf(event.relatedTarget)) controller.hover(null);
			};
			return all(
				listen(node, 'mouseover', over),
				listen(node, 'mouseout', out),
				listen(card, 'mouseout', out)
			);
		};

		/**
		 * Alt+F10 (the editors' convention: TinyMCE, CKEditor, Google Docs):
		 * the focus moves to the shown bar's tab stop (a custom one's first
		 * focusable element); Escape there gives it back.
		 */
		const focusBar = () => {
			const host = edytor.overlay.layer?.querySelector('[data-edytor-toolbar-host]');
			const bar = host?.querySelector('[data-edytor-toolbar-bar]') ?? host;
			const target =
				bar?.querySelector<HTMLElement>('[tabindex="0"]') ??
				bar?.querySelector<HTMLElement>('button, input, select, [tabindex]:not([tabindex="-1"])');
			target?.focus({ preventScroll: true });
		};

		return {
			hotkeys: {
				// Mod+K: the link panel, its field focused (`link.mod-k`, Notion).
				'mod+k': ({ prevent }) => {
					if (!edytor.readonly && controller.openLinkPanel()) prevent();
				},
				'alt+f10': ({ prevent }) => {
					if (controller.isVisible) prevent(focusBar);
				}
			},
			onAfterOperation: () => {
				controller.updateFromSelection();
				edytor.overlay.invalidate();
			},
			onSelectionChange: (selection) => {
				controller.updateFromSelection(selection);
				edytor.overlay.invalidate();
			},
			onEdytorAttached: () => {
				const offs: (() => void)[] = [];
				// No press on the chrome takes focus, its background and a custom
				// snippet's markup included (not only its buttons): the editor keeps
				// its focus and its selection. A field (the link panel's input) takes
				// its own. Every press has a `mousedown`, WebKit's lone one too
				// (`onFocus.ts`), so no `pointerdown` is cancelled.
				const keep = (event: Event) => {
					if (!isNativeFieldEvent(event)) event.preventDefault();
				};
				/** Mount `snippet` in the overlay while `shown`, its host keeping the focus on a press. */
				const mount = (
					snippet: Snippet<[ToolbarController]> | undefined,
					shown: () => unknown,
					name: string,
					zIndex: number,
					measure: (host: HTMLElement) => (() => void) | void
				) => {
					offs.push(mountChrome(edytor, snippet, controller, shown, { name, zIndex, measure }));
					const host = snippet && edytor.overlay.layer?.querySelector(`[data-${name}]`);
					offs.push(listen(host, 'mousedown', keep));
					return host;
				};
				mount(
					options.toolbar,
					() => controller.isVisible,
					'edytor-toolbar-host',
					60,
					positionToolbar
				);
				const card = mount(
					options.card,
					() => controller.card,
					'edytor-link-card-host',
					61,
					positionCard
				);
				if (edytor.node && card) offs.push(trackLinks(edytor.node, card));
				offs.push(() => controller.hover(null));
				return () => {
					for (const off of offs.reverse()) off();
				};
			}
		};
	};
