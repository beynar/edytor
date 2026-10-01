import type { Edytor } from '$lib/edytor.svelte.js';
import type { InlineBlockDefinition } from '$lib/plugins.js';
import type { JSONInlineBlock } from '$lib/utils/json.js';
import type { Block } from './block.svelte.js';
import { clearDomSelection } from '$lib/selection/domSelection.js';
import { propsProxy } from '$lib/session/props.js';
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

	#props?: Record<string, any>;
	/** The atom's `data` as a live proxy (`session/props.ts`): writes are its block's `patchData` commands. */
	get data(): Record<string, any> {
		return (this.#props ??= propsProxy(
			() => {
				this.edytor.cells?.get(this.blockId);
				return this.#item?.data ?? {};
			},
			(ops) => this.parent.patchData({ atom: this.id, ops })
		));
	}

	get definition(): InlineBlockDefinition {
		return this.edytor.inlineBlocks.get(this.type) ?? ({} as InlineBlockDefinition);
	}

	/** Position among the block's content parts. */
	get index(): number {
		return this.parent.content.indexOf(this);
	}

	/** Replace the atom's `data` — its block's `patchData` command (readonly, hooks). */
	setData = (data: Record<string, unknown>): void => {
		this.parent.patchData({ atom: this.id, ops: [{ path: [], value: data }] });
	};

	/** The atom is shown by a live block. */
	get isInDocument(): boolean {
		return this.parent.isInTree && this.#item !== undefined;
	}

	get value(): JSONInlineBlock {
		return { id: this.id, type: this.type, data: { ...this.#item?.data } };
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
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			this.edytor.expectInternalFocus();
			this.edytor.node?.focus();
			// A press on the atom's edge places the caret beside it; elsewhere it selects the atom.
			const rect = node.getBoundingClientRect();
			const { content } = this.parent;
			const index = content.indexOf(this);
			const [before, after] = [content[index - 1], content[index + 1]];
			const { selection } = this.edytor;
			if (event.clientX <= rect.left + INLINE_EDGE_CARET_THRESHOLD_PX && isTextPart(before))
				return selection.setAtTextOffset(before, before.length);
			if (event.clientX >= rect.right - INLINE_EDGE_CARET_THRESHOLD_PX && isTextPart(after))
				return selection.setAtTextOffset(after, 0);
			selection.selectInlineBlock(this);
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
