import { Text } from '../text/text.svelte.js';
import { Edytor } from '../edytor.svelte.js';
import type { JSONBlock, JSONText, JSONInlineBlock } from '$lib/utils/json.js';
import {
	batch,
	removeInlineBlock,
	addChildBlock,
	insertBlockAfter,
	insertBlockBefore,
	mergeBlockBackward,
	mergeBlockForward,
	nestBlock,
	removeBlock,
	setBlock,
	splitBlock,
	prepareSplit,
	duplicateBlock,
	prepareDuplicate,
	prepareSet,
	prepareMove,
	prepareMoves,
	prepareInsertAfter,
	prepareInsertBefore,
	prepareRemove,
	prepareMergeBackward,
	prepareMergeForward,
	prepareUnNest,
	prepareNest,
	prepareRemoveInline,
	prepareSetInline,
	setInlineData,
	prepareDeleteRange,
	addChildBlocks,
	pushContentIntoBlock,
	unNestBlock,
	moveBlock,
	moveBlocks,
	normalizeContent,
	addInlineBlock,
	textAfterAtom,
	blockOf,
	acceptSuggestedText,
	suggestText,
	deleteContentAtRange,
	normalizeChildren
} from './block.utils.js';
import { jsonBlockToSpec, jsonContentToItems } from '$lib/utils/json.js';
import type { BlockDefinition } from '$lib/plugins.js';
import { InlineBlock } from './inlineBlock.svelte.js';
import type { DocBlock } from '$lib/crdt/index.js';

/**
 * An id-only block handle (§2.4 "Handles", R4): every getter reads the
 * document index (transaction-aware), every mutator issues a command. The
 * view keeps one per id (`edytor.idToBlock`); `node` is the element the core
 * renders for it (O45).
 */
export class Block {
	readonly = false;
	readonly edytor: Edytor;
	readonly id: string;
	node?: HTMLElement;

	constructor(edytor: Edytor, id: string) {
		this.edytor = edytor;
		this.id = id;
	}

	get isRoot(): boolean {
		return this.id === 'root';
	}

	/** The typed document node — `null` for the root. */
	get model(): DocBlock | null {
		return this.isRoot ? null : this.edytor.facade.block(this.id);
	}

	/** The display parent (the root for a top-level block); none for the root or a dead block. */
	get parent(): Block | undefined {
		const at = this.isRoot ? null : this.edytor.facade.positionOf(this.id);
		return at ? this.edytor.idToBlock.block(at.parent ?? 'root') : undefined;
	}

	get children(): Block[] {
		const { facade, idToBlock } = this.edytor;
		return facade.childrenIds(this.isRoot ? null : this.id).map(idToBlock.block);
	}

	/** Text segments and inline atoms, alternating, starting and ending with a text. */
	get content(): (Text | InlineBlock)[] {
		const handles = this.edytor.idToBlock;
		let ordinal = 0;
		return handles
			.parts(this.id)
			.map((part) =>
				part.kind === 'text'
					? handles.text(this.id, ordinal++)
					: handles.atom(this.id, part.item.id)
			);
	}

	get type(): string {
		return this.isRoot ? 'root' : (this.edytor.facade.blockTypeOf(this.id) ?? '');
	}
	/** Retype the block — the `setBlock` command (readonly, hooks, `dispatcher.last`). */
	set type(value: string) {
		this.setBlock({ value: { type: value } });
	}

	get data(): Record<string, any> {
		return (!this.isRoot && this.edytor.facade.blockDataOf(this.id)) || {};
	}

	get definition(): BlockDefinition {
		return this.edytor.definitionOf(this.type);
	}

	/**
	 * Replace the block's `data` — the `setBlock` command (readonly, hooks,
	 * `dispatcher.last`); `block.model.setData` is the raw document write.
	 */
	setData = (data: Record<string, unknown>): void => {
		// Non-JSON values are coerced at the document boundary (`sanitizeSpec`).
		this.setBlock({ value: { data: data as JSONBlock['data'] } });
	};

	get selected() {
		return this.edytor.selection.selectedBlocks.has(this);
	}
	get focused() {
		return this.edytor.selection.focusedBlocks.has(this) && !this.selected;
	}

	/** May this block move at all — R5 `canPlace` without a destination (drag handles). */
	get movable(): boolean {
		return this.edytor.facade.canPlace([this.id]);
	}

