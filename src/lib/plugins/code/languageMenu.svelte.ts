import type { Edytor } from '$lib/edytor.svelte.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { languageLabel, languageOf, type CodeSettings } from './languages.js';

/** A row of the language list: a language id and its label as shown. */
export type LanguageRow = { id: string; label: string };

/** The list's box: its button's, layer-relative. */
type Box = { x: number; y: number; width: number; height: number };

/**
 * One view's code language list (Notion's): the header's language button
 * opens it in the overlay under the button, a search field over the
 * languages (by label or id), the block's own marked. The field holds the
 * keys: the arrows move the highlighted row, Enter picks it, Escape
 * closes. A pick writes the block's `data.language` (one `patchData`
 * command, one undo step). Opened by the keys, the list gives them back to
 * its button; opened by a press, to the editor. A press or a focus outside
 * closes it, as readonly does.
 */
export class LanguageMenu {
	/** The code block whose list is open, and whether the keys opened it (reactive). */
	open = $state.raw<{ block: string; keys: boolean } | null>(null);
	/** The search field's text. */
	query = $state('');
	/** The highlighted row, in `rows`. */
	index = $state(0);
	/** The button's box, measured in the overlay's frame. */
	box = $state.raw<Box | null>(null);

	constructor(
		readonly edytor: Edytor,
		readonly settings: CodeSettings
	) {}

	get labels() {
		return this.settings.labels;
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
	 * The keys back to the editor from a language button (its Escape): the
	 * host takes the focus, the caret shown where the selection is.
	 */
	release = () => {
		this.close();
		const node = this.edytor.node;
		if (!node?.isConnected || this.edytor.destroyed) return;
		this.edytor.expectInternalFocus();
		node.focus({ preventScroll: true });
		this.edytor.selection.display();
	};

	/** The view turned readonly: the list closes. */
	lock = () => this.close();

	/** A press anywhere (capture): one outside the list and its button closes it. */
	pressed = (event: MouseEvent) => {
		const open = this.open;
		if (!open) return;
		const at = event.target as Element | null;
		if (at?.closest?.('[data-edytor-code-language-menu]')) return;
		if (at instanceof Node && this.#button(open.block)?.contains(at)) return;
		this.close();
	};

	/** Focus left the field for somewhere outside the list and its button: it closes. */
	blurred = (event: FocusEvent) => {
		const open = this.open;
		const to = event.relatedTarget;
		// No new focus (the window went to the background): it stays.
		if (!open || !(to instanceof Node)) return;
		const panel = (event.currentTarget as Element | null)?.closest(
			'[data-edytor-code-language-menu]'
		);
		if (panel?.contains(to) || this.#button(open.block)?.contains(to)) return;
		this.close();
	};

	/**
	 * The language button of the code block holding a caret (where Alt+F10
	 * takes the keys, as to a toolbar), if any.
	 */
	buttonAtCaret = (): HTMLButtonElement | null => {
		const { startBlock, isCollapsed } = this.edytor.selection.state;
		const code = startBlock?.type === 'codeLine' ? startBlock.parent : null;
		if (!isCollapsed || !code || this.edytor.readonly) return null;
		return this.#button(code.id);
	};

	/** The overlay measure: the button's box; gone, the list closes. */
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

	/** The language button of code block `block`, in this view. */
	#button = (block: string) =>
		this.edytor.idToBlock
			.get(block)
			?.node?.querySelector<HTMLButtonElement>('button[data-edytor-code-language]') ?? null;
}

/** Each view's language list (the first code plugin listed owns it). */
export const languageMenus = new WeakMap<Edytor, LanguageMenu>();
