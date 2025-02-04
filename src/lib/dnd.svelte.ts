import { triggerPostMoveFlash } from '@atlaskit/pragmatic-drag-and-drop-flourish/trigger-post-move-flash';
import * as liveRegion from '@atlaskit/pragmatic-drag-and-drop-live-region';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Block } from './block/block.svelte.js';
import {
	attachInstruction,
	extractInstruction,
	type Instruction
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item';

type DragState = {
	source: Block | null;
	target: Block | null;
	position: 'before' | 'after' | 'inside' | null;
};

type DnDOptions = {
	onDrop?: (source: Block, target: Block, position: 'before' | 'after' | 'inside') => void;
	canDrop?: (source: Block, target: Block) => boolean;
};

export class DnD {
	private state: DragState = {
		source: null,
		target: null,
		position: null
	};

	private options: DnDOptions;
	private uniqueContextId = Symbol('dnd-context');

	constructor(options: DnDOptions = {}) {
		this.options = options;
	}

	private calculateDropPosition(
		element: HTMLElement,
		mouseY: number
	): 'before' | 'after' | 'inside' {
		const rect = element.getBoundingClientRect();
		const relativeY = mouseY - rect.top;

		if (relativeY < rect.height * 0.25) {
			return 'before';
		} else if (relativeY > rect.height * 0.75) {
			return 'after';
		}
		return 'inside';
	}

	private updateDropIndicator(element: HTMLElement, position: 'before' | 'after' | 'inside') {
		// Remove existing indicators
		document.querySelectorAll('.drop-indicator').forEach((el) => {
			if (el instanceof HTMLElement) {
				el.remove();
			}
		});

		const indicator = document.createElement('div');
		indicator.className = 'drop-indicator';

		switch (position) {
			case 'before':
				indicator.style.cssText = `
          position: absolute;
          left: 0;
          right: 0;
          top: -2px;
          height: 4px;
          background: #0066ff;
        `;
				break;
			case 'after':
				indicator.style.cssText = `
          position: absolute;
          left: 0;
          right: 0;
          bottom: -2px;
          height: 4px;
          background: #0066ff;
        `;
				break;
			case 'inside':
				indicator.style.cssText = `
          position: absolute;
          left: 0;
          right: 0;
          top: 0;
          bottom: 0;
          border: 2px solid #0066ff;
          pointer-events: none;
        `;
				break;
		}

		element.appendChild(indicator);
	}

	// Svelte action that handles both dragging and dropping
	attach = (element: HTMLElement, block: Block) => {
		// Make element draggable
		element.draggable = true;

		const cleanup = combine(
			monitorForElements({
				canMonitor: (args) => {
					const data = args.source.data as { uniqueContextId?: symbol };
					return data.uniqueContextId === this.uniqueContextId;
				},
				onDragStart: (args) => {
					this.state.source = block;
					args.source.data = {
						uniqueContextId: this.uniqueContextId,
						id: block.id,
						type: 'block',
						block
					};
				},
				onDrop: (args) => {
					// didn't drop on anything
					if (!args.location.current.dropTargets.length) {
						return;
					}

					const target = args.location.current.dropTargets[0];
					const targetData = target.data as { block: Block };
					const targetBlock = targetData.block;
					const position = this.calculateDropPosition(
						target.element as HTMLElement,
						args.location.current.input.clientY
					);

					// Check if drop is allowed
					if (this.options.canDrop && !this.options.canDrop(this.state.source!, targetBlock)) {
						return;
					}

					this.options.onDrop?.(this.state.source!, targetBlock, position);
					triggerPostMoveFlash(target.element as HTMLElement);
					liveRegion.announce(`Moved ${block.type} ${position} ${targetBlock.type}`);

					// Reset state
					this.state = {
						source: null,
						target: null,
						position: null
					};
				}
			})
		);

		return {
			destroy() {
				cleanup();
				document.querySelectorAll('.drop-indicator').forEach((el) => {
					if (el instanceof HTMLElement) {
						el.remove();
					}
				});
			}
		};
	};
}
