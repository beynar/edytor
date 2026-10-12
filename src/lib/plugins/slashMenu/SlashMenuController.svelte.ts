import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Block } from '$lib/block/block.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EditorCommand } from '$lib/plugins.js';
import { noSelection, project, type SelectionValue } from '$lib/session/selection.js';
import { BASIC_BLOCKS, matchesQuery } from '$lib/kinds.js';
import type { BlockAddition } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { TextTriggerController } from '$lib/plugins/triggers/TriggerController.svelte.js';
import type { Popup } from '$lib/surface/popups.svelte.js';
import { attribute, isField, keepFocus } from '../chrome.js';
import { holdKeys } from '../list.svelte.js';
import { all, listen } from '$lib/utils/listen.js';

/**
 * The view a `+`'s menu asks `isEnabled` of: the editor, its selection a
 * caret at the start of the block the `+` adds, below `block` (a stand-in
 * over `block`: an empty block of the parent's default kind, at the next
 * index, since it does not exist yet), or `block` itself when the `+`
 * reuses it (already an empty block of that kind). Nothing is written.
 */
const additionView = (edytor: Edytor, { block }: BlockAddition): Edytor => {
	const type = block.parent && edytor.defaultChild(block.parent);
	const reused = block.type === type && block.isEmpty;
	const index = block.index + 1;
	const stand: Record<PropertyKey, unknown> = {
		id: '',
		type,
		index,
		path: [...block.path.slice(0, -1), index],
		data: {},
		content: [],
		children: [],
		hasChildren: false,
		isEmpty: true,
		node: undefined,
		firstText: undefined,
		lastText: undefined,
		movable: true,
		convertible: true
	};
	const through = <T extends object>(target: T, own: Record<PropertyKey, unknown>): T =>
		new Proxy(target, {
			get: (object, key) => {
				if (key in own) return own[key];
				const value = Reflect.get(object, key, object);
				return typeof value === 'function' ? value.bind(object) : value;
			}
		});
	const added = reused ? block : through(block, stand);
	// A caret at the added block's start (a stand-in text when it is not made yet).
	const text = added.firstText ?? ({ parent: added } as Text);
	const range = { startText: text, endText: text, yStart: 0, yEnd: 0, texts: [text] };
	const selection = through(edytor.selection, {
		textRange: () => range,
		caret: { block: added, offset: 0 },
		voidField: false,
		value: noSelection,
		projection: project(noSelection, edytor.facade),

		selectedBlocks: new Set(),
		selectedInlineBlock: new Set()
	});
	return through(edytor, { selection });
};

/**
 * The slash menu: the `/` trigger (`TextTriggerController`: the range, the
 * query, the keys, the pick), whose rows are the editor's commands, and the
 * menu a handle's `+` opens with a search field of its own (`addition`).
 */
export class SlashMenuController extends TextTriggerController {
	/**
	 * Opened by a handle's `+` (`BLOCK_ADD_EVENT`): no `/` in the text, the
	 * query is the menu's own field, and a picked row adds the block first.
	 */
	addition = $state<BlockAddition | null>(null);
	/** The selection when a `+` opened the menu, given back when it closes unpicked. */
	private held: SelectionValue = { kind: 'none' };

	constructor(edytor: Edytor) {
		super(edytor, '/', 'slash-menu');
	}

	/** A `+`'s menu names its highlighted row from its own field, and tells the `+` it opened it. */
	protected popupOf(active: string | undefined): Popup {
		const { addition } = this;
		return addition
			? {
					id: this.listId,
					haspopup: 'listbox',
					opener: { block: addition.block.id, control: 'add' }
				}
			: { id: this.listId, haspopup: 'listbox', active };
	}

	/**
	 * The element that holds a `+` menu's keyboard (`{@attach controller.keys}`:
	 * its field, or the menu element itself). Focused when
	 * it mounts, it takes the menu's keys (↑/↓ walk the rows, Enter runs the
	 * highlighted one, Escape closes the menu and gives the selection back);
	 * on an element that is not a field, typing and Backspace edit the query.
	 * A field takes the keys of the whole menu, names the list and its highlighted row (`aria-controls`,
	 * `aria-activedescendant`), and takes the focus back from any other part
	 * of the menu (a row a click or a screen reader focused, which becomes
	 * the highlighted one). Focus leaving the menu closes it. A `/` menu
	 * leaves the keys to the editor: there it does nothing.
	 */
	keys: Attachment<HTMLElement> = (node) => {
		if (!untrack(() => this.addition)) return;
		const menu = node.closest<HTMLElement>('[data-edytor-slash-menu-host]') ?? node;
		const field = isField(node);
		const keydown = (event: KeyboardEvent) => {
			// A key that ends an IME composition (Enter commits it, Escape cancels it) is the IME's.
			if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
			const { key, ctrlKey, metaKey } = event;
			const move = { ArrowDown: 1, ArrowUp: -1 }[key];
			const typed = !field && event.target === node;
			if (typed && key === 'Backspace') this.search(this.query.slice(0, -1));
			else if (typed && key.length === 1 && !ctrlKey && !metaKey) this.search(this.query + key);
			else if (move) this.move(move);
			else if (key === 'Enter') void this.runSelected();
			else if (key === 'Escape') this.dismiss();
			else return;
			event.preventDefault();
		};
		const focusin = (event: FocusEvent) => {
			const target = event.target as HTMLElement;
			if (!field || target === node) return;
			const index = this.commands.findIndex(
				(_, index) => target.closest?.(`[id="${this.rowId(index)}"]`) !== null
			);
			if (index !== -1) this.index = index;
			node.focus({ preventScroll: true });
		};
		const focusout = (event: FocusEvent) => {
			const to = event.relatedTarget;
			if (this.addition && to instanceof Node && !menu.contains(to)) this.dismiss(false);
		};
		const off2 = listen(menu, 'focusin', focusin);
		const off3 = listen(menu, 'focusout', focusout);
		const off4 = listen(menu, 'mousedown', keepFocus);
		if (field) attribute(node, 'aria-controls', this.listId);
		// A field takes the keys of the whole menu (a row a screen reader focused); a wrapper, its own.
		const off = holdKeys(
			node,
			keydown,
			() => (field && this.count ? this.rowId(this.index) : undefined),
			field ? menu : node
		);
		return all(off, off2, off3, off4);
	};

