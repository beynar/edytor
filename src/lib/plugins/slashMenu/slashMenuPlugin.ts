import { mount, unmount } from 'svelte';

import type { Block } from '$lib/block/block.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { Text } from '$lib/text/text.svelte.js';
import SlashMenu from './SlashMenu.svelte';
import { SlashMenuController } from './SlashMenuController.svelte.js';

export const slashMenuPlugin: Plugin = (edytor) => {
	const controller = new SlashMenuController(edytor);

	return {
		hotkeys: {
			arrowdown: ({ prevent }) => {
				if (controller.moveSelection(1)) {
					prevent();
				}
			},
			arrowup: ({ prevent }) => {
				if (controller.moveSelection(-1)) {
					prevent();
				}
			},
			enter: ({ prevent }) => {
				if (controller.isOpen) {
					prevent(() => {
						void controller.runSelected();
					});
				}
			},
			escape: ({ prevent }) => {
				if (controller.isOpen) {
					prevent(() => {
						controller.close();
					});
				}
			}
		},
		onAfterOperation: (change) => {
			if (change.operation !== 'insertText' || !('text' in change)) {
				return;
			}

			controller.handleTextInsertion(
				change.text as Text,
				change.block as Block,
				change.payload as { value: string; start?: number; end?: number }
			);
		},
		onSelectionChange: () => {
			controller.reconcileSelection();
		},
		onEdytorAttached: ({ node }) => {
			const host = node.ownerDocument.createElement('div');
			host.dataset.edytorSlashMenuHost = 'true';
			host.style.position = 'relative';
			host.style.zIndex = '20';
			node.after(host);

			const component = mount(SlashMenu, {
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
