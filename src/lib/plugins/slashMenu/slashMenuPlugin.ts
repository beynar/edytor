import { mount, unmount } from 'svelte';

import type { Block } from '$lib/block/block.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { Text } from '$lib/text/text.svelte.js';
import SlashMenu from './SlashMenu.svelte';
import { SlashMenuController } from './SlashMenuController.svelte.js';

export const slashMenuPlugin: Plugin = (edytor) => {
	const controller = new SlashMenuController(edytor);
	let menuHost: HTMLDivElement | null = null;

	/** Beside the caret, kept in the viewport; run by the overlay's frame (R11). */
	const positionMenu = () => {
		const host = menuHost;
		const editor = edytor.node;
		if (!host || !editor || !controller.isOpen) return;
		const view = editor.ownerDocument.defaultView;
		if (!view) return;
		const selection = editor.ownerDocument.getSelection();
		let rect: DOMRect | undefined;
		if (selection?.rangeCount && editor.contains(selection.anchorNode)) {
			const range = selection.getRangeAt(0).cloneRange();
			range.collapse(false);
			if (typeof range.getBoundingClientRect === 'function') {
				rect = range.getBoundingClientRect();
			}
		}
		if (!rect || (!rect.width && !rect.height)) {
			rect = edytor.selection.state.startText?.node?.getBoundingClientRect();
		}
		if (!rect) rect = editor.getBoundingClientRect();
		const width = host.firstElementChild?.getBoundingClientRect().width || 310;
		const height = host.firstElementChild?.getBoundingClientRect().height || 350;
		host.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - width - 8))}px`;
		host.style.top = `${Math.max(8, rect.bottom + height + 8 < view.innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
	};

	const schedulePosition = () => edytor.overlay.invalidate();

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
				if (controller.isOpen && controller.commands.length) {
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
			schedulePosition();
		},
		onSelectionChange: () => {
			controller.reconcileSelection();
			schedulePosition();
		},
		onEdytorAttached: ({ node }) => {
			const host = node.ownerDocument.createElement('div');
			host.dataset.edytorSlashMenuHost = 'true';
			host.style.position = 'fixed';
			host.style.zIndex = '50';
			edytor.overlay.layer?.append(host);
			menuHost = host;

			const component = mount(SlashMenu, {
				target: host,
				props: { controller }
			});
			const off = edytor.overlay.add(() => positionMenu);

			return () => {
				off();
				menuHost = null;
				unmount(component);
				host.remove();
			};
		}
	};
};
