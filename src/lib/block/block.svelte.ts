import { Text } from '../text/text.svelte.js';
import { Edytor } from '../edytor.svelte.js';
import { cloneJson, type JSONBlock, type JSONText, type JSONInlineBlock } from '$lib/utils/json.js';
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
import type { BlockSpec, ContentItem, DocBlock, ProjectedBlock } from '$lib/crdt/index.js';
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

/**
 * `JSONBlock` → facade insert spec — the canonical converter now lives in
 * `utils/json.ts` (`jsonBlockToSpec`) so spec preparation never needs a
 * disposable `Block` tree; re-exported here for the historical import path.
 */
export { jsonBlockToSpec } from '$lib/utils/json.js';

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

	/**
	 * Facade block id — `null` for the root block, `undefined` while the
	 * wrapper is a detached spec (`new Block({block})` before insertion).
	 */
	_blockId: string | null | undefined = undefined;
	/** True once bound to a facade block (or the root). */
	_bound = false;
	/** True while the block is visible in the projected tree. */
	_live = false;
	/** Pending wrapper adoptions by content part index (insertParts). */
	_pendingParts = new Map<number, Text | InlineBlock>();
	/**
	 * Re-normalization pass depth for the current call chain — shared by
	 * `normalizeContent`/`normalizeChildren` so plugin hooks that keep
	 * returning work (or ping-pong between the two) are bounded instead of
	 * overflowing the stack (D25).
	 */
	_normalizationDepth = 0;

	/**
	 * The typed model node for this block — `null` for the root block and
	 * for detached spec wrappers (which carry no facade id). All document
	 * reads/writes route through it: `block.model.insertText(...)`,
	 * `block.model.split(...)`, `block.model.children()`, …
	 */
	get model(): DocBlock | null {
		return this._bound && this._blockId != null ? this.edytor.facade.block(this._blockId) : null;
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
	 * L14). The root reads the document's top level. A detached spec wrapper
	 * (not yet inserted) has no document value beyond its own fields.
	 */
	get value(): JSONBlock {
		const { facade } = this.edytor;
		if (!this._bound) return { type: this.#type, id: this.id, data: this.data };
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

	addChildBlock = batch('addChildBlock', addChildBlock);
	addChildBlocks = batch('addChildBlocks', addChildBlocks);
	insertBlockAfter = batch('insertBlockAfter', insertBlockAfter, prepareInsertAfter);
	insertBlockBefore = batch('insertBlockBefore', insertBlockBefore, prepareInsertBefore);
	splitBlock = batch('splitBlock', splitBlock, prepareSplit);
	removeBlock = batch('removeBlock', removeBlock, prepareRemove);
	unNestBlock = batch('unNestBlock', unNestBlock, prepareUnNest);
	mergeBlockBackward = batch('mergeBlockBackward', mergeBlockBackward, prepareMergeBackward);
	mergeBlockForward = batch('mergeBlockForward', mergeBlockForward, prepareMergeForward);
	nestBlock = batch('nestBlock', nestBlock, prepareNest);
	setBlock = batch('setBlock', setBlock, prepareSet);
	moveBlock = batch('moveBlock', moveBlock, prepareMove);
	moveBlocks = batch('moveBlocks', moveBlocks, prepareMoves);
	pushContentIntoBlock = batch('pushContentIntoBlock', pushContentIntoBlock);
	removeInlineBlock = batch('removeInlineBlock', removeInlineBlock, prepareRemoveInline);
	addInlineBlock = batch('addInlineBlock', addInlineBlock);
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

		if (block !== undefined) {
			if (block.type === 'root') {
				// Bound root wrapper — children reconcile from the projected tree.
				this._blockId = null;
				this._bound = true;
				this._live = true;
				this.id = 'root';
				this.#type = 'root';
				this.data = block.data || {};
				this.children = (block.children || []).map(
					(child) => new Block({ parent: this, edytor, block: child })
				);
			} else {
				// Detached spec mode — fields populate the pending spec used by
				// `insertChildren`/`insertBlock`; no facade calls until bound.
				this._bound = false;
				this._live = false;
				this.id = block.id ?? id('b');
				this.#type = block.type;
				this.data = block.data || {};
				this.children = (block.children || []).map(
					(child) => new Block({ parent: this, edytor, block: child })
				);
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

	/** Rebuild `children` from projected child nodes, reusing wrappers by id. */
	reconcileChildren = (projectedChildren: ProjectedBlock[]) => {
		const prev = this.children;
		const used = new Set<Block>();
		const next = projectedChildren.map((node) => {
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
			used.add(child);
			child._reconcile(node);
			return child;
		});
		for (const old of prev) {
			if (!used.has(old) && !this.edytor.facade.isVisibleBlock(old.id)) {
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
						prev.find(
							(p): p is InlineBlock =>
								p instanceof InlineBlock && p.id === part.item.id && !used.has(p)
						) ?? undefined;
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
				const byOrd = bySegOrd.get(part.segOrd);
				const wrapper =
					pending ??
					byItems ??
					(byOrd !== undefined && !used.has(byOrd) ? byOrd : undefined) ??
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

		// Second pass — leftover pending wrappers (carriers from `insertParts`
		// whose atoms did not land on a fresh part slot):
		// - Inline carriers keep their identity: if the atom exists at a shifted
		//   index, the pending wrapper claims it (callers hold a reference to it);
		//   if the atom never materialized, the carrier is dropped.
		// - Text carriers are fungible: when their atoms merged into a segment
		//   already owned by a live wrapper, the live wrapper keeps the slot
		//   (v13 merged adjacent pushed Y.Texts the same way). The carrier is
		//   retired: callers find the text at the carrier's position.
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
			if (!used.has(wrapper)) wrapper._kill();
		}
		this._pendingParts.clear();

		for (const old of prev) {
			if (!used.has(old)) {
				old._kill();
			}
		}
		this.content = next;
	};

	/** Detached spec → facade BlockSpec (used by `insertChildren`/`insertChild`). */
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

	/**
	 * Content parts derived from the CURRENT doc state — mid-transaction safe
	 * (read-your-writes) and scoped to this block (`contentItems`, O(this
	 * block), never a whole-tree projection per keystroke). `null` when the
	 * block is not bound or not visible.
	 */
	projectedParts = (): DerivedContentPart[] | null => {
		const id = this._blockId;
		if (!this._bound || id == null || !this.facade.isVisibleBlock(id)) return null;
		return deriveContentParts(this.facade.contentItems(id));
	};

	deriveContentParts = deriveContentParts;

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
	 * it — the one offset → segment mapper (a boundary before an atom reads
	 * the text before it). The current parts are the engine-fresh read (a
	 * wrapper's items can lag a write until the mirror reconciles); the
	 * wrappers themselves are the fallback.
	 */
	textAtOffset = (
		offset: number,
		parts = this.projectedParts()
	): { text: Text; offset: number } | null => {
		const texts = this.content.filter((part): part is Text => part instanceof Text);
		const walk = parts
			? parts.map((p) =>
					p.kind === 'text'
						? { text: texts.find((t) => t._segOrd === p.segOrd) ?? null, len: displayLenOfPart(p) }
						: { text: undefined, len: 1 }
				)
			: this.content.map((p) =>
					p instanceof Text ? { text: p, len: p.length } : { text: undefined, len: 1 }
				);
		let off = 0;
		let hit: { text: Text | null; offset: number } | null = null;
		for (const part of walk) {
			if (part.text !== undefined) {
				hit = { text: part.text, offset: part.len };
				if (offset <= off + part.len) {
					hit.offset = Math.max(0, offset - off);
					break;
				}
			} else if (offset <= off) break;
			off += part.len;
		}
		if (hit?.text) return { text: hit.text, offset: Math.min(hit.offset, hit.text.length) };
		return parts ? this.textAtOffset(offset, null) : null;
	};

	/** Display length of the block's content in atoms. */
	displayLength = (): number => this.atomOffsetOfPartIndex(Infinity);

	// ── typed content/children mutation surface ─────────────────────────
	//
	// These are the command primitives the operation layer (`block.utils`,
	// event handlers, plugins) uses to move WRAPPER-level content into the
	// document. They replace the old `yChildren`/`yContent` array adapters:
	// the same callers pass live `Block`/`Text`/`InlineBlock` wrappers and
	// the same `_pendingBlocks`/`_pendingParts` adoption + `flushMirror`
	// contract applies — the only difference is the writes go through the
	// typed node (`block.model` / `child.model`) instead of a fake Yjs
	// array.

	/**
	 * Insert (or relocate) child BLOCK wrappers at `index`.
	 *
	 * - Detached wrappers (`new Block({block})` specs) become an
	 *   `insertBlock` spec under this block and are registered in
	 *   `_pendingBlocks` so the next reconcile adopts them onto the fresh id.
	 * - Bound wrappers move with identity preserved (`model.moveTo`).
	 * - On an UNBOUND block (detached spec tree) this splices the local
	 *   `children` mirror only.
	 */
	insertChildren = (index: number, blocks: Block[]): void => {
		if (!this._bound) {
			blocks.forEach((w, k) => {
				w.parent = this;
				this.children.splice(index + k, 0, w);
			});
			return;
		}
		const model = this.model;
		let i = index;
		for (const child of blocks) {
			if (child.model) {
				child.model.moveTo({ parent: model, index: i });
			} else {
				const spec = child._toSpec();
				const created = model
					? model.insertChild(i, spec)
					: this.edytor.facade.insertBlock({ parent: null, index: i }, spec);
				if (created.status === 'applied') {
					this.edytor._pendingBlocks.set(created.ids[0], child);
				}
			}
			i++;
		}
		this.edytor.flushMirror();
	};

	/**
	 * Delete `length` visible children starting at `index` (document delete,
	 * not detach). On an unbound block this splices the local mirror only.
	 */
	deleteChildren = (index: number, length = 1): void => {
		if (!this._bound) {
			this.children.splice(index, length);
			return;
		}
		const ids = this.model ? this.model.childIds() : this.edytor.facade.childrenIds(null);
		for (let k = index + length - 1; k >= index; k--) {
			const target = ids[k];
			if (target !== undefined) {
				this.edytor.facade.block(target).delete();
			}
		}
		this.edytor.flushMirror();
	};

	/**
	 * Insert content PART wrappers (`Text`/`InlineBlock`) at part `index`.
	 *
	 * - A `Text` contributes its `_items` runs as `insertText` writes at the
	 *   display offset of the part slot.
	 * - An `InlineBlock` becomes one `insertInline` atom (its `_spec`/type/
	 *   data preserved).
	 * - Each wrapper registers in `_pendingParts` so the next reconcile
	 *   adopts it onto the fresh segment/atom at that slot.
	 * - On an unbound block this splices the local `content` mirror only.
	 *   The root block has no content node — the call is a no-op.
	 */
	insertParts = (index: number, parts: (Text | InlineBlock)[]): void => {
		if (!this._bound) {
			parts.forEach((w, k) => {
				w.parent = this;
				this.content.splice(index + k, 0, w);
			});
			this.content.forEach((c, k) => (c.index = k));
			return;
		}
		const model = this.model;
		if (!model) return;
		let partIndex = index;
		let offset = this.atomOffsetOfPartIndex(partIndex);
		for (const part of parts) {
			if (part instanceof Text) {
				for (const run of part._items) {
					if (run.text.length) {
						model.insertText(offset, run.text, run.marks);
						offset += run.text.length;
					}
				}
				this._pendingParts.set(partIndex, part);
			} else {
				const spec = part._spec ?? { type: part.type, data: part.data };
				model.insertInline(offset, {
					id: part.id,
					type: spec.type,
					...(spec.data ? { data: cloneJson(spec.data) } : {})
				});
				offset += 1;
				this._pendingParts.set(partIndex, part);
			}
			partIndex++;
		}
		this.edytor.flushMirror();
	};

	/**
	 * Delete `length` content parts starting at part `index` — text segments
	 * delete their atom span, inline atoms remove by id. On an unbound block
	 * this splices the local `content` mirror only. The root block has no
	 * content node — the call is a no-op.
	 */
	deleteParts = (index: number, length = 1): void => {
		if (!this._bound) {
			this.content.splice(index, length);
			this.content.forEach((c, k) => (c.index = k));
			return;
		}
		const model = this.model;
		if (!model) return;
		const parts = this.projectedParts() ?? [];
		for (let k = index + length - 1; k >= index; k--) {
			const part = parts[k];
			if (!part) continue;
			if (part.kind === 'text') {
				const segStart = this.atomOffsetOfPartIndex(k);
				const segLen = part.items.reduce((n, i) => n + i.text.length, 0);
				if (segLen > 0) {
					model.deleteText(segStart, segLen);
				}
			} else {
				model.removeInline(part.item.id);
			}
		}
		this.edytor.flushMirror();
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
