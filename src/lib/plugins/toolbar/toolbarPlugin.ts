import { mount, unmount } from 'svelte';

import type { Plugin } from '$lib/plugins.js';
import Toolbar from './Toolbar.svelte';
import { ToolbarController } from './ToolbarController.svelte.js';

export const toolbarPlugin: Plugin = (edytor) => {
	const controller = new ToolbarController(edytor);

	return {
		onAfterOperation: () => {
			controller.updateFromSelection();
		},
		onSelectionChange: (selection) => {
			controller.updateFromSelection(selection);
		},
		onEdytorAttached: ({ node }) => {
			const host = node.ownerDocument.createElement('div');
			host.dataset.edytorToolbarHost = 'true';
			host.style.position = 'relative';
			host.style.zIndex = '30';
			node.after(host);

			const component = mount(Toolbar, {
				target: host,
				props: { controller }
			});

			return () => {
				unmount(component);
				host.remove();
			};
		}
	};
};
