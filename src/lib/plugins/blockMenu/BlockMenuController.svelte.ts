import type { Snippet } from 'svelte';
import { blockSelection } from '$lib/session/selection.js';
import type { Attachment } from 'svelte/attachments';
import type { EditorCommand } from '$lib/plugins.js';
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
import { blockMenuEnglish, labelsOf, type BlockMenuLabels } from '$lib/labels.js';
import { BLOCK_COLORS, colorable, setBlockColor, type BlockColorField } from '$lib/block/colors.js';
import {
	attribute,
	identify,
	keepFocus,
	optionAttributes,
	type OptionAttributes
} from '../chrome.js';
import { holdKeys, listPopup, stepRow } from '../list.svelte.js';
import { listen } from '$lib/utils/listen.js';
import { takeKeys } from '$lib/events/onFocus.js';

export type BlockMenuOptions = {
	/** A link to the block, for "Copy link to block" (the row is hidden without it). */
	linkTo?: (block: Block) => string;
	/**
	 * The menu's markup and its words; it renders while `controller.isOpen`, placed beside
	 * the handle (mark your panel `data-edytor-block-menu` for placement;
	 * without it, nothing shows).
	 * The controller runs every action; `close()` returns the caret. Keep
	 * the keyboard and the ARIA with its attachments: `{@attach
	 * controller.keys}` on the field that holds the keyboard, `{@attach
	 * controller.popup}` on the menu, `{...controller.option(index)}` on each
	 * row, `{@attach controller.flyoutMenu}` on an open flyout.
	 */
	menu?: Snippet<[BlockMenuController]>;
};

export type BlockMenuAction = {
	id: string;
	label: string;
	icon: string;
	hint?: string;
	danger?: boolean;
	/** A switch's state (a kind's row, `BlockDefinition.menu`): the row is a `menuitemcheckbox`. */
	checked?: boolean;
	/** Opens a flyout instead of running: the kinds (`turn`) or the colours (`color`). */
	submenu?: 'turn' | 'color';
	isEnabled?: () => boolean;
	run?: () => unknown;
};

/** A row of the Color flyout: a text colour or a background, `value` `null` for the default. */
export type BlockMenuColor = {
	/** `color.<name>` or `background.<name>` (`color.default`, `background.default`). */
	id: string;
	/** Its words in the view's labels (`colorText`, `colorBackground`): "Red text", "Red background", "Default text". */
	label: string;
	field: BlockColorField;
	value: (typeof BLOCK_COLORS)[number] | null;
};

/** The Color flyout's rows in `labels`: the text colours, then the backgrounds, each from the default. */
const colorRows = (labels: BlockMenuLabels): BlockMenuColor[] =>
	(['color', 'background'] as const).flatMap((field) =>
		[null, ...BLOCK_COLORS].map((value) => {
			const name = labels.colors[value ?? 'default'] ?? value ?? 'default';
			return {
				id: `${field}.${value ?? 'default'}`,
				label: field === 'color' ? labels.colorText(name) : labels.colorBackground(name),
				field,
				value
			};
		})
	);

/**
 * A colour row as a query matches it: its words, and its palette name and
 * field in English (`/red`, `background`), whatever language its label is in.
 */
export const colorQueryRow = (row: BlockMenuColor) => ({
	label: row.label,
	keywords: [row.value ?? 'default', row.field === 'color' ? 'text' : 'background']
});

/**
 * The slash menu's colour commands (`color.<name>`, `background.<name>`),
 * listed once a query names them (`searchOnly`): each paints the caret's
 * block, as the block menu's Color does (`setBlockColor`).
 */
