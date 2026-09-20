import { Text } from '../text/text.svelte.js';
import { Edytor } from '../edytor.svelte.js';
import { cloneJson, type JSONBlock, type JSONText, type JSONInlineBlock } from '$lib/utils/json.js';
import {
	batch,
	removeInlineBlock,
	addChildBlock,
	insertBlockAfter,
	insertBlockBefore,
	pushContentIntoBlock,
	mergeBlockBackward,
	mergeBlockForward,
	nestBlock,
	removeBlock,
	setBlock,
	splitBlock,
	addChildBlocks,
	unNestBlock,
	moveBlock,
	normalizeContent,
	groupContent,
	addInlineBlock,
	acceptSuggestedText,
	suggestText,
	deleteContentAtRange,
	normalizeChildren
} from './block.utils.js';
import { id } from '$lib/utils.js';
import type { BlockDefinition } from '$lib/plugins.js';
import { climb } from '$lib/selection/selection.utils.js';
import { InlineBlock } from './inlineBlock.svelte.js';
import { createReadonlyText } from '$lib/components/readonlyElements.svelte.js';
import { createReadonlyInlineBlock } from '$lib/components/readonlyElements.svelte.js';
import type { BlockSpec, ContentItem, ProjectedBlock } from '$lib/crdt/index.js';
import type { YArrayLike, YBlockLike, YTextLike } from '$lib/crdt/compat.js';
import type { TextRunItem } from '../text/text.svelte.js';

/**
 * A logical content part derived from a block's flat content items:
 * text runs group into segments split by inline atoms, with synthesized empty
 * text segments between adjacent inlines and at the edges — the mirror form
 * of the baseline content invariants (starts/ends with Text, no adjacent
 * same-kind parts).
 */
export type DerivedContentPart =
	| { kind: 'text'; segOrd: number; items: TextRunItem[] }
	| { kind: 'inline'; item: ContentItem & { kind: 'inline' } };

export const deriveContentParts = (items: readonly ContentItem[]): DerivedContentPart[] => {
	const parts: DerivedContentPart[] = [];
	let segOrd = 0;
	let pending: TextRunItem[] = [];
	const flushText = () => {
		parts.push({ kind: 'text', segOrd: segOrd++, items: pending });
		pending = [];
	};
	for (const item of items) {
		if (item.kind === 'text') {
			pending.push({ text: item.text, ...(item.marks ? { marks: item.marks } : {}) });
		} else {
			flushText();
			parts.push({ kind: 'inline', item });
		}
	}
	flushText();
	return parts;
};

const displayLenOfPart = (part: DerivedContentPart): number =>
	part.kind === 'text' ? part.items.reduce((n, i) => n + i.text.length, 0) : 1;

/** JSONBlock → facade insert spec (ids assigned where missing). */
export const jsonBlockToSpec = (block: JSONBlock, freshIds = false): BlockSpec => ({
	id: freshIds || !block.id ? id('b') : block.id,
	type: block.type,
	...(block.data ? { data: cloneJson(block.data) as Record<string, unknown> } : {}),
	...(block.content
		? {
				content: block.content.map((part): ContentItem => {
					if ('type' in part) {
						return {
							kind: 'inline',
							id: freshIds || !part.id ? id('i') : part.id,
							type: part.type,
							...(part.data ? { data: cloneJson(part.data) } : {})
						};
					}
					return {
						kind: 'text',
						text: part.text,
						...(part.marks ? { marks: cloneJson(part.marks) } : {})
					};
				})
			}
		: {}),
	...(block.children ? { children: block.children.map((c) => jsonBlockToSpec(c, freshIds)) } : {})
});

export class Block {
	readonly = false;
	edytor: Edytor;
	yBlock: YBlockLike;
	parent?: Block;
	yChildren: YArrayLike<YBlockLike>;
	children = $state<Block[]>([]);
	yContent: YArrayLike<YTextLike | YBlockLike>;
	content = $state<(Text | InlineBlock)[]>([]);
	id = $state<string>(id('b'));
	renderVersion = $state(0);
	data = $state<Record<string, any>>({});
	node?: HTMLElement;
	definition = $state<BlockDefinition>({} as BlockDefinition);

