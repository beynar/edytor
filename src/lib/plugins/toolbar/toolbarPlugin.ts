import { mount, unmount } from 'svelte';

import type { Plugin } from '$lib/plugins.js';
import Toolbar from './Toolbar.svelte';
import { ToolbarController } from './ToolbarController.svelte.js';

export const toolbarPlugin: Plugin = (edytor) => {
	const controller = new ToolbarController(edytor);
	let toolbarHost: HTMLDivElement | null = null;
	let positionFrame = 0;

	const positionToolbar = () => {
		const host = toolbarHost;
		const editor = edytor.node;
		if (!host || !editor || !controller.isVisible) return;
		const view = editor.ownerDocument.defaultView;
		const selection = editor.ownerDocument.getSelection();
		if (!view || !selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
		const range = selection.getRangeAt(0);
		if (typeof range.getBoundingClientRect !== 'function') return;
		const rect = range.getBoundingClientRect();
		const toolbar = host.firstElementChild;
		const width = toolbar?.getBoundingClientRect().width || 460;
		const height = toolbar?.getBoundingClientRect().height || 40;
		host.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, view.innerWidth - width - 8))}px`;
		host.style.top = `${rect.top - height - 8 >= 8 ? rect.top - height - 8 : rect.bottom + 8}px`;
	};

	const schedulePosition = () => {
		const view = edytor.node?.ownerDocument.defaultView;
		if (!view || !toolbarHost) return;
		view.cancelAnimationFrame(positionFrame);
		positionFrame = view.requestAnimationFrame(positionToolbar);
	};

	return {
		onAfterOperation: () => {
			controller.updateFromSelection();
			schedulePosition();
		},
		onSelectionChange: (selection) => {
			controller.updateFromSelection(selection);
			schedulePosition();
		},
		onEdytorAttached: ({ node }) => {
			const host = node.ownerDocument.createElement('div');
			host.dataset.edytorToolbarHost = 'true';
			host.style.position = 'fixed';
			host.style.zIndex = '60';
			node.after(host);
			toolbarHost = host;

			const component = mount(Toolbar, {
				target: host,
				props: { controller }
			});
			const onViewportChange = () => schedulePosition();
			node.ownerDocument.addEventListener('scroll', onViewportChange, true);
			node.ownerDocument.defaultView?.addEventListener('resize', onViewportChange);
			schedulePosition();

			return () => {
				node.ownerDocument.defaultView?.cancelAnimationFrame(positionFrame);
				node.ownerDocument.removeEventListener('scroll', onViewportChange, true);
				node.ownerDocument.defaultView?.removeEventListener('resize', onViewportChange);
				toolbarHost = null;
				unmount(component);
				host.remove();
			};
		}
	};
};