export const colorCommands = (edytor: Edytor): EditorCommand[] =>
	colorRows(labelsOf(edytor, 'blockMenu', blockMenuEnglish)).map((row) => ({
		id: row.id,
		...colorQueryRow(row),
		icon: 'A',
		group: 'Color',
		searchOnly: true,
		isEnabled: (view = edytor) => {
			const block = view.selection.textRange().startText?.parent;
			return Boolean(block && colorable(block));
		},
		run: () => {
			const block = edytor.selection.textRange().startText?.parent;
			if (!block || !colorable(block)) return false;
			if (setBlockColor(edytor, [block], row.field, row.value)) return true;
			// Already that colour: nothing to write, the typed query still goes.
			return edytor.dispatcher.permits();
		}
	}));

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
	/** The keyboard's row. */
	index = $state(0);
	/** The open flyout: the kinds (`turn`), the colours (`color`), or none. */
	flyout = $state<false | 'turn' | 'color'>(false);
	/** The keyboard's row in the open flyout. */
	flyoutIndex = $state(0);

	/** The actions' words: the view's `blockMenu` labels. */
	readonly #labels: BlockMenuLabels;
	/** The Color flyout's rows, in those words. */
	readonly #colors: BlockMenuColor[];

	constructor(
		private edytor: Edytor,
		private options: BlockMenuOptions = {}
	) {
		this.#labels = labelsOf(edytor, 'blockMenu', blockMenuEnglish);
		this.#colors = colorRows(this.#labels);
		this.popup = listPopup(edytor, 'block-menu', 'menu', () => {
			const { block } = this;
			return block && { opener: { block: block.id, control: 'grip' } };
		});
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

	/**
	 * The menu element (`{@attach controller.popup}`, the one with the rows):
	 * it takes the menu's id, its `menu` role and name unless it has its
	 * own, keeps the focus where it is on a press (a field takes its own),
	 * and is published to the view's root (`edytor.popups`) while it is in
	 * the page, the grip that opened it told so.
	 */
	popup: Attachment<HTMLElement>;

	/**
	 * An open flyout (`{@attach controller.flyoutMenu}`, named by your
	 * markup): its id, `menu` role, the overlay's placement beside the menu,
	 * and presses that keep the focus.
	 */
	flyoutMenu: Attachment<HTMLElement> = (node) => {
		identify(node, this.flyoutId, 'menu');
		node.setAttribute('data-edytor-block-menu-flyout', '');
		return listen(node, 'mousedown', keepFocus);
	};

	/**
	 * The element that holds the keyboard (`{@attach controller.keys}`: the
	 * search field): focused when it mounts, it takes every key of the menu
	 * (the arrows, Home and End walk the rows, → opens a row's flyout and ←
	 * closes it, Enter runs the row, Delete removes the blocks while the
	 * query is empty, Escape closes the flyout, then the menu), and names
	 * the open menu and its highlighted row (`aria-controls`,
	 * `aria-activedescendant`, once that row is in the page).
	 */
	keys: Attachment<HTMLElement> = (node) => {
		$effect(() => attribute(node, 'aria-controls', this.flyout ? this.flyoutId : this.menuId));
		return holdKeys(node, this.#keydown, () => {
			const flyout = Boolean(this.flyout);
			const row = flyout ? this.flyoutRows[this.flyoutIndex] : this.rows[this.index];
			return row && this.rowId(row, flyout);
		});
	};

	/**
	 * The attributes of the row at `index` (of the open flyout's rows with
	 * `flyout`): spread them on its element (`{...controller.option(index)}`).
	 * Its id, its role (`menuitem`, a switch's `menuitemcheckbox`, a colour's
	 * `menuitemradio` with its ✓ as `aria-checked`, a flyout's opener with
	 * `aria-haspopup` and `aria-expanded`), `data-selected` for the keyboard's
	 * row, which scrolls into view.
	 */
	option = (index: number, flyout = false): OptionAttributes => {
		const row = (flyout ? this.flyoutRows : this.rows)[index];
		// Only an action has `checked` and `submenu`, only a colour `field`.
		const { checked, submenu } = (row ?? {}) as BlockMenuAction;
		const color = row && 'field' in row;
		const on = color ? this.isCurrentColor(row) : checked;
		return optionAttributes(
			row
				? this.rowId(row, flyout)
				: this.edytor.popups.idOf(`block-menu-${flyout ? 'flyout-' : ''}${index}`),
			color ? 'menuitemradio' : on === undefined ? 'menuitem' : 'menuitemcheckbox',
			(flyout ? this.flyoutIndex : this.index) === index,
			{
				...(on === undefined ? {} : { 'aria-checked': on }),
				...(submenu
					? { 'aria-haspopup': 'menu' as const, 'aria-expanded': this.flyout === submenu }
					: {})
			}
		);
	};

	/** The search field typed in: the rows match `query`, the first one highlighted, no flyout open. */
	search(query: string) {
		this.query = query;
		this.index = 0;
		this.flyout = false;
	}

	/** The menu's keys, on the element that holds the keyboard (`keys`). */
	#keydown = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.isComposing) return;
		const { key } = event;
		const { flyout, rows } = this;
		const row = rows[this.index];
		const submenu = row && 'submenu' in row ? row.submenu : undefined;
		const to = stepRow(key, this.index, rows.length, { ends: true });
		if (key === 'Escape') {
			if (flyout) this.flyout = false;
			else this.close();
		} else if (flyout && (key === 'ArrowDown' || key === 'ArrowUp'))
			// In a flyout, the arrows walk its rows.
			this.flyoutIndex = stepRow(key, this.flyoutIndex, this.flyoutRows.length)!;
		else if (flyout && key === 'Enter') this.run(this.flyoutRows[this.flyoutIndex]);
		else if (key === 'Delete' && !this.query) this.remove();
		else if (to !== undefined) {
			this.index = to;
			this.flyout = false;
		} else if (key === 'ArrowRight' && submenu) this.openFlyout(submenu);
		else if (key === 'ArrowLeft' && flyout) this.flyout = false;
		else if (key === 'Enter') this.run(row);
		else return;
		event.preventDefault();
	};

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
		return this.#colors;
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
		const { block, blocks, edytor } = this;
		const labels = this.#labels;
		if (!block) return [];
		const [mod, shift] = edytor.keymap.isMac ? ['⌘', '⇧'] : [`${labels.ctrl}+`, `${labels.shift}+`];
		/** An action row, its icon named by its id. */
		const action = (
			id: string,
			label: string,
			more: Partial<BlockMenuAction>
		): BlockMenuAction => ({
			id,
			label,
			icon: `action.${id}`,
			...more
		});
		const move = (direction: 'up' | 'down', label: string, arrow: string) =>
			action(direction, label, {
				hint: `${mod}${shift}${arrow}`,
				isEnabled: () => edytor.canMove({ blocks: outermost(blocks), direction }),
				run: () => this.move(direction)
			});
		const all: BlockMenuAction[] = [
			action('turn', labels.turnInto, {
				submenu: 'turn',
				isEnabled: () => convertedBlocks(this.members).length > 0
			}),
			action('color', labels.color, {
				submenu: 'color',
				isEnabled: () => this.colorable.length > 0
			}),
			...(this.options.linkTo && this.linked
				? [action('link', labels.copyLink, { run: () => this.copyLink() })]
				: []),
			// The kind's own rows, on its block alone (a table's rows and switches). A
			// switch keeps the menu open; any other row closes it, the caret its
			// action placed kept (else the menu's caret returns).
			...(blocks.length === 1
				? (block.definition.menu?.(block) ?? []).map((row) => ({
						...row,
						icon: row.icon ?? '',
						run:
							row.checked === undefined
								? () => {
										const before = this.edytor.selection.value;
										row.run();
										this.close(this.edytor.selection.value === before);
									}
								: row.run
					}))
				: []),
			action('duplicate', labels.duplicate, {
				hint: `${mod}D`,
				run: () => this.duplicate(blocks, blocks.length > 1)
			}),
			move('up', labels.moveUp, '↑'),
			move('down', labels.moveDown, '↓'),
			action('delete', labels.delete, {
				hint: labels.deleteKey,
				danger: true,
				run: () => this.remove()
			})
		];
		return all.filter(
			(action) => matchesQuery(action, this.query) && action.isEnabled?.() !== false
		);
	}

	/**
	 * With a query, the kinds it names join the list (Notion's "Turn into"
	 * results), matched as the slash menu matches them (`matchesQuery`).
	 */
	get #matchingKinds(): KindRow[] {
		if (!this.query.trim()) return [];
		const kinds = convertedBlocks(this.members).length
			? this.kinds
			: turnCommands(this.edytor, this.blocks);
		return kinds.filter((kind) => matchesQuery(kind, this.query));
	}

	/**
	 * With a query, the colours it names join the list after the kinds
	 * (Notion's "Color" results: `red` lists "Red text" and "Red background"),
	 * when the blocks take one (`colorable`).
	 */
	get matchingColors(): BlockMenuColor[] {
		if (!this.query.trim() || !this.colorable.length) return [];
		return this.colors.filter((row) => matchesQuery(colorQueryRow(row), this.query));
	}

	/** Every keyboard row: actions, then the matching kinds, then the matching colours. */
	get rows(): Array<BlockMenuAction | KindRow | BlockMenuColor> {
		return [...this.actions, ...this.#matchingKinds, ...this.matchingColors];
	}

	open(block: Block, anchor: HTMLElement) {
		const selected = getSelectedBlocksInDocumentOrder(this.edytor);
		this.blocks = selected.length > 1 && selected.includes(block) ? selected : [block];
		this.block = block;
		this.anchor = anchor;
		this.query = '';
		this.index = 0;
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
		this.edytor.move({ blocks: outermost(this.blocks), direction });
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
		if (live.length) this.edytor.selection.select(blockSelection(live.map((block) => block.id)));
		this.focus();
	}

	/**
	 * Duplicate `blocks` as one undo step, each copy after its block (a
	 * block inside another of them is copied with it; a vetoed one is
	 * skipped, `dispatcher.each`); the copies are selected (`select`), else
	 * the first copy takes the caret (refused: its block keeps it).
	 */
	duplicate(blocks: Block[], select: boolean) {
		const copies = this.edytor.dispatcher
			.each('duplicateBlock', outermost(blocks), (block) => this.edytor.duplicateBlock(block.id))
			.flatMap((copy) => (copy?.status === 'applied' ? copy.ids : []));
		this.close(false);
		if (!select) this.caret(this.edytor.idToBlock.get(copies[0] ?? '') ?? blocks[0]);
		else if (copies.length) this.edytor.selection.select(blockSelection(copies));
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

	/**
	 * Run a row of the menu or of its open flyout (a click; Enter runs the
	 * keyboard's): paint a colour, convert to a kind, open an action's
	 * flyout or run it.
	 */
	run(row: BlockMenuAction | KindRow | BlockMenuColor | undefined) {
		if (!row) return;
		if ('field' in row) this.paint(row);
		else if ('value' in row) this.turnInto(row);
		else if (row.submenu) this.openFlyout(row.submenu);
		else row.run?.();
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
			this.edytor.selection.select(blockSelection(live.map((block) => block.id)));
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
		else this.edytor.selection.select(blockSelection([block.id]));
		this.focus();
	}

	/** Back to the editor: its own focus, not a user gesture (as its selection writes). */
	private focus() {
		takeKeys(this.edytor);
	}
}
