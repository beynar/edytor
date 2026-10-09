import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Edytor } from '$lib/edytor.svelte.js';
import { takeKeys } from '$lib/events/onFocus.js';
import type { CodeLabels } from '$lib/labels.js';
import {
	attribute,
	inPage,
	keepFocus,
	optionAttributes,
	type MenuItemPayload,
	type OptionAttributes
} from '../chrome.js';
import { languageLabel, languageOf, type CodeSettings } from './languages.js';

/** A row of the language list: a language id and its label as shown. */
export type LanguageRow = { id: string; label: string };

/**
 * One row of the language list, for a custom `menu`: the row shape every
 * menu shares (`item` is the language, `run` picks it), and whether it is
 * the block's own language (`current`, the built-in ✓).
 */
export type LanguageMenuItem = MenuItemPayload<LanguageRow> & {
	/** It is the block's language. */
	current: boolean;
};

/** The list's box: its button's, layer-relative. */
type Box = { x: number; y: number; width: number; height: number };

/** The overlay host the list renders in (the overlay's mount names it). */
const HOST = '[data-edytor-code-language-host]';

/**
 * One view's code language list (Notion's): the header's language button
 * opens it in the overlay under the button, a search field over the
 * languages (by label or id), the block's own marked. The field holds the
 * keys: the arrows move the highlighted row, Enter picks it, Escape
 * closes. A pick writes the block's `data.language` (one `patchData`
 * command, one undo step). Opened by the keys, the list gives them back to
 * its button; opened by a press, to the editor. A press or a focus outside
 * closes it, as readonly does.
 *
 * What a custom `menu` snippet receives: the open list (`open`), the query
 * and its rows (`query`, `items`, each a `MenuItemPayload`), the keyboard's
 * row (`index`), `search`, `pick` and `close`, the plugin's `labels`, and
 * the attachments that keep the built-in keys and ARIA: `keys` on the
 * search field, `popup` on the list, `option(index)` spread on each row.
 */
export class LanguageMenu {
	/** The code block whose list is open, and whether the keys opened it (reactive). */
	open = $state.raw<{ block: string; keys: boolean } | null>(null);
	/** The search field's text. */
	query = $state('');
	/** The highlighted row, in `rows`. */
	index = $state(0);
	/**
	 * The button's box, measured in the overlay's frame.
	 * @internal
	 */
	box = $state.raw<Box | null>(null);

	/** @internal */
	constructor(
		/** @internal */
		readonly edytor: Edytor,
		/** @internal */
		readonly settings: CodeSettings
	) {}

	/** The plugin's words (`language`, `search`, `noResults`, …). */
	get labels(): CodeLabels {
		return this.settings.labels;
	}

	/** The view is readonly (reactive): the list closes. */
	get readonly(): boolean {
		return this.edytor.readonly;
	}

	/** The open block's language id. */
	get current(): string | null {
		const open = this.open;
		if (!open) return null;
		return languageOf(this.edytor.idToBlock.get(open.block)?.data, this.settings);
	}

	/** The rows the query keeps: a language the plugin does not list first (the block's own), then the list. */
	get rows(): LanguageRow[] {
		const current = this.current;
		const listed: LanguageRow[] = this.settings.languages.map((row) => ({
			id: row.id,
			label: languageLabel(row, this.settings)
		}));
		const all =
			current && !listed.some((row) => row.id === current)
				? [{ id: current, label: current }, ...listed]
				: listed;
		const query = this.query.trim().toLowerCase();
		if (!query) return all;
		return all.filter(
			(row) => row.label.toLowerCase().includes(query) || row.id.toLowerCase().includes(query)
		);
	}

	/**
	 * The rows for a custom `menu`: each the row shape every menu shares
	 * (`run` picks it, `select` highlights it, `option` its attributes), and
	 * whether it is the block's language (`current`).
	 */
	get items(): LanguageMenuItem[] {
		const current = this.current;
		return this.rows.map((row, index) => ({
			item: row,
			id: this.rowId(row),
			label: row.label,
			selected: index === this.index,
			current: row.id === current,
			run: () => this.pick(row),
			select: () => (this.index = index),
			option: this.option(index)
		}));
	}

	/** Whether `block`'s list is open. */
	isOpenFor = (block: string) => this.open?.block === block;

