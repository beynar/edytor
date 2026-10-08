import type { Snippet } from 'svelte';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	convertBlocks,
	convertedBlocks,
	convertibleKinds,
	convertToKind,
	matchesQuery,
	rowOf,
	turnCommands,
	type KindRow
} from '$lib/kinds.js';
import {
	deleteSelectedBlocks,
	getSelectedBlocksInDocumentOrder,
	liftLayouts,
	outermost,
	shownText
} from '$lib/selection/replaceSelection.js';
import { selectedMembers } from '$lib/selection/visibility.js';
import type { Popup } from '$lib/surface/popups.svelte.js';
import { labelsWith, type BlockMenuLabels, type PartialLabels } from '$lib/labels.js';
import { BLOCK_COLORS, colorable, setBlockColor, type BlockColorField } from '$lib/block/colors.js';

export type BlockMenuOptions = {
	/** A link to the block, for "Copy link to block" (the row is hidden without it). */
	linkTo?: (block: Block) => string;
	/**
	 * Replace the menu; it renders while `controller.isOpen`, placed beside
	 * the handle (mark your panel `data-edytor-block-menu` for placement).
	 * The controller runs every action; `close()` returns the caret.
	 */
	menu?: Snippet<[BlockMenuController]>;
	/** The words the menu shows (its actions, search field, headings), over the English ones. */
	labels?: PartialLabels<'blockMenu'>;
};

export type BlockMenuAction = {
	id: string;
	label: string;
	icon: string;
	hint?: string;
	danger?: boolean;
	/** Opens a flyout instead of running: the kinds (`turn`) or the colours (`color`). */
	submenu?: 'turn' | 'color';
	isEnabled?: () => boolean;
	run?: () => unknown;
};

/** A row of the Color flyout: a text colour or a background, `value` `null` for the default. */
export type BlockMenuColor = {
	/** `color.<name>` or `background.<name>` (`color.default`, `background.default`). */
	id: string;
	/** Notion's label: "Red text", "Red background", "Default text". */
	label: string;
	field: BlockColorField;
	value: (typeof BLOCK_COLORS)[number] | null;
};

const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The Color flyout's rows: the text colours, then the backgrounds, each from the default. */
const COLOR_ROWS: BlockMenuColor[] = (['color', 'background'] as const).flatMap((field) =>
	[null, ...BLOCK_COLORS].map((value) => ({
		id: `${field}.${value ?? 'default'}`,
		label: `${capital(value ?? 'default')} ${field === 'color' ? 'text' : 'background'}`,
		field,
		value
	}))
);

export class BlockMenuController {
	/** The block whose grip opened the menu. */
	block = $state<Block | null>(null);
	/**
	 * The blocks the actions apply to, in document order: the block selection
	 * when it holds `block` (Notion), else `block` alone — as clicked, so a
	 * grip-selected list is one block (Move, Duplicate, Copy link, the caret
	 * after). Delete and Turn into act on their `members`, its items too.
	 */
	blocks = $state<Block[]>([]);
	anchor: HTMLElement | null = null;
	query = $state('');
	selectedIndex = $state(0);
	/** The open flyout: the kinds (`turn`), the colours (`color`), or none. */
	flyout = $state<false | 'turn' | 'color'>(false);
	/** The keyboard's row in the open flyout. */
	flyoutIndex = $state(0);

	/** The words the menu shows (the plugin's `labels`): read them in a custom `menu`. */
	readonly labels: BlockMenuLabels;

	constructor(
		private edytor: Edytor,
		private options: BlockMenuOptions = {}
	) {
		this.labels = labelsWith('blockMenu', options.labels);
	}

	get isOpen() {
		return this.block !== null;
	}

	/** The editor is readonly: the menu closes. */
	get readonly() {
		return this.edytor.readonly;
	}

	/** The menu's and the Turn into flyout's element ids (page-unique), for `aria-controls`. */
	get menuId() {
		return this.edytor.popups.idOf('block-menu');
	}
	get flyoutId() {
		return this.edytor.popups.idOf('block-menu-flyout');
	}

	/** A row's element id (page-unique; a flyout's with `flyout`), for `aria-activedescendant`. */
	rowId = (row: BlockMenuAction | KindRow | BlockMenuColor, flyout = false) =>
		this.edytor.popups.idOf(
			`block-menu-${flyout ? 'flyout-' : ''}${'field' in row ? 'color-' : 'value' in row ? 'kind-' : ''}${row.id}`
		);

