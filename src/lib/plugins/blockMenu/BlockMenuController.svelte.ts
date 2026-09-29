import type { Snippet } from 'svelte';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	convertBlocks,
	convertibleKinds,
	convertToKind,
	matchesQuery,
	rowOf,
	type KindRow
} from '$lib/kinds.js';
import { getSelectedBlocksInDocumentOrder, outermost } from '$lib/selection/replaceSelection.js';

export type BlockMenuOptions = {
	/** A link to the block, for "Copy link to block" (the row is hidden without it). */
	linkTo?: (block: Block) => string;
	/**
	 * Replace the menu; it renders while `controller.isOpen`, placed beside
	 * the handle (mark your panel `data-edytor-block-menu` for placement).
	 * The controller runs every action; `close()` returns the caret.
	 */
	menu?: Snippet<[BlockMenuController]>;
};

export type BlockMenuAction = {
	id: string;
	label: string;
	icon: string;
	hint?: string;
	danger?: boolean;
	/** Opens the "Turn into" flyout instead of running. */
	submenu?: true;
	isEnabled?: () => boolean;
	run?: () => unknown;
};

export class BlockMenuController {
	/** The block whose grip opened the menu. */
	block = $state<Block | null>(null);
	/**
	 * The blocks the actions apply to, in document order: the block selection
	 * when it holds `block` (Notion), else `block` alone.
	 */
	blocks = $state<Block[]>([]);
	anchor: HTMLElement | null = null;
	query = $state('');
	selectedIndex = $state(0);
	flyout = $state(false);
	/** The keyboard's row in the "Turn into" flyout. */
	flyoutIndex = $state(0);

	constructor(
		private edytor: Edytor,
		private options: BlockMenuOptions = {}
	) {}

	get isOpen() {
		return this.block !== null;
	}

	/** The editor is readonly: the menu closes. */
	get readonly() {
		return this.edytor.readonly;
	}

	get kinds(): KindRow[] {
		return convertibleKinds(this.edytor);
	}

	/** The row naming the open block. */
	get currentKind(): KindRow | undefined {
		return rowOf(this.edytor, this.block);
	}

	get actions(): BlockMenuAction[] {
		const { block, blocks } = this;
		if (!block) return [];
		const move = (direction: 'up' | 'down') => () =>
			this.edytor.canMoveBlocks({ blocks: outermost(blocks), direction });
		const [mod, shift] = this.edytor.hotKeys.isMac ? ['⌘', '⇧'] : ['Ctrl+', 'Shift+'];
		const all: BlockMenuAction[] = [
			{
				id: 'turn',
				label: 'Turn into',
				icon: 'action.turn',
				submenu: true,
				isEnabled: () => blocks.some((b) => b.convertible)
			},
			...(this.options.linkTo && blocks.length === 1
				? [
						{
							id: 'link',
							label: 'Copy link to block',
							icon: 'action.link',
							run: () => this.copyLink()
						}
					]
				: []),
			{
				id: 'duplicate',
				label: 'Duplicate',
				icon: 'action.duplicate',
				hint: `${mod}D`,
				run: () => (blocks.length > 1 ? this.duplicateAll(blocks) : this.duplicate(block))
			},
			{
				id: 'up',
				label: 'Move up',
				icon: 'action.up',
				hint: `${mod}${shift}↑`,
				isEnabled: move('up'),
				run: () => this.move('up')
			},
			{
				id: 'down',
				label: 'Move down',
				icon: 'action.down',
				hint: `${mod}${shift}↓`,
				isEnabled: move('down'),
				run: () => this.move('down')
			},
			{
				id: 'delete',
				label: 'Delete',
				icon: 'action.delete',
				hint: 'Del',
				danger: true,
				run: () => this.remove()
			}
		];
		return all.filter(
			(action) => matchesQuery(action, this.query) && action.isEnabled?.() !== false
		);
	}

	/**
	 * With a query, the kinds it names join the list (Notion's "Turn into"
	 * results), matched as the slash menu matches them (`matchesQuery`).
	 */
	get matchingKinds(): KindRow[] {
		if (!this.query.trim() || !this.blocks.some((b) => b.convertible)) return [];
		return this.kinds.filter((kind) => matchesQuery(kind, this.query));
	}

	/** Every keyboard row: actions, then the matching kinds. */
	get rows(): Array<BlockMenuAction | KindRow> {
		return [...this.actions, ...this.matchingKinds];
	}

	open(block: Block, anchor: HTMLElement) {
		const selected = getSelectedBlocksInDocumentOrder(this.edytor);
		this.blocks = selected.length > 1 && selected.includes(block) ? selected : [block];
		this.block = block;
		this.anchor = anchor;
		this.query = '';
		this.selectedIndex = 0;
		this.flyout = false;
		this.flyoutIndex = 0;
	}

