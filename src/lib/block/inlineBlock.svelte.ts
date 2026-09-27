import type { Edytor } from '$lib/edytor.svelte.js';
import type { InlineBlockDefinition } from '$lib/plugins.js';
import { cloneJson, type JSONInlineBlock } from '$lib/utils/json.js';
import type { Block } from './block.svelte.js';
import { clearDomSelection } from '$lib/selection/domSelection.js';
import type { Text } from '$lib/text/text.svelte.js';

const INLINE_EDGE_CARET_THRESHOLD_PX = 4;
const isTextPart = (part: Block['content'][number] | undefined): part is Text =>
	part !== undefined && !(part instanceof InlineBlock);

/**
 * An id-only inline-atom handle (§2.4 "Handles", R4): atom `id`, shown in
 * block `blockId`. Getters read the document index; `node` is the element
 * that renders it (a Surface fact).
 */
export class InlineBlock {
	_def = 'inline' as const;
	readonly = false;
	readonly edytor: Edytor;
	readonly id: string;
	/** The block that shows the atom (the view updates it when the atom moves). */
	blockId: string;
	node: HTMLElement | undefined;
	private attachedNodes = new Set<HTMLElement>();

	constructor(edytor: Edytor, blockId: string, id: string) {
		this.edytor = edytor;
		this.blockId = blockId;
		this.id = id;
	}

	get parent(): Block {
		return this.edytor.idToBlock.block(this.blockId);
	}

	get #item() {
		const parts = this.edytor.idToBlock.parts(this.blockId);
		const part = parts.find((part) => part.kind === 'inline' && part.item.id === this.id);
		return part?.kind === 'inline' ? part.item : undefined;
	}

	get selected() {
		return this.edytor.selection.selectedInlineBlock.has(this);
	}

	get type(): string {
		return this.#item?.type ?? '';
	}

	get data(): Record<string, any> {
		return { ...this.#item?.data };
	}

	get definition(): InlineBlockDefinition {
		return this.edytor.inlineBlocks.get(this.type) ?? ({} as InlineBlockDefinition);
	}

	/** Position among the block's content parts. */
	get index(): number {
		return this.parent.content.indexOf(this);
	}

	/** Write the atom's `data` payload. */
	setData = (data: Record<string, unknown>): void => {
		this.parent.model?.setInlineData(this.id, cloneJson(data));
	};

	/** The atom is shown by a live block. */
	get isInDocument(): boolean {
		return this.parent.isInTree && this.#item !== undefined;
	}

	get value(): JSONInlineBlock {
		return { id: this.id, type: this.type, data: this.data };
	}

	attach = (node: HTMLElement) => {
		node.setAttribute('contenteditable', 'false');
		node.dataset.edytorId = this.id;
		node.dataset.edytorInlineBlock = this.type;
		this.attachedNodes.add(node);
		this.edytor.nodeToInlineBlock.set(node, this);
		this.node = node;
		const release = this.edytor.surface.register(node, 'atom', this.blockId);

		const selectInlineBlock = (event: PointerEvent) => {
			if (event.button !== 0) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			this.edytor.expectInternalFocus();
			this.edytor.node?.focus();
			const rect = node.getBoundingClientRect();
			const contentIndex = this.parent.content.indexOf(this);
			const previousPart = this.parent.content[contentIndex - 1];
			const nextPart = this.parent.content[contentIndex + 1];
			const isBeforeEdge = event.clientX <= rect.left + INLINE_EDGE_CARET_THRESHOLD_PX;
			const isAfterEdge = event.clientX >= rect.right - INLINE_EDGE_CARET_THRESHOLD_PX;
			let boundaryText: Text | null = null;
			let boundaryOffset = 0;

			if (isBeforeEdge && isTextPart(previousPart)) {
				boundaryText = previousPart;
				boundaryOffset = previousPart.length;
			}

			if (!boundaryText && isAfterEdge && isTextPart(nextPart)) {
				boundaryText = nextPart;
				boundaryOffset = 0;
			}

			if (boundaryText) {
				this.edytor.selection.setCollapsedStateAtTextOffset(boundaryText, boundaryOffset);
				void this.edytor.selection.setAtTextOffset(boundaryText, boundaryOffset);
				return;
			}

			this.edytor.selection.selectInlineBlock(this);
			clearDomSelection(this.edytor.node);
		};
		node.addEventListener('pointerdown', selectInlineBlock);

		return {
			destroy: () => {
				node.removeEventListener('pointerdown', selectInlineBlock);
				this.attachedNodes.delete(node);
				if (this.node === node) {
					this.node = this.attachedNodes.values().next().value;
				}
				this.edytor.nodeToInlineBlock.delete(node);
				release();
			}
		};
	};
}