	/** Publish the open menu to the view's root (`edytor.popups`), or withdraw it with `null`. */
	publish = (popup: Popup | null) => this.edytor.popups.set('block-menu', popup);

	/** What Delete and Turn into act on: `blocks`, a list or a code block with its subtree (`selectedMembers`). */
	get members(): Block[] {
		return selectedMembers(this.edytor, this.blocks);
	}

	/** The Turn into rows: the kinds, then the commands that turn `blocks` into something (`turnCommands`). */
	get kinds(): KindRow[] {
		return [...convertibleKinds(this.edytor), ...turnCommands(this.edytor, this.blocks)];
	}

	/** The blocks the Color flyout paints: the `members` that take a colour (`colorable`). */
	get colorable(): Block[] {
		return this.members.filter(colorable);
	}

	/** The Color flyout's rows: Notion's text colours, then its backgrounds. */
	get colors(): BlockMenuColor[] {
		return COLOR_ROWS;
	}

	/** Whether every block the flyout paints holds `row`'s colour (its ✓). */
	isCurrentColor = (row: BlockMenuColor) => {
		const blocks = this.colorable;
		return (
			blocks.length > 0 &&
			blocks.every(
				(block) => (this.edytor.facade.blockDataOf(block.id)?.[row.field] ?? null) === row.value
			)
		);
	};

	/** The rows of the open flyout. */
	get flyoutRows(): Array<KindRow | BlockMenuColor> {
		return this.flyout === 'color' ? this.colors : this.flyout === 'turn' ? this.kinds : [];
	}

	/** The row naming the open block. */
	get currentKind(): KindRow | undefined {
		return rowOf(this.edytor, this.block);
	}