	close(restoreCaret = true) {
		const blocks = this.blocks;
		this.block = null;
		this.blocks = [];
		this.anchor = null;
		this.flyout = false;
		if (restoreCaret) this.restore(blocks);
	}

	move(direction: 'up' | 'down') {
		if (!this.blocks.length) return;
		this.edytor.moveBlocks({ blocks: outermost(this.blocks), direction });
		this.close();
	}

	/**
	 * Convert the open block, or every block of the selection as one undo
	 * step (they stay selected); one block's conversion places the caret
	 * (refused: the caret returns).
	 */
	turnInto(kind: KindRow) {
		const [block, blocks] = [this.block, this.blocks];
		this.close(false);
		if (blocks.length > 1) {
			convertBlocks(this.edytor, blocks, kind);
			this.focus();
		} else if (convertToKind(this.edytor, block, kind, true)) this.focus();
		else this.caret(block);
	}

	duplicate(block: Block) {
		const copy = block.duplicateBlock();
		this.close(false);
		this.caret(copy ?? block);
	}

	/**
	 * Duplicate several blocks as one undo step, each copy after its block (a
	 * block inside another of them is copied with it); the copies are selected.
	 */
	duplicateAll(blocks: Block[]) {
		const copies = this.edytor.dispatcher.run('insertBlock', () =>
			outermost(blocks).flatMap((block) => block.duplicateBlock() ?? [])
		);
		this.close(false);
		if (copies?.length) this.edytor.selection.selectBlocks(...copies);
	}

	/**
	 * Delete the open blocks as one undo step (unselected children take their
	 * parent's place); the caret goes to the nearest text after the first,
	 * a promoted child's when it had children, else before it (refused: the
	 * caret or the selection returns).
	 */
	remove() {
		const blocks = this.blocks;
		if (!blocks.length) return;
		const skip = new Set(blocks);
		const [after, before] = [
			this.editable(blocks[0]!, 'blockAfter', 'firstEditableText', skip),
			this.editable(blocks[0]!, 'blockBefore', 'lastEditableText', skip)
		];
		this.edytor.dispatcher.run('removeBlock', () => {
			for (const block of blocks) block.removeBlock();
		});
		this.close(false);
		if (blocks.some((block) => block.isInTree)) return this.restore(blocks);
		this.edytor.dispatcher.caret(after ?? before, after ? 0 : (before?.length ?? 0));
		this.focus();
	}

	async copyLink() {
		const block = this.block;
		if (block && this.options.linkTo)
			await navigator.clipboard?.writeText(this.options.linkTo(block));
		this.close();
	}

	/** Run the keyboard row (or open the flyout). */
	runSelected() {
		const row = this.rows[this.selectedIndex];
		if (!row) return;
		if ('value' in row) return this.turnInto(row);
		if (row.submenu) [this.flyout, this.flyoutIndex] = [true, 0];
		else row.run?.();
	}

	/** Back to the blocks the menu acted on: the block selection again, or one block's caret. */
	private restore(blocks: Block[]) {
		const live = blocks.flatMap((block) => this.edytor.idToBlock.get(block.id) ?? []);
		if (live.length > 1) {
			this.edytor.selection.selectBlocks(...live);
			this.focus();
		} else if (live[0]?.node?.isConnected) this.caret(live[0]);
	}

	/**
	 * A caret at the start of `block` (of its first child when its own content
	 * is not displayed): it replaces the block selection, and the projector
	 * draws it after the flush. A block holding no text (a divider, an image)
	 * is selected instead.
	 */
	private caret(block: Block | null | undefined) {
		const text = block?.firstText ?? block?.children[0]?.firstText;
		if (text || !block?.isInTree) this.edytor.dispatcher.caret(text, 0);
		else this.edytor.selection.selectBlocks(block);
		this.focus();
	}

	/**
	 * The nearest editable text from `block` in document order once `removed`
	 * are deleted: void blocks and a closed toggle's hidden body are skipped
	 * (its header holds the caret), a removed toggle's children are not.
	 */
	private editable(
		block: Block,
		step: 'blockAfter' | 'blockBefore',
		edge: 'firstEditableText' | 'lastEditableText',
		removed: Set<Block>
	) {
		const { shown } = this.edytor.selection;
		for (let next = shown(block, step, { removed }); next; next = shown(next, step, { removed })) {
			const text = next[edge];
			if (text) return text;
		}
	}

	private focus() {
		this.edytor.node?.focus({ preventScroll: true });
	}
}
