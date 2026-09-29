import type { Snippet } from 'svelte';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { convertibleKinds, convertToKind, kindOf, type KindRow } from '$lib/kinds.js';

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
	block = $state<Block | null>(null);
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

	get kinds(): KindRow[] {
		return convertibleKinds(this.edytor);
	}

	/** The row naming the open block. */
	get currentKind(): KindRow | undefined {
		return kindOf(this.edytor, this.block);
	}

	get actions(): BlockMenuAction[] {
		const block = this.block;
		if (!block) return [];
		const move = (direction: 'up' | 'down') => () =>
			this.edytor.canMoveBlocks({ blocks: [block], direction });
		const [mod, shift] = this.edytor.hotKeys.isMac ? ['⌘', '⇧'] : ['Ctrl+', 'Shift+'];
		const all: BlockMenuAction[] = [
			{
				id: 'turn',
				label: 'Turn into',
				icon: 'action.turn',
				submenu: true,
				isEnabled: () => block.convertible
			},
			...(this.options.linkTo
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
				run: () => this.duplicate(block)
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
		const query = this.query.trim().toLowerCase();
		const matching = query
			? all.filter((action) => action.label.toLowerCase().includes(query))
			: all;
		return matching.filter((action) => action.isEnabled?.() !== false);
	}

	/** With a query, the kinds it names join the list (Notion's "Turn into" results). */
	get matchingKinds(): KindRow[] {
		const query = this.query.trim().toLowerCase();
		if (!query || !this.block?.convertible) return [];
		return this.kinds.filter((kind) =>
			[kind.label, ...(kind.keywords ?? [])].some((word) => word.toLowerCase().includes(query))
		);
	}

	/** Every keyboard row: actions, then the matching kinds. */
	get rows(): Array<BlockMenuAction | KindRow> {
		return [...this.actions, ...this.matchingKinds];
	}

	open(block: Block, anchor: HTMLElement) {
		this.block = block;
		this.anchor = anchor;
		this.query = '';
		this.selectedIndex = 0;
		this.flyout = false;
	}

	close(restoreCaret = true) {
		const block = this.block;
		this.block = null;
		this.anchor = null;
		this.flyout = false;
		if (restoreCaret && block?.node?.isConnected) this.caret(block);
	}

	move(direction: 'up' | 'down') {
		const block = this.block;
		if (!block) return;
		this.edytor.moveBlocks({ blocks: [block], direction });
		this.close();
	}

	/** Convert the open block; the conversion places the caret (refused: the caret returns). */
	turnInto(kind: KindRow) {
		const block = this.block;
		this.close(false);
		if (convertToKind(this.edytor, block, kind, true)) this.focus();
		else this.caret(block);
	}

	duplicate(block: Block) {
		const copy = block.duplicateBlock();
		this.close(false);
		this.caret(copy ?? block);
	}

	remove() {
		const block = this.block;
		if (!block) return;
		const next = block.nextBlock ?? block.previousBlock;
		block.removeBlock();
		this.close(false);
		this.caret(next);
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
		if (row.submenu) this.flyout = true;
		else row.run?.();
	}

	/**
	 * A caret at the start of `block` (of its first child when its own content
	 * is not displayed): it replaces the block selection, and the projector
	 * draws it after the flush.
	 */
	private caret(block: Block | null | undefined) {
		this.edytor.dispatcher.caret(block?.firstText ?? block?.children[0]?.firstText, 0);
		this.focus();
	}

	private focus() {
		this.edytor.node?.focus({ preventScroll: true });
	}
}
