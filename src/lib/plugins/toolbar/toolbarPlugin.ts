import type { Snippet } from 'svelte';
import type { Plugin } from '$lib/plugins.js';
import Toolbar from './Toolbar.svelte';
import { ToolbarController } from './ToolbarController.svelte.js';

export type ToolbarOptions = {
	/**
	 * Replace the toolbar; it renders while `controller.isVisible`, placed
	 * above the selection (mark your bar `data-edytor-toolbar-bar` if panels
	 * hang below it). Buttons should `preventDefault` on mousedown to keep
	 * the selection.
	 */
	toolbar?: Snippet<[ToolbarController]>;
};

/** The selection toolbar, with your own markup through a `toolbar` snippet. */
export const createToolbarPlugin =
	(options: ToolbarOptions = {}): Plugin =>
	(edytor) => {
		const controller = new ToolbarController(edytor);

		/** Above the selection, kept in the viewport; run by the overlay's frame (R11). */
		const positionToolbar = (host: HTMLElement) => {
			const editor = edytor.node;
			if (!editor || !controller.isVisible) return;
			const view = editor.ownerDocument.defaultView;
			const selection = editor.ownerDocument.getSelection();
			if (!view || !selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
			const range = selection.getRangeAt(0);
			if (typeof range.getBoundingClientRect !== 'function') return;
			const rect = range.getBoundingClientRect();
			// The bar, not its open panel: panels drop over the text below it.
			const toolbar = host.querySelector('[data-edytor-toolbar-bar]') ?? host.firstElementChild;
			const width = toolbar?.getBoundingClientRect().width || 460;
			const height = toolbar?.getBoundingClientRect().height || 40;
			host.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, view.innerWidth - width - 8))}px`;
			host.style.top = `${rect.top - height - 8 >= 8 ? rect.top - height - 8 : rect.bottom + 8}px`;
		};

		const schedulePosition = () => edytor.overlay.invalidate();

		return {
			onAfterOperation: () => {
				controller.updateFromSelection();
				schedulePosition();
			},
			onSelectionChange: (selection) => {
				controller.updateFromSelection(selection);
				schedulePosition();
			},
			onEdytorAttached: () =>
				edytor.overlay.mount(
					Toolbar,
					{ controller, toolbar: options.toolbar },
					'edytor-toolbar-host',
					60,
					positionToolbar
				)
		};
	};

/** The Notion-style selection toolbar. */
export const toolbarPlugin = createToolbarPlugin();
