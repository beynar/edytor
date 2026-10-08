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
	preparePatch,
	patchData,
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
	normalizeChildren,
	type BlockOperations
} from './block.utils.js';
import { jsonBlockToSpec, jsonContentToItems } from '$lib/utils/json.js';
import type { BlockDefinition } from '$lib/plugins.js';
import { InlineBlock } from './inlineBlock.svelte.js';
import type { DocBlock } from '$lib/crdt/index.js';
import { revealed } from '$lib/selection/replaceSelection.js';
import { propsProxy } from '$lib/session/props.js';

/** Mark an element inside a block's markup as non-editable chrome (`block.void`, a preview's too). */
export const voidChrome = (node: HTMLElement) => {
	node.setAttribute('data-edytor-void', `true`);
	node.style.userSelect = 'none';
	node.setAttribute('contenteditable', 'false');
};

/**
 * An id-only block handle: every getter reads the document index
 * (transaction-aware), every mutator issues a command. The view keeps one per
 * id (`edytor.idToBlock`); `node` is the element the core renders for it.
 *
 * A reactive reader (a template, a `$derived`, an `$effect`) of a getter
 * depends on the cells the answer comes from (this block's, its parent's,
 * the root's list), so it re-runs when a commit changes them, as `data`
 * does; a read anywhere else is a plain read of the document.
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

	/**
	 * Under a reactive reader, depend on block `id`'s cell (the root: its
	 * child list): the commit that patches it re-runs the reader. A cell
	 * that goes away (the block died) re-runs it too.
	 */
	#track(id: string = this.id): void {
		if (!$effect.tracking()) return;
		const cells = this.edytor.cells;
		if (id === 'root') void cells?.rootIds;
		else cells?.get(id);
	}

	/** The typed document node — `null` for the root. */
	get model(): DocBlock | null {
		return this.isRoot ? null : this.edytor.facade.block(this.id);
	}

	/** The display parent (the root for a top-level block); none for the root or a dead block. */
	get parent(): Block | undefined {
		if (this.isRoot) return undefined;
		this.#track();
		const at = this.edytor.facade.positionOf(this.id);
		// The parent's child list names this block: a move patches it.
		if (at) this.#track(at.parent ?? 'root');
		return at ? this.edytor.idToBlock.block(at.parent ?? 'root') : undefined;
	}

	get children(): Block[] {
		this.#track();
		const { facade, idToBlock } = this.edytor;
		return facade.childrenIds(this.isRoot ? null : this.id).map(idToBlock.block);
	}

	/** Text segments and inline atoms, alternating, starting and ending with a text. */
	get content(): (Text | InlineBlock)[] {
		this.#track();
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
		if (this.isRoot) return 'root';
		this.#track();
		return this.edytor.facade.blockTypeOf(this.id) ?? '';
	}
	/** Retype the block — the `setBlock` command (readonly, hooks, `dispatcher.last`). */
	set type(value: string) {
		this.setBlock({ value: { type: value } });
	}

	#data?: { version: number; value: Record<string, unknown> };
	#props?: Record<string, any>;
	/**
	 * The block's `data` as a live proxy (`session/props.ts`): reads follow the
	 * document (reactive through the block's cell), writes are `patchData`
	 * commands. The root's is the document's data (`edytor.data`).
	 */
	get data(): Record<string, any> {
		return (this.#props ??= propsProxy(
			() => (this.isRoot ? this.edytor.docData() : this.#current()),
			(ops) => this.patchData({ ops }),
			(path) => this.edytor.facade.dataItemIds(this.isRoot ? null : this.id, path)
		));
	}
	#current() {
		const { facade, cells } = this.edytor;
		cells?.get(this.id);
		const version = facade.version;
		if (this.#data?.version !== version)
			this.#data = { version, value: facade.blockDataOf(this.id) ?? {} };
		return this.#data.value;
	}

	get definition(): BlockDefinition {
		return this.edytor.definitionOf(this.type);
	}

	/**
	 * Replace the block's `data` — a `patchData` command of its root (readonly,
	 * hooks, `dispatcher.last`); `block.model.setData` is the raw document write.
	 */
	setData = (data: Record<string, unknown>): void => {
		// Non-JSON values are coerced at the document boundary (`sanitizeWireJson`).
		this.patchData({ ops: [{ path: [], value: data }] });
	};

	get selected() {
		return this.edytor.selection.selectedBlocks.has(this);
	}
	get focused() {
		return this.edytor.selection.focusedBlocks.has(this) && !this.selected;
	}

	/** May this block move at all: `canPlace` without a destination (drag handles). */
	get movable(): boolean {
		return this.edytor.facade.canPlace([this.id]);
	}

	/**
	 * May text-level structural commands (convert, markdown shortcut, slash
	 * menu) apply: the block is movable — or the virtual paragraph of an
	 * emptied document, which a conversion creates with its kind
	 * — has no role of its own and renders its own content —
	 * a container (a list) is never converted, its items are.
	 */
	get convertible(): boolean {
		const { facade } = this.edytor;
		const placeable = this.movable || facade.virtual() === this.id;
		return placeable && this.rendersContent && !facade.isVoid(this.id) && !facade.isIsland(this.id);
	}

	/** @internal */
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

	/** @internal */
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
		if (this.isRoot) return 0;
		const at = this.edytor.facade.positionOf(this.id);
		this.#track();
		if (at) this.#track(at.parent ?? 'root');
		return at?.index || 0;
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
		if (this.isRoot) return true;
		this.#track();
		return this.edytor.facade.isVisibleBlock(this.id);
	}

	/**
	 * @deprecated `edytor.suggestions` with `{ end: block.id }`. The content of
	 * this block's latest `end` suggestion, as parts (a text's runs, or an
	 * atom); setting it replaces this block's `end` suggestions, `null` drops them.
	 */
	get suggestions(): (JSONText[] | JSONInlineBlock)[] | null {
		const content = this.edytor.suggestions?.at(this.id).end.at(-1)?.content[0]?.content;
		if (!content?.length) return null;
		const parts: (JSONText[] | JSONInlineBlock)[] = [];
		for (const part of content)
			if ('type' in part) parts.push(part);
			else if (Array.isArray(parts.at(-1))) (parts.at(-1) as JSONText[]).push(part);
			else parts.push([part]);
		return parts;
	}

	set suggestions(value: (JSONText[] | JSONInlineBlock)[] | null) {
		const { suggestions } = this.edytor;
		for (const suggestion of suggestions.at(this.id).end) suggestion.discard();
		if (value) suggestions.add({ end: this.id }, [{ type: this.type, content: value.flat() }]);
	}

	get nextBlock(): Block | null {
		return this.parent ? this.parent.children[this.index + 1] : null;
	}

	get previousBlock(): Block | null {
		return this.parent ? this.parent.children[this.index - 1] : null;
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

	/** It shows content: text or an inline atom (a block holding only a mention is not empty). */
	get hasContent(): boolean {
		return this.content.some((part) => !(part instanceof Text) || !part.isEmpty);
	}

	/** It holds nothing: no content and no children (the emptiness Turn into reads, `holdsNothing`). */
	get isEmpty(): boolean {
		return !this.hasContent && !this.hasChildren;
	}

	get isNested(): boolean {
		return (this.parent && this.parent.type !== 'root') || false;
	}

	/** This block's JSON — the document's one serializer (`facade.blockJSON`). */
	get value(): JSONBlock {
		// Its subtree's: every commit re-runs a reactive reader.
		if ($effect.tracking()) void this.edytor.valueRevision;
		if (!this.isRoot) return this.edytor.facade.blockJSON(this.id);
		const { data = {}, children } = this.edytor.facade.toJSON();
		return { type: 'root', id: 'root', data, ...(children.length > 0 && { children }) };
	}

	isChildOf(block: Block): boolean {
		for (let parent = this.parent; parent; parent = parent.parent)
			if (parent === block) return true;
		return false;
	}

	/** Whether this kind renders its own content slot — the adopted capability. */
	get rendersContent(): boolean {
		return this.edytor.document.rendersContent(this.type);
	}

	/**
	 * A container: it shows only its children (a list), neither void nor an
	 * island — the document's container rule. Its items hold what it
	 * shows; it is never converted (`convertible`).
	 */
	get isContainer(): boolean {
		const { facade } = this.edytor;
		return !this.rendersContent && !facade.isVoid(this.id) && !facade.isIsland(this.id);
	}

	/**
	 * An item of a list: its parent is a container whose items are a kind of
	 * their own (a `list-item` in an `unordered-list`), not the document's
	 * default — a column of paragraphs is no list. Turned into another kind,
	 * an item leaves its list; <kbd>Enter</kbd> in an empty one ends it.
	 */
	get isListItem(): boolean {
		const { parent, edytor } = this;
		if (!parent?.isContainer) return false;
		const item = edytor.defaultChild(parent);
		return this.type === item && item !== edytor.document.defaultChild(null);
	}

	/**
	 * The list this block shows in: its container when it is an item
	 * (`isListItem`), or — an item outdented out of a nested list into the
	 * item holding it — the list of the items of its kind it
	 * sits under. <kbd>Enter</kbd> in an empty one outdents it; the menus
	 * name it by the list's `itemKind`.
	 */
	get list(): Block | undefined {
		if (this.isListItem) return this.parent ?? undefined;
		return this.parent?.type === this.type ? this.parent.list : undefined;
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
	unNestBlock = revealed(batch('unNestBlock', unNestBlock, prepareUnNest));
	mergeBlockBackward = batch(
		'mergeBlockBackward',
		mergeBlockBackward,
		prepareMergeBackward,
		blockOf
	);
	mergeBlockForward = batch('mergeBlockForward', mergeBlockForward, prepareMergeForward, blockOf);
	nestBlock = revealed(batch('nestBlock', nestBlock, prepareNest));
	setBlock = batch('setBlock', setBlock, prepareSet);
	moveBlock = revealed(batch('moveBlock', moveBlock, prepareMove));
	moveBlocks = revealed(batch('moveBlocks', moveBlocks, prepareMoves));
	pushContentIntoBlock = batch('pushContentIntoBlock', pushContentIntoBlock);
	removeInlineBlock = batch('removeInlineBlock', removeInlineBlock, prepareRemoveInline);
	patchData = batch('patchData', patchData, preparePatch);
	#addInline = batch('addInlineBlock', addInlineBlock, undefined, textAfterAtom);
	/**
	 * Insert an inline atom: at `offset` of the block's content (block
	 * offsets, an inline atom counting 1; a caret's), or at `index` of the
	 * text segment `text`. One `addInlineBlock` operation (its payload names
	 * the segment). Answers the text segment right after the atom, where a
	 * caret goes (`null` when it was not written, `undefined` when refused).
	 */
	addInlineBlock = (
		payload: BlockOperations['addInlineBlock'] | { offset: number; block: JSONInlineBlock }
	) => {
		if (!('offset' in payload)) return this.#addInline(payload);
		const at = this.textAtOffset(Math.max(0, payload.offset));
		return at ? this.#addInline({ index: at.offset, text: at.text, block: payload.block }) : null;
	};
	normalizeContent = batch('normalizeContent', normalizeContent);
	normalizeChildren = batch('normalizeChildren', normalizeChildren);
	/** @deprecated `edytor.suggestions.add({ end: block.id }, …)`. */
	suggestText = (payload: BlockOperations['suggestText']) => suggestText.call(this, payload);
	/** @deprecated `suggestion.accept()`. */
	acceptSuggestedText = () => acceptSuggestedText.call(this);
	deleteContentAtRange = batch('deleteContentAtRange', deleteContentAtRange, prepareDeleteRange);

	/** Mark an element inside the block's markup as non-editable chrome (a header, a caption bar). */
	void = voidChrome;

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

	/** The declared view state (`open` on a `details`) the block's last element held. */
	#viewState: [string, string][] = [];

	/**
	 * Register the element the core rendered for this block (O45) and run the
	 * attach hooks. A re-rendered block (moved, re-parented) keeps its declared
	 * view state (R11): an open toggle stays open.
	 * @internal
	 */
	attach = (node: HTMLElement) => {
		const names = this.definition.viewState ?? [];
		const read = (from: HTMLElement): [string, string][] =>
			names.flatMap((name) => (from.hasAttribute(name) ? [[name, from.getAttribute(name)!]] : []));
		for (const [name, value] of this.node ? read(this.node) : this.#viewState)
			if (names.includes(name)) node.setAttribute(name, value);
		this.node = node;
		const release = this.edytor.surface.register(node, 'block', this.id);
		const onDestroy = this.edytor.plugins.flatMap((plugin) => {
			const action = plugin.onBlockAttached?.({ node, block: this });
			return typeof action === 'function' ? [action] : [];
		});
		return {
			destroy: () => {
				this.#viewState = read(node);
				if (this.node === node) this.node = undefined;
				release();
				onDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
