import type { Edytor } from '$lib/edytor.svelte.js';
import type { InlineBlockDefinition } from '$lib/plugins.js';
import { cloneJson, type JSONInlineBlock } from '$lib/utils/json.js';
import type { Block } from './block.svelte.js';
import { id } from '$lib/utils.js';
import { clearDomSelection } from '$lib/selection/domSelection.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { ContentItem } from '$lib/crdt/index.js';

const INLINE_EDGE_CARET_THRESHOLD_PX = 4;
const isTextPart = (part: Block['content'][number] | undefined): part is Text =>
	part !== undefined && !(part instanceof InlineBlock);

export class InlineBlock {
	_def = 'inline' as const;
	readonly = false;
	parent: Block;
	data = $state<any>({});
	id: string;
	#type = $state<string>('inline');
	index = $state(0);
	definition = $state<InlineBlockDefinition>({} as InlineBlockDefinition);
	edytor: Edytor;
	node: HTMLElement | undefined;
	private attachedNodes = new Set<HTMLElement>();

	/** True while this wrapper maps a live inline atom of its parent's content. */
	_live = false;
	/** Pending spec for detached wrappers (like v13's unintegrated `Y.Map`). */
	_spec: { type: string; data?: Record<string, unknown> } | null = null;

	get selected() {
		return this.edytor.selection.selectedInlineBlock.has(this);
	}

	get type() {
		return this.#type;
	}

	set type(value: string) {
		this.#type = value;
		if (this._spec) this._spec.type = value;
	}

	/**
	 * Write the inline atom's `data` payload — routed through the parent's
	 * typed node (`setInlineData`) when bound, else into the pending `_spec`
	 * (the detached-wrapper contract the old `yBlock.set('data')` had).
	 */
	setData = (data: Record<string, unknown>): void => {
		this.data = data;
		if (this._live && this.parent._bound === true && this.parent._blockId != null) {
			this.parent.model?.setInlineData(this.id, cloneJson(data));
		} else if (this._spec) {
			this._spec.data = data;
		}
	};

	/** True while this wrapper maps a live inline atom inside its parent's content. */
	get isInDocument(): boolean {
		return this._live && this.parent.content.includes(this);
	}

	get value(): JSONInlineBlock {
		return {
			id: this.id,
			type: this.#type,
			data: this.data
		};
	}

	/** Bind this wrapper to a live inline atom (reconcile/adoption path). */
	_bindRun = (run: ContentItem & { kind: 'inline' }) => {
		this._live = true;
		this.id = run.id;
		if (this.#type !== run.type) {
			this.#type = run.type;
			this.definition = this.edytor.getBlockDefinition('inline', run.type);
		}
		const nextData = run.data ?? {};
		if (JSON.stringify(this.data) !== JSON.stringify(nextData)) {
			this.data = nextData;
		}
	};

	/** Mark the wrapper dead — the atom it mirrored no longer exists. */
	_kill = () => {
		this._live = false;
		if (this.edytor.idToInlineBlock.get(this.id) === this) {
			this.edytor.idToInlineBlock.delete(this.id);
		}
		for (const node of this.attachedNodes) {
			this.edytor.nodeToInlineBlock.delete(node);
		}
	};

	constructor({
		parent,
		block,
		run
	}: {
		parent: Block;
	} & (
		| { run?: undefined; block: JSONInlineBlock }
		| { run: ContentItem & { kind: 'inline' }; block?: undefined }
	)) {
		this.parent = parent;
		this.edytor = parent.edytor;
		if (run !== undefined) {
			this.id = run.id;
			this.#type = run.type;
			this.data = run.data || {};
			this._live = true;
		} else {
			this.id = block.id ?? id('i');
			this.#type = block.type;
			this.data = block.data || {};
			this._spec = { type: this.#type, ...(block.data ? { data: block.data } : {}) };
		}
		this.definition = this.edytor.getBlockDefinition('inline', this.#type);
	}

	attach = (node: HTMLElement) => {
		node.contentEditable = 'false';
		node.dataset.edytorId = this.id;
		node.dataset.edytorInlineBlock = this.#type;
		this.attachedNodes.add(node);
		this.edytor.idToInlineBlock.set(this.id, this);
		this.edytor.nodeToInlineBlock.set(node, this);
		this.node = node;

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
				this.edytor.selection.ignoreNextSelectionChange = true;
				void this.edytor.selection.setAtTextOffset(boundaryText, boundaryOffset);
				return;
			}

			this.edytor.selection.selectInlineBlock(this);
			this.edytor.selection.ignoreNextSelectionChange = true;
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
				if (this.attachedNodes.size === 0 && this.edytor.idToInlineBlock.get(this.id) === this) {
					this.edytor.idToInlineBlock.delete(this.id);
				}
				this.edytor.nodeToInlineBlock.delete(node);
			}
		};
	};
}