	/**
	 * May text-level structural commands (convert, markdown shortcut, slash
	 * menu) apply: the block is movable and has no role of its own.
	 */
	get convertible(): boolean {
		const { facade } = this.edytor;
		return this.movable && !facade.isVoid(this.id) && !facade.isIsland(this.id);
	}

	get firstEditableText(): Text | undefined {
		// Only a RENDERED text part is editable — a container's phantom
		// content slot holds a Text with no `node`. Scan ALL children: the
		// first child can be noneditable (a void divider) while a later
		// child owns the text the caret must land in.
		const own = this.content.find(
			(part): part is Text => part instanceof Text && part.node != null
		);
		if (own) return own;
		for (const child of this.children) {
			const text = child.firstEditableText;
			if (text) return text;
		}
		return undefined;
	}

	get lastEditableText(): Text | undefined {
		const own = this.content.findLast(
			(part): part is Text => part instanceof Text && part.node != null
		);
		if (own) return own;
		for (let i = this.children.length - 1; i >= 0; i--) {
			const text = this.children[i]!.lastEditableText;
			if (text) return text;
		}
		return undefined;
	}

	get index(): number {
		return (!this.isRoot && this.edytor.facade.positionOf(this.id)?.index) || 0;
	}

	get depth(): number {
		return this.parent ? this.parent.depth + 1 : 0;
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

	/** The block is visible in the document (a dead handle answers false). */
	get isInTree(): boolean {
		return this.isRoot || this.edytor.facade.isVisibleBlock(this.id);
	}

	/** Inline suggestions are session state (L12), keyed by this block's id: plain JSON parts. */
	get suggestions(): (JSONText[] | JSONInlineBlock)[] | null {
		return this.edytor.selection?.suggestions.get(this.id) ?? null;
	}

	set suggestions(value: (JSONText[] | JSONInlineBlock)[] | null) {
		const suggestions = this.edytor.selection.suggestions;
		if (value) suggestions.set(this.id, value);
		else suggestions.delete(this.id);
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
		return this.edytor.blockBefore(this);
	}

	get closestNextBlock(): Block | null {
		return this.edytor.blockAfter(this);
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

	/** This block's JSON — the document's one serializer (`facade.blockJSON`, L14). */
	get value(): JSONBlock {
		if (!this.isRoot) return this.edytor.facade.blockJSON(this.id);
		const children = this.edytor.facade.toJSON().children;
		return { type: 'root', id: 'root', data: {}, ...(children.length > 0 && { children }) };
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

	/** Whether this kind renders its own content slot — the adopted capability (R5, O22). */
	get rendersContent(): boolean {
		return this.edytor.document.rendersContent(this.type);
	}

	/**
	 * The first text of this block's own content — none for a kind that
	 * does not render its content (a list container, a divider): its slot
	 * is never displayed, so no caret or endpoint may land there. A block
	 * without a content slot (the root) answers with its first child's.
	 */
	get firstText(): Text | undefined {
		if (!this.content.length) return this.children.at(0)?.firstText;
		return this.rendersContent ? this.content.find((p) => p instanceof Text) : undefined;
	}

	/** The last text of this block's own content (see {@link firstText}). */
	get lastText(): Text | undefined {
		if (!this.content.length) return this.children.at(-1)?.lastText;
		return this.rendersContent ? this.content.findLast((p) => p instanceof Text) : undefined;
	}

	addChildBlock = batch('addChildBlock', addChildBlock);
	addChildBlocks = batch('addChildBlocks', addChildBlocks);
	insertBlockAfter = batch('insertBlockAfter', insertBlockAfter, prepareInsertAfter, blockOf);
	insertBlockBefore = batch('insertBlockBefore', insertBlockBefore, prepareInsertBefore, blockOf);
	splitBlock = batch('splitBlock', splitBlock, prepareSplit, blockOf);
	duplicateBlock = batch('duplicateBlock', duplicateBlock, prepareDuplicate, blockOf);
	removeBlock = batch('removeBlock', removeBlock, prepareRemove);
	unNestBlock = batch('unNestBlock', unNestBlock, prepareUnNest);
	mergeBlockBackward = batch(
		'mergeBlockBackward',
		mergeBlockBackward,
		prepareMergeBackward,
		blockOf
	);
	mergeBlockForward = batch('mergeBlockForward', mergeBlockForward, prepareMergeForward, blockOf);
	nestBlock = batch('nestBlock', nestBlock, prepareNest);
	setBlock = batch('setBlock', setBlock, prepareSet);
	moveBlock = batch('moveBlock', moveBlock, prepareMove);
	moveBlocks = batch('moveBlocks', moveBlocks, prepareMoves);
	pushContentIntoBlock = batch('pushContentIntoBlock', pushContentIntoBlock);
	removeInlineBlock = batch('removeInlineBlock', removeInlineBlock, prepareRemoveInline);
	setInlineData = batch('setInlineData', setInlineData, prepareSetInline);
	addInlineBlock = batch('addInlineBlock', addInlineBlock, undefined, textAfterAtom);
	normalizeContent = batch('normalizeContent', normalizeContent);
	normalizeChildren = batch('normalizeChildren', normalizeChildren);
	suggestText = batch('suggestText', suggestText);
	acceptSuggestedText = batch('acceptSuggestedText', acceptSuggestedText);
	deleteContentAtRange = batch('deleteContentAtRange', deleteContentAtRange, prepareDeleteRange);

	/** Mark an element inside the block's markup as non-editable chrome (a header, a caption bar). */
	void = (node: HTMLElement) => {
		node.setAttribute('data-edytor-void', `true`);
		node.style.userSelect = 'none';
		node.setAttribute('contenteditable', 'false');
	};

	/**
	 * The text segment that displays block offset `offset`, and the offset in
	 * it — the one offset → segment mapper over the committed parts (a
	 * boundary before an atom reads the text before it; past the end, the
	 * last text's end).
	 */
	textAtOffset = (offset: number): { text: Text; offset: number } | null => {
		let at = 0;
		let hit: { text: Text; offset: number } | null = null;
		for (const part of this.content) {
			if (!(part instanceof Text)) {
				if (offset <= at) return hit;
				at += 1;
			} else if (offset <= at + part.length) {
				return { text: part, offset: Math.max(0, offset - at) };
			} else {
				hit = { text: part, offset: part.length };
				at += part.length;
			}
		}
		return hit;
	};

	// ── JSON insertion (K5: specs are data; `new Block({block})` is gone) ──

	/**
	 * Insert children at `index`: a JSON spec is created (its id kept, minted
	 * when missing); a block handle moves there with its identity.
	 */
	insertChildren = (index: number, blocks: (JSONBlock | Block)[]): void => {
		const { facade } = this.edytor;
		const parent = this.isRoot ? null : this.id;
		blocks.forEach((block, k) => {
			if (block instanceof Block) block.model?.moveTo({ parent: this.model, index: index + k });
			else facade.insertBlock({ parent, index: index + k }, jsonBlockToSpec(block));
		});
	};

	/** Delete `length` visible children from `index`, each with its subtree (a document delete). */
	deleteChildren = (index: number, length = 1): void => {
		const ids = this.edytor.facade.childrenIds(this.isRoot ? null : this.id);
		for (const id of ids.slice(index, index + length).reverse())
			this.edytor.facade.block(id).delete({ keepChildren: false });
	};

	/**
	 * Insert content before part `index` (a text segment or an inline atom):
	 * each entry is a text's runs or an atom, as JSON.
	 */
	insertParts = (index: number, parts: (JSONText[] | JSONInlineBlock)[]): void => {
		const model = this.model;
		if (!model) return;
		const all = this.edytor.idToBlock.parts(this.id);
		let at = all[index]?.start ?? model.length;
		for (const item of jsonContentToItems(parts.flat())) {
			if (item.kind === 'inline') model.insertInline(at++, item);
			else if (item.text) {
				model.insertText(at, item.text, item.marks);
				at += item.text.length;
			}
		}
	};

	/** Register the element the core rendered for this block (O45) and run the attach hooks. */
	attach = (node: HTMLElement) => {
		this.node = node;
		const release = this.edytor.surface.register(node, 'block', this.id);
		const onDestroy = this.edytor.plugins.reduce(
			(acc, plugin) => {
				const action = plugin.onBlockAttached?.({ node, block: this });
				if (typeof action === 'function') acc.push(action);
				return acc;
			},
			[] as (() => void)[]
		);
		return {
			destroy: () => {
				if (this.node === node) this.node = undefined;
				release();
				onDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
