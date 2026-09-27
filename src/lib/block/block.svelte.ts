import { Text } from '../text/text.svelte.js';
import { Edytor } from '../edytor.svelte.js';
import {
	cloneJson,
	jsonBlockToSpec,
	jsonContentToItems,
	type JSONBlock,
	type JSONText,
	type JSONInlineBlock
} from '$lib/utils/json.js';
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
	blocksOf,
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
import type { ContentItem, DocBlock, ProjectedBlock } from '$lib/crdt/index.js';
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
			pending.push({
				text: item.text,
				...(item.marks ? { marks: item.marks } : {})
			});
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

export class Block {
	readonly = false;
	edytor: Edytor;
	parent?: Block;
	children = $state<Block[]>([]);
	content = $state<(Text | InlineBlock)[]>([]);
	id = $state<string>(id('b'));
	data = $state<Record<string, any>>({});
	node?: HTMLElement;
	definition = $state<BlockDefinition>({} as BlockDefinition);

	/** Facade block id — `null` for the root block. */
	_blockId: string | null;
	/** True while the block is visible in the projected tree. */
	_live = true;

	/**
	 * The typed model node for this block — `null` for the root block. All
	 * document reads/writes route through it: `block.model.insertText(...)`,
	 * `block.model.split(...)`, `block.model.children()`, …
	 */
	get model(): DocBlock | null {
		return this._blockId != null ? this.edytor.facade.block(this._blockId) : null;
	}

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
		return this.parent ? this.parent.children.indexOf(this) : 0;
	}

	#type = $state<string>('paragraph');
	get type() {
		return this.#type;
	}
	set type(value: string) {
		this.model?.setType(value);
		this.#type = value;
		this.definition = this.edytor.getBlockDefinition('block', value);
	}

	/**
	 * Write the block `data` payload — the typed-node `setData` write plus
	 * an eager local mirror (mirrors the old `yBlock.set('data')` contract:
	 * `block.data` reflects the write immediately).
	 */
	setData = (data: Record<string, unknown>): void => {
		this.data = data;
		this.model?.setData(cloneJson(data));
	};

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

	get isRoot(): boolean {
		return this === this.edytor.root;
	}

	get isInTree(): boolean {
		return this._live;
	}

	/** Inline suggestions are session state (L12), keyed by this block's id. */
	get suggestions(): (Text | InlineBlock)[] | null {
		const suggestions = this.rawSuggestions;
		if (!suggestions) {
			return null;
		}
		return suggestions.map((suggestion) => {
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
		const suggestions = this.edytor.selection.suggestions;
		if (value) suggestions.set(this.id, value);
		else suggestions.delete(this.id);
	}

	get rawSuggestions(): (JSONText[] | JSONInlineBlock)[] | null {
		return this.edytor.selection?.suggestions.get(this.id) ?? null;
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

	/**
	 * This block's JSON — the document's one serializer (`facade.blockJSON`,
	 * L14). The root reads the document's top level.
	 */
	get value(): JSONBlock {
		const { facade } = this.edytor;
		if (this._blockId != null) return facade.blockJSON(this._blockId);
		const children = facade.toJSON().children;
		return {
			type: this.#type,
			id: this.id,
			data: this.data,
			...(children.length > 0 && { children })
		};
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

	addChildBlock = batch('addChildBlock', addChildBlock, undefined, blockOf);
	addChildBlocks = batch('addChildBlocks', addChildBlocks, undefined, blocksOf);
	insertBlockAfter = batch('insertBlockAfter', insertBlockAfter, prepareInsertAfter, blockOf);
	insertBlockBefore = batch('insertBlockBefore', insertBlockBefore, prepareInsertBefore, blockOf);
	splitBlock = batch('splitBlock', splitBlock, prepareSplit, blockOf);
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
	addInlineBlock = batch('addInlineBlock', addInlineBlock, undefined, textAfterAtom);
	normalizeContent = batch('normalizeContent', normalizeContent);
	normalizeChildren = batch('normalizeChildren', normalizeChildren);
	suggestText = batch('suggestText', suggestText);
	acceptSuggestedText = batch('acceptSuggestedText', acceptSuggestedText);
	deleteContentAtRange = batch('deleteContentAtRange', deleteContentAtRange, prepareDeleteRange);

	void = (node: HTMLElement) => {
		node.setAttribute('data-edytor-void', `true`);
		node.style.userSelect = 'none';
		node.contentEditable = 'false';
	};

	/** A wrapper of document block `blockId` (`null`: the root); a reconcile fills it. */
	constructor({
		parent,
		blockId,
		edytor
	}: {
		parent?: Block;
		edytor: Edytor;
		blockId: string | null;
	}) {
		this.parent = parent;
		this.edytor = edytor;
		this._blockId = blockId;
		this.id = blockId ?? 'root';
		if (blockId === null) this.#type = 'root';
		this.definition = this.edytor.getBlockDefinition('block', this.#type);
		this.edytor.idToBlock.set(this.id, this);
	}

	// ── facade binding ──────────────────────────────────────────────────

	private get facade() {
		return this.edytor.facade!;
	}

	/** Adopt a projected node — refresh meta, children and content (mirror reconcile). */
	_reconcile = (node: ProjectedBlock) => {
		this._reconcileMeta(node.type, node.data);
		this.reconcileChildren(node.children);
		this.reconcileContent(node.content);
	};

	/**
	 * Apply a DocChange `meta` patch — the type/data half of `_reconcile`
	 * (incremental mirror path; children/content have their own patches).
	 */
	_reconcileMeta = (type: string, data: Record<string, unknown> | undefined) => {
		if (this.#type !== type) {
			this.#type = type;
			this.definition = this.edytor.getBlockDefinition('block', type);
		}
		const nextData = data ?? {};
		if (JSON.stringify(this.data) !== JSON.stringify(nextData)) {
			this.data = nextData;
		}
	};

	/**
	 * Set `children` to the listed ids (a projected node: a subtree to build),
	 * reusing wrappers by id; a child left out drops unless `keep` names it.
	 */
	reconcileChildren = (
		nodes: readonly (ProjectedBlock | string)[],
		keep = (id: string) => this.edytor.facade.isVisibleBlock(id)
	) => {
		const { idToBlock } = this.edytor;
		const next = nodes.map((node) => {
			const id = typeof node === 'string' ? node : node.id;
			const child =
				idToBlock.get(id) ?? new Block({ parent: this, edytor: this.edytor, blockId: id });
			child._bind(this);
			if (typeof node !== 'string') child._reconcile(node);
			return child;
		});
		const used = new Set(next);
		for (const old of this.children) if (!used.has(old) && !keep(old.id)) old._drop(keep);
		this.children = next;
	};

	/**
	 * Rebuild `content` from the block's items: an atom keeps its wrapper by
	 * id, a text segment the wrapper of the same ordinal.
	 */
	reconcileContent = (items: readonly ContentItem[]) => {
		const prev = this.content;
		const atoms = new Map<string, InlineBlock>();
		const texts = new Map<number, Text>();
		for (const part of prev)
			if (part instanceof Text) texts.set(part._segOrd, part);
			else atoms.set(part.id, part);
		const used = new Set<Text | InlineBlock>();
		const next = deriveContentParts(items).map((part, index): Text | InlineBlock => {
			if (part.kind === 'inline') {
				const wrapper =
					atoms.get(part.item.id) ?? new InlineBlock({ parent: this, run: part.item });
				wrapper._bindRun(part.item);
				wrapper.parent = this;
				wrapper.index = index;
				used.add(wrapper);
				return wrapper;
			}
			const byOrd = texts.get(part.segOrd);
			const wrapper = (byOrd && !used.has(byOrd) ? byOrd : undefined) ?? new Text({ parent: this });
			wrapper._bind(part.segOrd, part.items);
			wrapper.parent = this;
			wrapper.index = index;
			used.add(wrapper);
			return wrapper;
		});
		for (const old of prev) if (!used.has(old)) old._kill();
		this.content = next;
	};

	/**
	 * Mark this wrapper dead — no longer visible in the tree. Descendants
	 * are dropped too, EXCEPT ids `keepAlive` reports as still visible: a
	 * commit can move a child OUT of a dying subtree (`keepChildren`
	 * deletes, cross-parent moves), and dropping it wholesale forces the
	 * next reconcile to remount a fresh wrapper (losing DOM state and any
	 * caller-held reference).
	 *
	 * `keepAlive` defaults to the projected-visibility oracle
	 * (`facade.isVisibleBlock`) — the same check `reconcileChildren` applies to
	 * the drop candidates themselves — so the cascade drops exactly the
	 * invisible nodes in every path that calls it. The incremental mirror
	 * apply passes the DocChange's `claimed` set instead: equal on the
	 * reachable domain (a still-visible descendant of a doomed root is
	 * `moved`, and every moved id lands inside an `order` list) without
	 * touching the projected index.
	 */
	_drop = (keepAlive?: (id: string) => boolean) => {
		const keep = keepAlive ?? ((id: string) => this.edytor.facade.isVisibleBlock(id));
		this._live = false;
		if (this.edytor.idToBlock.get(this.id) === this) {
			this.edytor.idToBlock.delete(this.id);
		}
		for (const child of this.children) {
			if (!keep(child.id)) {
				child._drop(keep);
			}
		}
		for (const part of this.content) {
			part._kill();
		}
		if (this.node) {
			this.node = undefined;
		}
	};

	/** The wrapper shows a visible block under `parent`. */
	_bind = (parent?: Block) => {
		this._live = true;
		if (parent) this.parent = parent;
	};

	/**
	 * Content parts derived from the CURRENT doc state — mid-transaction safe
	 * (read-your-writes) and scoped to this block (`contentItems`, O(this
	 * block), never a whole-tree projection per keystroke). `null` when the
	 * block is not bound or not visible.
	 */
	projectedParts = (): DerivedContentPart[] | null => {
		const id = this._blockId;
		if (id == null || !this.facade.isVisibleBlock(id)) return null;
		return deriveContentParts(this.facade.contentItems(id));
	};

	/** Display offset (atoms) where content part `i` starts in the current doc state. */
	atomOffsetOfPartIndex = (i: number, parts = this.projectedParts()): number => {
		let off = 0;
		if (parts) for (let k = 0; k < i && k < parts.length; k++) off += displayLenOfPart(parts[k]);
		else
			for (let k = 0; k < i && k < this.content.length; k++) {
				const p = this.content[k];
				off += p instanceof Text ? p.length : 1;
			}
		return off;
	};

	/**
	 * Display offset (atoms) of a content part inside this block — the one
	 * part → offset mapper (`Text.segStart` reads it). The part is found among
	 * the current parts by identity (`segOrd`, atom id); the `content` mirror
	 * may be stale mid-transaction, so its index is only a fallback.
	 */
	partOffsetOf = (part: Text | InlineBlock): number => {
		// The first text segment starts the content: no read needed.
		if (part instanceof Text && part._segOrd === 0 && part.parent === this) return 0;
		const parts = this.projectedParts();
		let index =
			parts?.findIndex((p) =>
				part instanceof Text
					? p.kind === 'text' && p.segOrd === part._segOrd
					: p.kind === 'inline' && p.item.id === part.id
			) ?? -1;
		if (index === -1) index = this.content.indexOf(part);
		if (parts && index !== -1 && index < parts.length)
			return this.atomOffsetOfPartIndex(index, parts);
		const at = this.content.indexOf(part);
		return this.atomOffsetOfPartIndex(at === -1 ? this.content.length : at, null);
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
	 * when missing; the commit's report builds its wrapper); a block wrapper
	 * moves there with its identity.
	 */
	insertChildren = (index: number, blocks: (JSONBlock | Block)[]): void => {
		const { facade } = this.edytor;
		blocks.forEach((block, k) => {
			if (block instanceof Block) block.model?.moveTo({ parent: this.model, index: index + k });
			else facade.insertBlock({ parent: this._blockId, index: index + k }, jsonBlockToSpec(block));
		});
	};

	/** Delete `length` visible children from `index` (a document delete). */
	deleteChildren = (index: number, length = 1): void => {
		const ids = this.edytor.facade.childrenIds(this._blockId);
		for (const id of ids.slice(index, index + length).reverse())
			this.edytor.facade.block(id).delete();
	};

	/**
	 * Insert content before part `index` (a text segment or an inline atom):
	 * each entry is a text's runs or an atom, as JSON.
	 */
	insertParts = (index: number, parts: (JSONText[] | JSONInlineBlock)[]): void => {
		const model = this.model;
		if (!model) return;
		let at = this.atomOffsetOfPartIndex(index);
		for (const item of jsonContentToItems(parts.flat())) {
			if (item.kind === 'inline') model.insertInline(at++, item);
			else if (item.text) {
				model.insertText(at, item.text, item.marks);
				at += item.text.length;
			}
		}
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

		return {
			destroy: () => {
				if (this.node === node) {
					this.node = undefined;
					// A moved block's element is re-created where it moved (R2):
					// only a dead wrapper leaves the registry the cells resolve through.
					if (!this._live && this.edytor.idToBlock.get(this.id) === this) {
						this.edytor.idToBlock.delete(this.id);
					}
				}
				onDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