	get actions(): BlockMenuAction[] {
		const { block, blocks } = this;
		if (!block) return [];
		const canMove = (direction: 'up' | 'down') => () =>
			this.edytor.canMoveBlocks({ blocks: outermost(blocks), direction });
		const { labels } = this;
		const [mod, shift] = this.edytor.keymap.isMac
			? ['⌘', '⇧']
			: [`${labels.ctrl}+`, `${labels.shift}+`];
		const all: BlockMenuAction[] = [
			{
				id: 'turn',
				label: labels.turnInto,
				icon: 'action.turn',
				submenu: 'turn',
				isEnabled: () => convertedBlocks(this.members).length > 0
			},
			{
				id: 'color',
				label: 'Color',
				icon: 'action.color',
				submenu: 'color',
				isEnabled: () => this.colorable.length > 0
			},
			...(this.options.linkTo && this.linked
				? [
						{
							id: 'link',
							label: labels.copyLink,
							icon: 'action.link',
							run: () => this.copyLink()
						}
					]
				: []),
			{
				id: 'duplicate',
				label: labels.duplicate,
				icon: 'action.duplicate',
				hint: `${mod}D`,
				run: () => (blocks.length > 1 ? this.duplicateAll(blocks) : this.duplicate(block))
			},
			{
				id: 'up',
				label: labels.moveUp,
				icon: 'action.up',
				hint: `${mod}${shift}↑`,
				isEnabled: canMove('up'),
				run: () => this.move('up')
			},
			{
				id: 'down',
				label: labels.moveDown,
				icon: 'action.down',
				hint: `${mod}${shift}↓`,
				isEnabled: canMove('down'),
				run: () => this.move('down')
			},
			{
				id: 'delete',
				label: labels.delete,
				icon: 'action.delete',
				hint: labels.deleteKey,
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
		if (!this.query.trim()) return [];
		if (!convertedBlocks(this.members).length)
			return turnCommands(this.edytor, this.blocks).filter((kind) =>
				matchesQuery(kind, this.query)
			);
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
	 * Convert the open block, or every member (a list's items) as one undo
	 * step (they stay selected); one block's conversion places the caret
	 * (refused: the caret returns).
	 */
	turnInto(kind: KindRow) {
		const { block, members } = this;
		this.close(false);
		if (kind.command) {
			void kind.command.run(this.edytor);
			this.focus();
		} else if (members.length > 1) {
			convertBlocks(this.edytor, members, kind);
			this.focus();
		} else if (convertToKind(this.edytor, block, kind, true)) this.focus();
		else this.caret(block);
	}

	/**
	 * Paint the open blocks (`colorable`, a list's items too) with `row`'s
	 * colour or background as one undo step (`setBlockColor`); the menu
	 * closes and the blocks stay selected, as in Notion.
	 */
	paint(row: BlockMenuColor) {
		const { blocks } = this;
		const painted = this.colorable;
		this.close(false);
		setBlockColor(this.edytor, painted, row.field, row.value);
		const live = blocks.flatMap((block) => this.edytor.idToBlock.get(block.id) ?? []);
		if (live.length) this.edytor.selection.selectBlocks(...live);
		this.focus();
	}

	duplicate(block: Block) {
		const copy = block.duplicateBlock();
		this.close(false);
		this.caret(copy ?? block);
	}

	/**
	 * Duplicate several blocks as one undo step, each copy after its block (a
	 * block inside another of them is copied with it; a vetoed one is skipped,
	 * `dispatcher.each`); the copies are selected.
	 */
	duplicateAll(blocks: Block[]) {
		const copies = this.edytor.dispatcher
			.each('insertBlock', outermost(blocks), (block) => block.duplicateBlock())
			.filter((copy) => copy != null);
		this.close(false);
		if (copies.length) this.edytor.selection.selectBlocks(...copies);
	}

	/**
	 * Delete the open blocks' `members` (a list with its items) as the
	 * keyboard's block delete does (`deleteSelectedBlocks`):
	 * `onDeleteSelectedBlocks` may keep them, then
	 * one command (`deleteBlocks`, one plan, so a veto keeps them all),
	 * unselected children taking their parent's place, the caret where that
	 * delete puts it (kept or refused: the caret or the selection returns).
	 */
	remove() {
		const { blocks } = this;
		if (!blocks.length) return;
		deleteSelectedBlocks(this.edytor, this.members);
		this.close(false);
		if (blocks.some((block) => block.isInTree)) return this.restore(blocks);
		this.focus();
	}

	/**
	 * The one block "Copy link" names: the open block, or the layout its
	 * block selection covers whole (`liftLayouts`); none for several.
	 */
	get linked(): Block | undefined {
		const [only, ...rest] = this.blocks.length > 1 ? liftLayouts(this.blocks) : this.blocks;
		return rest.length ? undefined : only;
	}

	async copyLink() {
		const { linked, options } = this;
		if (linked && options.linkTo) await navigator.clipboard?.writeText(options.linkTo(linked));
		this.close();
	}

	/** Run the keyboard row (or open its flyout). */
	runSelected() {
		const row = this.rows[this.selectedIndex];
		if (!row) return;
		if ('value' in row) return this.turnInto(row);
		if (row.submenu) this.openFlyout(row.submenu);
		else row.run?.();
	}

	/** Run the open flyout's keyboard row: convert to its kind, or paint its colour. */
	runFlyout() {
		const row = this.flyoutRows[this.flyoutIndex];
		if (!row) return;
		if ('field' in row) this.paint(row);
		else this.turnInto(row);
	}

	/**
	 * Open a flyout on its first row (keyboard or mouse): the "Turn into"
	 * kinds (default) or the colours; that flyout already open stays as it
	 * is. The overlay places it within the viewport.
	 */
	openFlyout(which: 'turn' | 'color' = 'turn') {
		if (this.flyout === which) return;
		[this.flyout, this.flyoutIndex] = [which, 0];
		this.edytor.overlay.invalidate();
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
	 * A caret at the start of `block`'s first shown line (`shownText`: a
	 * list's first item): it replaces the block selection, and the projector
	 * draws it after the flush. A block holding no text (a divider) is
	 * selected instead.
	 */
	private caret(block: Block | null | undefined) {
		const text = block && shownText(block, 'first');
		if (text || !block?.isInTree) this.edytor.dispatcher.caret(text, 0);
		else this.edytor.selection.selectBlocks(block);
		this.focus();
	}

	/** Back to the editor: its own focus, not a user gesture (as its selection writes). */
	private focus() {
		this.edytor.expectInternalFocus();
		this.edytor.node?.focus({ preventScroll: true });
	}
}