	/** The list's and its rows' element ids (page-unique). */
	get listId() {
		return this.edytor.popups.idOf('code-languages');
	}
	rowId = (row: LanguageRow) => this.edytor.popups.idOf(`code-language-${row.id}`);

	/**
	 * Where the list stands: under its button, layer-relative.
	 * @internal
	 */
	get place(): { left: number; top: number } | null {
		const box = this.box;
		return this.open && box ? { left: box.x, top: box.y + box.height + 4 } : null;
	}

	/** Open `block`'s list (`keys`: the keyboard opened it), or close it when it is open. */
	toggle = (block: string, keys: boolean) => {
		if (this.isOpenFor(block)) return this.close(keys ? 'button' : 'editor');
		if (!this.edytor.dispatcher.permits() || !this.edytor.idToBlock.get(block)?.isInTree) return;
		this.query = '';
		this.open = { block, keys };
		this.index = Math.max(
			0,
			this.rows.findIndex((row) => row.id === this.current)
		);
		this.edytor.overlay.invalidate();
	};

	/** A new query: the first row it keeps is highlighted. */
	search = (query: string) => {
		this.query = query;
		this.index = 0;
	};

	/** Move the highlighted row by `step`, around the ends. */
	move = (step: number) => {
		const count = this.rows.length;
		if (count) this.index = (this.index + step + count) % count;
	};

	/** Pick `row` (the highlighted one): the block's language, one undo step; the list closes. */
	pick = (row: LanguageRow | undefined = this.rows[this.index]) => {
		const open = this.open;
		if (!open || !row) return;
		const block = this.edytor.idToBlock.get(open.block);
		if (block?.isInTree && row.id !== this.current) block.data.language = row.id;
		this.close(open.keys ? 'button' : 'editor');
	};

	/**
	 * Close the list; the keys go back to its button (`button`), to the
	 * editor (`editor`: its caret where it was), or stay where a press or a
	 * focus put them (`null`).
	 */
	close = (keys: 'button' | 'editor' | null = null) => {
		const open = this.open;
		if (!open) return;
		this.open = null;
		this.box = null;
		this.query = '';
		this.edytor.overlay.invalidate();
		if (keys === 'button') this.#button(open.block)?.focus({ preventScroll: true });
		else if (keys === 'editor') {
			takeKeys(this.edytor);
			this.edytor.selection.display();
		}
	};

	/**
	 * The attributes of the row at `index`: spread them on its element
	 * (`{...menu.option(index)}`). Its id, `option` role, `aria-selected` and
	 * `data-selected` for the highlighted row, which scrolls into view.
	 */
	option = (index: number): OptionAttributes => {
		const row = this.rows[index];
		const id = row ? this.rowId(row) : this.edytor.popups.idOf(`code-language-${index}`);
		return optionAttributes(id, 'option', index === this.index);
	};

