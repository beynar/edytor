import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Edytor } from '$lib/edytor.svelte.js';
import { takeKeys } from '$lib/events/onFocus.js';
import type { CodeLabels } from '$lib/labels.js';
import {
	attribute,
	optionAttributes,
	type MenuItemPayload,
	type OptionAttributes
} from '../chrome.js';
import { holdKeys, listPopup } from '../list.svelte.js';
import { Anchored } from '../anchored.svelte.js';
import { labeledLanguages, languageOf, type CodeSettings } from './languages.js';

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
	 * The list's panel under its button: its place, and what closes it.
	 * @internal
	 */
	readonly panel: Anchored;

	/** @internal */
	constructor(
		/** @internal */
		readonly edytor: Edytor,
		/** @internal */
		readonly settings: CodeSettings
	) {
		this.popup = listPopup(edytor, 'code-languages', 'listbox', () => this.labels.language);
		this.panel = new Anchored(
			edytor,
			'edytor-code-language-host',
			() => (this.open ? this.#button(this.open.block) : undefined),
			() => this.close()
		);
	}

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
		const listed = labeledLanguages(this.settings);
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
		return this.rows.map((row, index) => {
			const id = this.rowId(row);
			const selected = index === this.index;
			return {
				item: row,
				id,
				label: row.label,
				selected,
				current: row.id === current,
				run: () => this.pick(row),
				select: () => (this.index = index),
				option: optionAttributes(id, 'option', selected)
			};
		});
	}

	/** Whether `block`'s list is open. */
	isOpenFor = (block: string) => this.open?.block === block;

	/** The list's and its rows' element ids (page-unique). */
	get listId() {
		return this.edytor.popups.idOf('code-languages');
	}
	rowId = (row: LanguageRow) => this.edytor.popups.idOf(`code-language-${row.id}`);

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
		this.panel.box = null;
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
			node.addEventListener('focusout', this.panel.blurred);
			const off = holdKeys(node, this.#keydown, () => {
				const row = this.rows[this.index];
				return row && this.rowId(row);
			});
			return () => {
				off();
				node.removeEventListener('focusout', this.panel.blurred);
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
	popup: Attachment<HTMLElement>;

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
	 * The language button of the code block holding a caret (where Alt+F10
	 * takes the keys, as to a toolbar), if any.
	 * @internal
	 */
	buttonAtCaret = (): HTMLElement | null => {
		const { startText } = this.edytor.selection.textRange();
		const { isCollapsed } = this.edytor.selection.projection;
		const startBlock = startText?.parent;
		const code = startBlock?.type === 'codeLine' ? startBlock.parent : null;
		if (!isCollapsed || !code || this.edytor.readonly) return null;
		return this.#button(code.id);
	};

	/** The language button of code block `block`, in this view (the header's `button` attachment marks it). */
	#button = (block: string) =>
		this.edytor.idToBlock
			.get(block)
			?.node?.querySelector<HTMLElement>('[data-edytor-code-language-button]') ?? null;
}

/** Each view's language list (the first code plugin listed owns it). */
export const languageMenus = new WeakMap<Edytor, LanguageMenu>();