	/**
	 * Facade block id — `null` for the root block, `undefined` while the
	 * wrapper is a detached spec (`new Block({block})` before insertion).
	 */
	_blockId: string | null | undefined = undefined;
	/** True once bound to a facade block (or the root). */
	_bound = false;
	/** True while the block is visible in the projected tree. */
	_live = false;
	/** Pending wrapper adoptions by content part index (yContent.insert). */
	_pendingParts = new Map<number, Text | InlineBlock>();

	get selected() {
		return this.edytor.selection.selectedBlocks.has(this) || this.edytor.selection.hasSelectedAll;
	}
	get focused() {
		return this.edytor.selection.focusedBlocks.has(this) && !this.selected;
	}

	get insideIsland(): boolean {
		let insideIslands = false;
		climb(this.parent, (block) => {
			if (block.definition?.island) {
				insideIslands = true;
				return true;
			}
		});
		return insideIslands;
	}

	get firstEditableText(): Text | undefined {
		if (this.content.length && this.content.some((part) => part instanceof Text && part.node)) {
			return this.content.find((part) => part instanceof Text) as Text;
		}
		return this.children.at(0)?.firstEditableText;
	}

	get lastEditableText(): Text | undefined {
		if (this.content.length && this.content.some((part) => part instanceof Text && part.node)) {
			return this.content.findLast((part) => part instanceof Text) as Text;
		}
		return this.children.at(-1)?.lastEditableText;
	}

	#index = $state<number | null>(null);

	get index(): number {
		if (!this.parent) {
			return 0;
		}
		if (this.#index === null) {
			return this.parent.children.indexOf(this);
		}
		return this.#index;
	}

	set index(value: number) {
		this.#index = value;
	}

	#type = $state<string>('paragraph');
	get type() {
		return this.#type;
	}
	set type(value: string) {
		this.yBlock.set('type', value);
	}

	#depth = $state<number | null>(null);
	get depth(): number {
		if (!this.parent) {
			return 0;
		}
		if (this.#depth === null) {
			return this.parent.depth + 1;
		}
		return this.#depth;
	}

	get path(): number[] {
		const start = [this.index];
		let current = this.parent;
		while (current instanceof Block && current.parent) {
			start.push(current.index);
			current = current.parent;
		}

		return start.toReversed();
	}

	get isRoot(): boolean {
		return this === this.edytor.root;
	}

	get isInTree(): boolean {
		return this._live;
	}

	#suggestions = $state<(JSONText[] | JSONInlineBlock)[] | null>(null);