	/**
	 * The search field (`{@attach menu.keys}`): it takes the focus as the
	 * list opens and is its `combobox` (unless it has a role), naming the
	 * list and the highlighted row (`aria-controls`,
	 * `aria-activedescendant`). ArrowDown and ArrowUp move the highlighted
	 * row (around the ends), Enter picks it, Escape closes the list (the
	 * keys back to the button when they opened it, else to the editor);
	 * none reaches the editor. Focus leaving the list and its button closes
	 * it.
	 */
	keys: Attachment<HTMLElement> = (node) =>
		untrack(() => {
			if (!node.hasAttribute('role')) node.setAttribute('role', 'combobox');
			node.setAttribute('aria-expanded', 'true');
			node.setAttribute('aria-autocomplete', 'list');
			attribute(node, 'aria-controls', this.listId);
			if (!node.hasAttribute('aria-label') && !node.hasAttribute('aria-labelledby'))
				node.setAttribute('aria-label', this.labels.language);
			node.addEventListener('keydown', this.#keydown);
			node.addEventListener('focusout', this.#blurred);
			node.focus({ preventScroll: true });
			$effect(() => {
				const row = this.rows[this.index];
				attribute(node, 'aria-activedescendant', inPage(node, row && this.rowId(row)));
			});
			return () => {
				node.removeEventListener('keydown', this.#keydown);
				node.removeEventListener('focusout', this.#blurred);
			};
		});

	/** The search field's keys (`keys`). */
	#keydown = (event: KeyboardEvent) => {
		if (event.isComposing) return;
		const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[event.key];
		if (step) this.move(step);
		else if (event.key === 'Enter') this.pick();
		else if (event.key === 'Escape') this.close(this.open?.keys ? 'button' : 'editor');
		else return;
		event.preventDefault();
		event.stopPropagation();
	};

	/**
	 * The list (`{@attach menu.popup}`): its id, `listbox` role and name
	 * unless it has its own, presses that keep the field's focus, and its
	 * publication to the view's root (`edytor.popups`) while it is in the page.
	 */
	popup: Attachment<HTMLElement> = (node) =>
		untrack(() => {
			node.id = this.listId;
			if (!node.hasAttribute('role')) node.setAttribute('role', 'listbox');
			if (!node.hasAttribute('aria-label') && !node.hasAttribute('aria-labelledby'))
				node.setAttribute('aria-label', this.labels.language);
			node.addEventListener('mousedown', keepFocus);
			this.edytor.popups.set('code-languages', { id: this.listId, haspopup: 'listbox' });
			return () => {
				node.removeEventListener('mousedown', keepFocus);
				this.edytor.popups.set('code-languages', null);
			};
		});

	/**
	 * The keys back to the editor from a language button (its Escape): the
	 * host takes the focus, the caret shown where the selection is.
	 * @internal
	 */
	release = () => {
		this.close();
		const node = this.edytor.node;
		if (!node?.isConnected || this.edytor.destroyed) return;
		this.edytor.expectInternalFocus();
		node.focus({ preventScroll: true });
		this.edytor.selection.display();
	};

	/**
	 * The view turned readonly: the list closes.
	 * @internal
	 */
	lock = () => this.close();

	/**
	 * A press anywhere (capture): one outside the list and its button closes it.
	 * @internal
	 */
	pressed = (event: MouseEvent) => {
		const open = this.open;
		if (!open) return;
		const at = event.target as Element | null;
		if (at?.closest?.(HOST)) return;
		if (at instanceof Node && this.#button(open.block)?.contains(at)) return;
		this.close();
	};

	/** Focus left the field for somewhere outside the list and its button: it closes. */
	#blurred = (event: FocusEvent) => {
		const open = this.open;
		const to = event.relatedTarget;
		// No new focus (the window went to the background): it stays.
		if (!open || !(to instanceof Node)) return;
		const host = (event.currentTarget as Element | null)?.closest(HOST);
		if (host?.contains(to) || this.#button(open.block)?.contains(to)) return;
		this.close();
	};

	/**
	 * The language button of the code block holding a caret (where Alt+F10
	 * takes the keys, as to a toolbar), if any.
	 * @internal
	 */
	buttonAtCaret = (): HTMLElement | null => {
		const { startBlock, isCollapsed } = this.edytor.selection.state;
		const code = startBlock?.type === 'codeLine' ? startBlock.parent : null;
		if (!isCollapsed || !code || this.edytor.readonly) return null;
		return this.#button(code.id);
	};

	/**
	 * The overlay measure: the button's box; gone, the list closes.
	 * @internal
	 */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const open = this.open;
		const button = open ? this.#button(open.block) : null;
		const rect = button?.isConnected ? button.getBoundingClientRect() : null;
		const box = rect
			? {
					x: rect.left - origin.left,
					y: rect.top - origin.top,
					width: rect.width,
					height: rect.height
				}
			: null;
		return () => {
			Object.assign(host.style, { position: 'absolute', left: '0px', top: '0px' });
			if (open && !button) return this.close();
			const known = this.box;
			if (
				!known ||
				!box ||
				known.x !== box.x ||
				known.y !== box.y ||
				known.width !== box.width ||
				known.height !== box.height
			)
				this.box = box;
		};
	};

	/** The language button of code block `block`, in this view (the header's `button` attachment marks it). */
	#button = (block: string) =>
		this.edytor.idToBlock
			.get(block)
			?.node?.querySelector<HTMLElement>('[data-edytor-code-language-button]') ?? null;
}

/** Each view's language list (the first code plugin listed owns it). */
export const languageMenus = new WeakMap<Edytor, LanguageMenu>();
