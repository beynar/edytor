import type { Snippet } from 'svelte';
import { tick } from 'svelte';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { convertToKind, type KindRow } from '$lib/kinds.js';
import type { JSONBlock } from '$lib/utils/json.js';

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

/** A block's JSON without ids: a duplicate gets fresh ones. */
const withoutIds = ({ id: _, children, content, ...block }: JSONBlock): JSONBlock => ({
	...block,
	...(content && {
		content: content.map((part) => {
			if ('text' in part) return part;
			const { id: __, ...inline } = part as { id?: string };
			return inline as typeof part;
		})
	}),
	...(children && { children: children.map(withoutIds) })
});

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
		return this.edytor.kinds.filter((kind) => !kind.replaces);
	}

	/** The row naming the open block. */
	get currentKind(): KindRow | undefined {
		const block = this.block;
		if (!block) return undefined;
		const level = block.data?.level;
		return this.kinds.find(
			(kind) =>
				kind.value.type === block.type && (level === undefined || kind.value.data?.level === level)
		);
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
		if (restoreCaret && block?.node?.isConnected) void this.caret(block);
	}

	move(direction: 'up' | 'down') {
		const block = this.block;
		if (!block) return;
		this.edytor.moveBlocks({ blocks: [block], direction });
		this.close();
	}

	turnInto(kind: KindRow) {
		const block = this.block;
		this.close(false);
		if (block) convertToKind(this.edytor, block, kind, false);
		void this.caret(block);
	}

	duplicate(block: Block) {
		const copy = block.insertBlockAfter({ block: withoutIds(block.value) });
		this.close(false);
		void this.caret(copy ?? block);
	}

	remove() {
		const block = this.block;
		if (!block) return;
		const next = block.nextBlock ?? block.previousBlock;
		block.removeBlock();
		this.close(false);
		void this.caret(next);
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

	/** A caret at the start of `block`: clears the atomic block selection first (AGENTS). */
	private async caret(block: Block | null | undefined) {
		await tick();
		const text = block?.firstEditableText;
		if (!text) return;
		this.edytor.selection.setCollapsedStateAtTextOffset(text, 0);
		this.edytor.selection.setAtTextOffset(text, 0);
		this.edytor.node?.focus({ preventScroll: true });
	}
}