	get suggestions(): (Text | InlineBlock)[] | null {
		if (!this.#suggestions) {
			return null;
		}
		return this.#suggestions.map((suggestion) => {
			if ('type' in suggestion) {
				return createReadonlyInlineBlock({
					block: suggestion,
					edytor: this.edytor,
					parent: this
				});
			} else {
				return createReadonlyText({
					value: suggestion,
					parent: this,
					edytor: this.edytor
				}) as Text;
			}
		});
	}

	set suggestions(value: (JSONText[] | JSONInlineBlock)[] | null) {
		this.#suggestions = value;
	}

	get rawSuggestions(): (JSONText[] | JSONInlineBlock)[] | null {
		return this.#suggestions;
	}

	get nextBlock(): Block | null {
		if (!this.parent) {
			return null;
		}
		return this.parent.children[this.index + 1];
	}

	get previousBlock(): Block | null {
		if (!this.parent) {
			return null;
		}
		return this.parent.children[this.index - 1];
	}

	get closestPreviousBlock(): Block | null {
		const previousBlock = this.previousBlock;
		if (this.index === 0) {
			return this.parent instanceof Block && !this.parent.isRoot ? this.parent : null;
		} else if (previousBlock) {
			if (previousBlock?.children.length > 0) {
				let closestPreviousBlock = previousBlock.children.at(-1) || null;
				while (closestPreviousBlock && closestPreviousBlock?.children.length > 0) {
					closestPreviousBlock = closestPreviousBlock.children.at(-1) || null;
				}
				return closestPreviousBlock || null;
			} else {
				return this.previousBlock;
			}
		}
		return null;
	}

	get closestNextBlock(): Block | null {
		if (this.hasChildren) {
			return this.children.at(0) || null;
		}
		if (this.nextBlock || this.definition.island || this.definition.void) {
			return this.nextBlock;
		} else {
			if (this.parent instanceof Block) {
				let parent = this.parent;
				let nextBlock = parent.nextBlock;
				while (!nextBlock && parent instanceof Block) {
					if (parent.parent instanceof Block) {
						parent = parent.parent;
						nextBlock = parent.nextBlock;
					} else {
						return null;
					}
				}
				return nextBlock;
			} else {
				return null;
			}
		}
	}

	get deepestChild(): Block {
		if (this.children.length) {
			return this.children.at(-1)!.deepestChild;
		}
		return this;
	}

	get hasChildren(): boolean {
		return this.children.length > 0;
	}

	get hasContent(): boolean {
		return (
			this.content.length > 0 && this.content.some((part) => part instanceof Text && !part.isEmpty)
		);
	}

	get isEmpty(): boolean {
		return !this.hasContent && !this.hasChildren;
	}

	get isNested(): boolean {
		return (this.parent && this.parent.type !== 'root') || false;
	}

	get value(): JSONBlock {
		const children = this.children.map((child) => child.value);
		const content = this.content.map((part) => part.value).flat();
		const value: JSONBlock = {
			type: this.type,
			id: this.id,
			children,
			content
		};
		if (Object.keys(this.data).length > 0) {
			value.data = this.data;
		} else {
			value.data = {};
		}
		if (!children.length) {
			delete value.children;
		}
		if (!content.length) {
			delete value.content;
		}
		return value;
	}

	isChildOf(block: Block): boolean {
		let parent = this.parent;
		while (parent) {
			if (parent === block) {
				return true;
			}
			parent = parent.parent;
		}
		return false;
	}

	get firstText(): Text {
		if (this.content.length) {
			return this.content.find((part) => part instanceof Text)!;
		}
		return this.children.at(0)?.firstText!;
	}

	get lastText(): Text {
		if (this.content.length) {
			return this.content.findLast((part) => part instanceof Text)!;
		}
		return this.children.at(0)!.lastText!;
	}

	private batch = batch.bind(this);
	addChildBlock = this.batch('addChildBlock', addChildBlock.bind(this));
	addChildBlocks = this.batch('addChildBlocks', addChildBlocks.bind(this));
	insertBlockAfter = this.batch('insertBlockAfter', insertBlockAfter.bind(this));
	insertBlockBefore = this.batch('insertBlockBefore', insertBlockBefore.bind(this));
	splitBlock = this.batch('splitBlock', splitBlock.bind(this));
	removeBlock = this.batch('removeBlock', removeBlock.bind(this));
	unNestBlock = this.batch('unNestBlock', unNestBlock.bind(this));
	mergeBlockBackward = this.batch('mergeBlockBackward', mergeBlockBackward.bind(this));
	mergeBlockForward = this.batch('mergeBlockForward', mergeBlockForward.bind(this));
	nestBlock = this.batch('nestBlock', nestBlock.bind(this));
	setBlock = this.batch('setBlock', setBlock.bind(this));
	moveBlock = this.batch('moveBlock', moveBlock.bind(this));
	pushContentIntoBlock = this.batch('pushContentIntoBlock', pushContentIntoBlock.bind(this));
	removeInlineBlock = this.batch('removeInlineBlock', removeInlineBlock.bind(this));
	addInlineBlock = this.batch('addInlineBlock', addInlineBlock.bind(this));
	normalizeContent = this.batch('normalizeContent', normalizeContent.bind(this));
	normalizeChildren = this.batch('normalizeChildren', normalizeChildren.bind(this));
	suggestText = this.batch('suggestText', suggestText.bind(this));
	acceptSuggestedText = this.batch('acceptSuggestedText', acceptSuggestedText.bind(this));
	deleteContentAtRange = this.batch('deleteContentAtRange', deleteContentAtRange.bind(this));

	void = (node: HTMLElement) => {
		node.setAttribute('data-edytor-void', `true`);
		node.style.userSelect = 'none';
		node.contentEditable = 'false';
	};

	constructor({
		parent,
		block,
		blockId,
		projected,
		edytor
	}: {
		parent?: Block;
		edytor: Edytor;
	} & (
		| { block: JSONBlock; blockId?: undefined; projected?: undefined }
		| { blockId: string | null; block?: undefined; projected?: ProjectedBlock }
	)) {
		this.parent = parent;
		this.edytor = edytor;
		this.yBlock = this.createBlockAdapter();
		this.yChildren = this.createChildrenAdapter();
		this.yContent = this.createContentAdapter();

		if (block !== undefined) {
			if (block.type === 'root') {
				// Bound root wrapper — children reconcile from the projected tree.
				this._blockId = null;
				this._bound = true;
				this._live = true;
				this.id = 'root';
				this.#type = 'root';
				this.data = block.data || {};
				this.children = (block.children || []).map((child, index) => {
					const childBlock = new Block({ parent: this, edytor, block: child });
					childBlock.index = index;
					return childBlock;
				});
			} else {
				// Detached spec mode — fields populate the pending spec used by
				// `yChildren.insert`/`insertBlock`; no facade calls until bound.
				this._bound = false;
				this._live = false;
				this.id = block.id ?? id('b');
				this.#type = block.type;
				this.data = block.data || {};
				this.children = (block.children || []).map((child, index) => {
					const childBlock = new Block({ parent: this, edytor, block: child });
					childBlock.index = index;
					return childBlock;
				});
				const groupedContent = groupContent(block.content);
				if (!groupedContent.length) {
					groupedContent.push([{ text: '' }]);
				}
				this.content = groupedContent.map((part, index) => {
					const isInlineBlock = 'type' in part;
					if (isInlineBlock) {
						const inlineBlock = new InlineBlock({ parent: this, block: part });
						inlineBlock.index = index;
						return inlineBlock;
					} else {
						const text = new Text({ parent: this, content: part });
						text.index = index;
						return text;
					}
				});
			}
		} else {
			// Bound mode — `projected` populates immediately when available.
			this._blockId = blockId;
			this._bound = true;
			this._live = true;
			this.id = blockId ?? 'root';
			if (blockId === null) {
				this.#type = 'root';
			}
			if (projected) {
				this.#type = projected.type;
				this.data = projected.data || {};
				this.reconcileChildren(projected.children);
				this.reconcileContent(projected.content);
			}
		}
		this.definition = this.edytor.getBlockDefinition('block', this.#type);
		this.edytor.idToBlock.set(this.id, this);
	}

	// ── facade binding ──────────────────────────────────────────────────

	private get facade() {
		return this.edytor.facade!;
	}

	/** Adopt a projected node — refresh meta, children and content (mirror reconcile). */
	_reconcile = (node: ProjectedBlock) => {
		if (this.#type !== node.type) {
			this.#type = node.type;
			this.definition = this.edytor.getBlockDefinition('block', node.type);
			this.renderVersion += 1;
		}
		const nextData = node.data ?? {};
		if (JSON.stringify(this.data) !== JSON.stringify(nextData)) {
			this.data = nextData;
		}
		this.reconcileChildren(node.children);
		this.reconcileContent(node.content);
	};

	/** Rebuild `children` from projected child nodes, reusing wrappers by id. */
	reconcileChildren = (projectedChildren: ProjectedBlock[]) => {
		const prev = this.children;
		const used = new Set<Block>();
		const next = projectedChildren.map((node, index) => {
			let child = this.edytor.idToBlock.get(node.id);
			const pending = this.edytor._pendingBlocks.get(node.id);
			this.edytor._pendingBlocks.delete(node.id);
			if (!child && pending) {
				// Detached spec wrapper adoption — bind it to the new block id.
				child = pending;
			}
			if (!child) {
				child = new Block({ parent: this, edytor: this.edytor, blockId: node.id });
			}
			child._bind(node.id, this);
			child.parent = this;
			child.index = index;
			used.add(child);
			child._reconcile(node);
			return child;
		});
		for (const old of prev) {
			if (!used.has(old) && !this.edytor.isVisibleBlockId(old.id)) {
				old._drop();
			}
		}
		this.children = next;
	};

	/** Rebuild `content` from projected items, reusing wrappers by segment/atom. */
	reconcileContent = (items: readonly ContentItem[]) => {
		const parts = deriveContentParts(items);
		const prev = this.content;
		const used = new Set<Text | InlineBlock>();
		const byItem = new Map<unknown, Text | InlineBlock>();
		const bySegOrd = new Map<number, Text>();
		for (const part of prev) {
			if (part instanceof Text) {
				bySegOrd.set(part._segOrd, part);
				for (const item of part._items) {
					byItem.set(item, part);
				}
			} else {
				byItem.set(part, part);
			}
		}

		const next: (Text | InlineBlock)[] = [];
		for (let partIndex = 0; partIndex < parts.length; partIndex++) {
			const part = parts[partIndex];
			if (part.kind === 'inline') {
				let wrapper =
					this._pendingParts.get(partIndex) instanceof InlineBlock
						? (this._pendingParts.get(partIndex) as InlineBlock)
						: undefined;
				if (!wrapper) {
					// Reuse by atom id — inline ids are stable.
					wrapper =
						prev.find((p): p is InlineBlock => p instanceof InlineBlock && p.id === part.item.id) ??
						undefined;
				}
				if (!wrapper) {
					wrapper = new InlineBlock({ parent: this, run: part.item });
				}
				wrapper._bindRun(part.item);
				wrapper.parent = this;
				wrapper.index = partIndex;
				used.add(wrapper);
				next.push(wrapper);
				this._pendingParts.delete(partIndex);
			} else {
				const pending =
					this._pendingParts.get(partIndex) instanceof Text
						? (this._pendingParts.get(partIndex) as Text)
						: undefined;
				const byItems = part.items
					.map((item) => byItem.get(item))
					.find((w): w is Text => w instanceof Text && !used.has(w));
				const wrapper =
					pending ??
					byItems ??
					bySegOrd.get(part.segOrd) ??
					new Text({ parent: this, content: '' });
				wrapper._bind(part.segOrd, part.items);
				wrapper.parent = this;
				wrapper.index = partIndex;
				used.add(wrapper);
				next.push(wrapper);
				this._pendingParts.delete(partIndex);
				if (this._pendingParts.get(partIndex + 1) === wrapper) {
					this._pendingParts.delete(partIndex + 1);
				}
			}
		}

		// Second pass — leftover pending wrappers (carriers from `yContent.insert`
		// whose atoms did not land on a fresh part slot):
		// - Inline carriers keep their identity: if the atom exists at a shifted
		//   index, the pending wrapper claims it (callers hold a reference to it);
		//   if the atom never materialized, the carrier is dropped.
		// - Text carriers are fungible: when their atoms merged into a segment
		//   already owned by a live wrapper, the live wrapper keeps the slot
		//   (v13 merged adjacent pushed Y.Texts the same way). The carrier is
		//   retired and its id is aliased to the owner so `getTextById` resolves.
		for (const [idx, wrapper] of this._pendingParts) {
			if (wrapper instanceof InlineBlock) {
				const targetIndex = next.findIndex(
					(w, k) =>
						w instanceof InlineBlock &&
						parts[k]?.kind === 'inline' &&
						(parts[k] as Extract<DerivedContentPart, { kind: 'inline' }>).item.id === wrapper.id
				);
				if (targetIndex !== -1) {
					const part = parts[targetIndex] as Extract<DerivedContentPart, { kind: 'inline' }>;
					const old = next[targetIndex];
					wrapper._bindRun(part.item);
					wrapper.parent = this;
					wrapper.index = targetIndex;
					next[targetIndex] = wrapper;
					used.add(wrapper);
					if (old !== wrapper) {
						used.delete(old);
						old._kill();
					}
				} else {
					wrapper._kill();
				}
				continue;
			}
			const sameKind = (k: number) =>
				k >= 0 && k < next.length && next[k] instanceof Text && parts[k]?.kind === 'text';
			const targetIndex = [idx, idx - 1, idx + 1].find(sameKind);
			const old = targetIndex === undefined ? undefined : next[targetIndex];
			if (old === wrapper) {
				used.add(wrapper);
				continue;
			}
			const pendingId = wrapper.id;
			wrapper._kill();
			if (old instanceof Text) {
				this.edytor.idToText.set(pendingId, old);
			}
		}
		this._pendingParts.clear();

		for (const old of prev) {
			if (!used.has(old)) {
				old._kill();
			}
		}
		this.content = next;
	};

	/** Detached spec → facade BlockSpec (used by `yChildren.insert`). */
	_toSpec = (): BlockSpec => ({
		id: this.id,
		type: this.#type,
		...(Object.keys(this.data).length ? { data: cloneJson(this.data) } : {}),
		...(this.content.length
			? {
					content: this.content.flatMap((part): ContentItem[] => {
						if (part instanceof Text) {
							return part._items.map((item) => ({
								kind: 'text' as const,
								text: item.text,
								...(item.marks ? { marks: { ...item.marks } } : {})
							}));
						}
						return [
							{
								kind: 'inline' as const,
								id: part.id,
								type: part.type,
								...(part.data ? { data: cloneJson(part.data) } : {})
							}
						];
					})
				}
			: {}),
		...(this.children.length ? { children: this.children.map((c) => c._toSpec()) } : {})
	});

	/** Mark this wrapper (and subtree) dead — no longer visible in the tree. */
	_drop = () => {
		this._live = false;
		if (this.edytor.idToBlock.get(this.id) === this) {
			this.edytor.idToBlock.delete(this.id);
		}
		for (const child of this.children) {
			child._drop();
		}
		for (const part of this.content) {
			part._kill();
		}
		if (this.node) {
			this.node = undefined;
		}
	};

	/** Bind a (possibly detached) wrapper to a live facade block id. */
	_bind = (blockId: string | null, parent?: Block) => {
		if (this._bound && this._blockId === blockId) {
			this._live = true;
			if (parent) this.parent = parent;
			return;
		}
		const oldId = this.id;
		this._blockId = blockId;
		this._bound = true;
		this._live = true;
		this.id = blockId ?? 'root';
		if (oldId !== this.id) {
			if (this.edytor.idToBlock.get(oldId) === this) {
				this.edytor.idToBlock.delete(oldId);
			}
			this.edytor.idToBlock.set(this.id, this);
		}
		if (parent) this.parent = parent;
	};

	/** Content parts derived from the CURRENT doc state (mid-transaction safe). */
	projectedParts = (): DerivedContentPart[] | null => {
		if (!this._bound || this._blockId == null || this._blockId === undefined) {
			return null;
		}
		const node = this.edytor.projectedBlock(this._blockId);
		return node ? deriveContentParts(node.content) : null;
	};

	deriveContentParts = deriveContentParts;

	/** Display offset (atoms) of a content part inside this block. */
	partOffsetOf = (part: Text | InlineBlock): number => {
		const parts = this.projectedParts();
		if (parts) {
			// Match by live part identity — `segOrd` for text segments, atom id
			// for inlines. The `content` mirror may be stale mid-transaction,
			// so `content.indexOf` is only a fallback.
			const index = parts.findIndex((p) =>
				part instanceof Text
					? p.kind === 'text' && p.segOrd === part._segOrd
					: p.kind === 'inline' && p.item.id === part.id
			);
			if (index !== -1) {
				let off = 0;
				for (let i = 0; i < index; i++) {
					off += displayLenOfPart(parts[i]);
				}
				return off;
			}
			const mirrorIndex = this.content.indexOf(part);
			if (mirrorIndex !== -1 && mirrorIndex < parts.length) {
				let off = 0;
				for (let i = 0; i < mirrorIndex; i++) {
					off += displayLenOfPart(parts[i]);
				}
				return off;
			}
		}
		let off = 0;
		for (const p of this.content) {
			if (p === part) return off;
			off += p instanceof Text ? p.length : 1;
		}
		return off;
	};

	/** Display length of the block's content in atoms. */
	displayLength = (): number => {
		if (this._bound && this._blockId != null) {
			const parts = this.projectedParts();
			if (parts) {
				return parts.reduce((n, p) => n + displayLenOfPart(p), 0);
			}
		}
		return this.content.reduce((n, p) => n + (p instanceof Text ? p.length : 1), 0);
	};

	/** Atom offset corresponding to content part index `i` in current doc state. */
	atomOffsetOfPartIndex = (i: number): number => {
		const parts = this.projectedParts();
		if (parts) {
			let off = 0;
			for (let k = 0; k < i && k < parts.length; k++) {
				off += displayLenOfPart(parts[k]);
			}
			return off;
		}
		let off = 0;
		for (let k = 0; k < i && k < this.content.length; k++) {
			const p = this.content[k];
			off += p instanceof Text ? p.length : 1;
		}
		return off;
	};

	// ── compat adapters ─────────────────────────────────────────────────

	private createBlockAdapter = (): YBlockLike => {
		// Adapter getters/method shorthand rebind `this` to the adapter
		// object, so the wrapper instance is captured explicitly.
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		const adapter: YBlockLike & { __compatKind: 'block'; __owner: Block } = {
			__compatKind: 'block',
			__owner: self,
			get: (key: string) => {
				if (key === 'id') return self.id;
				if (key === 'type') return self.#type;
				if (key === 'data') return self.data;
				if (key === 'children') return self.yChildren;
				if (key === 'content') return self.yContent;
				return undefined;
			},
			set: (key: string, value: unknown) => {
				if (key === 'type') {
					const type = value as string;
					if (self._bound && self._blockId != null) {
						self.facade.setBlockType(self._blockId, type);
					}
					self.#type = type;
					self.definition = self.edytor.getBlockDefinition('block', type);
					self.renderVersion += 1;
					return;
				}
				if (key === 'data') {
					self.data = (value ?? {}) as Record<string, unknown>;
					if (self._bound && self._blockId != null) {
						self.facade.setBlockData(self._blockId, cloneJson(self.data));
					}
					return;
				}
				if (key === 'id') {
					self.id = value as string;
				}
			},
			get _item() {
				return { id: null, deleted: self._bound ? !self._live : false };
			},
			get doc() {
				return self._bound ? self.edytor.doc : null;
			}
		};
		return adapter;
	};

	private createChildrenAdapter = (): YArrayLike<YBlockLike> => {
		// Adapter getters/method shorthand rebind `this` to the adapter
		// object, so the wrapper instance is captured explicitly.
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		const insert = (index: number, items: YBlockLike[]) => {
			if (!self._bound) {
				const wrappers = items.map((item) => (item as YBlockLike & { __owner: Block }).__owner);
				wrappers.forEach((w, k) => {
					w.parent = self;
					self.children.splice(index + k, 0, w);
				});
				self.children.forEach((c, k) => (c.index = k));
				return;
			}
			let i = index;
			for (const item of items) {
				const wrapper = (item as YBlockLike & { __owner: Block }).__owner;
				if (wrapper._bound && wrapper._blockId != null) {
					self.facade.moveBlock(wrapper._blockId, { parent: self._blockId ?? null, index: i });
				} else {
					const spec = wrapper._toSpec();
					if (self.facade.insertBlock({ parent: self._blockId ?? null, index: i }, spec)) {
						self.edytor._pendingBlocks.set(spec.id, wrapper);
					}
				}
				i++;
			}
			self.edytor.flushMirror();
		};
		const adapter: YArrayLike<YBlockLike> = {
			get length() {
				return self.children.length;
			},
			get: (index: number) => self.children[index]?.yBlock as YBlockLike,
			insert: (index: number, items: YBlockLike[]) => insert(index, items),
			push: (items: YBlockLike[]) => insert(self.children.length, items),
			delete: (index: number, length = 1) => {
				if (!self._bound) {
					self.children.splice(index, length);
					self.children.forEach((c, k) => (c.index = k));
					return;
				}
				const ids = self.facade.childrenIds(self._blockId ?? null);
				for (let k = index + length - 1; k >= index; k--) {
					const target = ids[k];
					if (target !== undefined) {
						self.facade.deleteBlock(target);
					}
				}
				self.edytor.flushMirror();
			},
			toArray: () => self.children.map((c) => c.yBlock as YBlockLike),
			map: (fn) => self.children.map((c, i) => fn(c.yBlock as YBlockLike, i)),
			observe: () => {},
			unobserve: () => {}
		};
		return adapter;
	};

	private createContentAdapter = (): YArrayLike<YTextLike | YBlockLike> => {
		// Adapter getters/method shorthand rebind `this` to the adapter
		// object, so the wrapper instance is captured explicitly.
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		const insert = (index: number, items: (YTextLike | YBlockLike)[]) => {
			if (!self._bound) {
				const wrappers = items.map(
					(item) => (item as (YTextLike | YBlockLike) & { __owner: Text | InlineBlock }).__owner
				);
				wrappers.forEach((w, k) => {
					w.parent = self;
					self.content.splice(index + k, 0, w);
				});
				self.content.forEach((c, k) => (c.index = k));
				return;
			}
			const blockId = self._blockId as string;
			let partIndex = index;
			let offset = self.atomOffsetOfPartIndex(partIndex);
			for (const item of items) {
				const handle = item as (YTextLike | YBlockLike) & {
					__compatKind: 'text' | 'inline' | 'block';
					__owner: Text | InlineBlock | Block;
				};
				if (handle.__compatKind === 'text') {
					const text = handle.__owner as Text;
					for (const run of text._items) {
						if (run.text.length) {
							self.facade.insertText(blockId, offset, run.text, run.marks);
							offset += run.text.length;
						}
					}
					self._pendingParts.set(partIndex, text);
				} else if (handle.__compatKind === 'inline') {
					const inline = handle.__owner as InlineBlock;
					const spec = inline._spec ?? { type: inline.type, data: inline.data };
					self.facade.insertInline(blockId, offset, {
						id: inline.id,
						type: spec.type,
						...(spec.data ? { data: cloneJson(spec.data) } : {})
					});
					offset += 1;
					self._pendingParts.set(partIndex, inline);
				}
				partIndex++;
			}
			self.edytor.flushMirror();
		};
		const adapter: YArrayLike<YTextLike | YBlockLike> = {
			get length() {
				return self.content.length;
			},
			get: (index: number) =>
				(self.content[index] instanceof Text
					? (self.content[index] as Text).yText
					: (self.content[index] as InlineBlock)?.yBlock) as YTextLike | YBlockLike,
			insert: (index: number, items: (YTextLike | YBlockLike)[]) => insert(index, items),
			push: (items: (YTextLike | YBlockLike)[]) => insert(self.content.length, items),
			delete: (index: number, length = 1) => {
				if (!self._bound) {
					self.content.splice(index, length);
					self.content.forEach((c, k) => (c.index = k));
					return;
				}
				const blockId = self._blockId as string;
				const parts = self.projectedParts() ?? [];
				for (let k = index + length - 1; k >= index; k--) {
					const part = parts[k];
					if (!part) continue;
					if (part.kind === 'text') {
						const segStart = self.atomOffsetOfPartIndex(k);
						const segLen = part.items.reduce((n, i) => n + i.text.length, 0);
						if (segLen > 0) {
							self.facade.deleteText(blockId, segStart, segLen);
						}
					} else {
						self.facade.removeInline(blockId, part.item.id);
					}
				}
				self.edytor.flushMirror();
			},
			toArray: () =>
				self.content.map((p) =>
					p instanceof Text ? (p.yText as YTextLike) : (p.yBlock as YBlockLike)
				),
			map: (fn) =>
				self.content.map((p, i) =>
					fn(p instanceof Text ? (p.yText as YTextLike) : (p.yBlock as YBlockLike), i)
				),
			observe: () => {},
			unobserve: () => {}
		};
		return adapter;
	};

	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.idToBlock.set(this.id, this);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-block', `true`);
		node.setAttribute('data-edytor-type', `${this.#type}`);

		const onDestroy = this.edytor.plugins.reduce(
			(acc, plugin) => {
				const action = plugin.onBlockAttached?.({ node, block: this });
				action && acc.push(action);
				return acc;
			},
			[] as (() => void)[]
		);
		if (this.definition.void) {
			this.void(node);
		}

		const observeEmptyTextNodes = () => {
			const treeWalker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
				acceptNode: (node) => {
					if (
						node.parentElement === node &&
						node.textContent &&
						node.textContent.match(/^[\s\u200B-\u200D\uFEFF]*$/)
					) {
						return NodeFilter.FILTER_ACCEPT;
					}
					return NodeFilter.FILTER_REJECT;
				}
			});

			while (treeWalker.nextNode()) {
				node.removeChild(treeWalker.currentNode);
			}
		};

		if (!this.definition.void) {
			const observer = new MutationObserver(observeEmptyTextNodes);
			observer.observe(node, { childList: true });
			onDestroy.push(() => observer.disconnect());
		}

		observeEmptyTextNodes();
		return {
			destroy: () => {
				if (this.node === node) {
					this.node = undefined;
					if (this.edytor.idToBlock.get(this.id) === this) {
						this.edytor.idToBlock.delete(this.id);
					}
				}
				onDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