	protected get count() {
		return this.isOpen ? this.commands.length : 0;
	}

	/** A `/` opens the menu in a block a kind can replace (`convertible`). */
	protected admits(block: Block) {
		return block.convertible;
	}

	/**
	 * A query no command matches is prose (a URL, a path), and so is one
	 * that opens with whitespace (`yes / no`) or holds only hyphens (`/-`):
	 * the menu closes. Words after a space keep it open (`/to do`).
	 */
	protected queried(query: string) {
		const commandCount = this.commands.length;
		if (query && (commandCount === 0 || /^\s/.test(query) || !/[^-\s]/.test(query))) this.close();
		else this.index = Math.max(0, Math.min(this.index, commandCount - 1));
	}

	/** Matching commands, grouped (groups in first-seen order): the menu's rows and keyboard order. */
	get commands() {
		// A `+`'s rows are the commands that can run in the block it adds.
		const queried = Boolean(this.query.trim());
		const matching = Array.from(this.edytor.commands.values()).filter(
			(command) =>
				(queried || !command.searchOnly) &&
				this.enabled(command) &&
				matchesQuery(command, this.query)
		);
		// Groups in first-seen order, Notion's "Basic blocks" first.
		const groups = [...new Set(matching.map((command) => command.group ?? ''))].sort(
			(a, b) => Number(b === BASIC_BLOCKS) - Number(a === BASIC_BLOCKS)
		);
		return matching.sort((a, b) => groups.indexOf(a.group ?? '') - groups.indexOf(b.group ?? ''));
	}

	/**
	 * Whether `command` can run here: in a `+`'s menu, in the block it adds
	 * (`additionView`; an `isEnabled` that throws on that stand-in does not).
	 */
	private enabled(command: EditorCommand) {
		if (!this.addition) return command.isEnabled?.(this.edytor) !== false;
		try {
			return command.isEnabled?.(additionView(this.edytor, this.addition)) !== false;
		} catch {
			return false;
		}
	}

	close() {
		super.close();
		this.addition = null;
	}

	/** Open for a `+`: nothing is added until a row is picked. */
	offer(addition: BlockAddition) {
		this.close();
		[this.addition, this.isOpen] = [addition, true];
		this.held = this.edytor.selection.value;
	}

	/** The `+`'s menu typed in its own field (a query that matches nothing shows "No results"). */
	search(query: string) {
		[this.query, this.index] = [query, 0];
	}

	/**
	 * Close without picking. A `+`'s menu gives the selection back as it was
	 * and, with `focus` (Escape, the footer), the editor its focus; a press
	 * outside, focus moving away or readonly leave the focus where it went.
	 */
	dismiss(focus = true) {
		const { addition, held } = this;
		this.close();
		if (!addition) return;
		// A held place a delete removed (a peer's) gives way to the repaired selection.
		if (held.kind === 'none' || project(held, this.edytor.facade).start)
			this.edytor.selection.select(held);
		if (!focus || this.edytor.readonly) return;
		this.edytor.expectInternalFocus();
		this.edytor.node?.focus({ preventScroll: true });
	}

	runSelected() {
		return this.run(this.commands[this.index]);
	}

	async run(command: EditorCommand | undefined) {
		const { addition } = this;
		if (addition && command) {
			// One that cannot run in the block to add adds nothing (its row is not listed).
			if (!this.enabled(command)) return false;
			this.close();
			// Disabled once the block is added: the addition is taken back.
			const then = () =>
				command.isEnabled?.(this.edytor) !== false && this.edytor.runCommand(command.id);
			return (await addition.insert(then)) === true;
		}
		if (!this.range || !command) return false;
		// The trigger's removal leads the command's first operation (one plan:
		// refusing the command keeps the trigger); a command that plans
		// nothing synchronously runs after it. The caret goes back to where the
		// `/` was while it is still in its text: commands that replace the
		// block (Code, a divider) keep their own.
		const ran = await this.replaceTrigger(
			() => this.edytor.runCommand(command.id),
			(text) => this.edytor.selection.textRange().startText === text
		);
		return ran ?? false;
	}
}
