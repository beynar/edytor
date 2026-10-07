/**
 * The chrome popups open on a view (WU-27, F7): one record per owner (a
 * menu, the toolbar), published by the component that renders the popup
 * once its markup is in the page (so every IDREF names an element) and
 * withdrawn when it closes. The view's root reads the newest (`current`):
 * `aria-controls` and `aria-haspopup`, `aria-activedescendant` when the root
 * holds the keyboard (the `/` menu), `aria-keyshortcuts` for the keys that
 * reach it. A handle's control reads `openedBy` for its `aria-expanded`.
 * The root is a textbox, which takes no `aria-expanded` (WAI-ARIA 1.2): the
 * control that opened a popup carries it, and a field holding the keyboard
 * inside a popup names its rows itself.
 */
import { untrack } from 'svelte';

/** A handle control that opens a popup: its `+` or its grip. */
export type PopupOpener = { block: string; control: 'add' | 'grip' };

export type Popup = {
	/** The popup element's id. */
	id: string;
	/** What it is, for `aria-haspopup` (none for a toolbar). */
	haspopup?: 'listbox' | 'menu' | 'dialog';
	/** Its highlighted row's id, when the root holds the keyboard. */
	active?: string;
	/** The keys that move the focus from the root into it (`aria-keyshortcuts`). */
	keys?: string;
	/** The handle control that opened it. */
	opener?: PopupOpener;
};

let views = 0;

export class Popups {
	/** Page-unique: two views on a page never share an id. */
	readonly #prefix = `edytor-${++views}`;
	#open = $state.raw<ReadonlyArray<readonly [owner: string, popup: Popup]>>([]);

	/** This view's element id for `name` (any string: what an IDREF cannot hold is replaced). */
	idOf = (name: string) => `${this.#prefix}-${name.replace(/[^\w-]/g, '_')}`;

	/** Publish `owner`'s popup, or withdraw it with `null`. */
	set = (owner: string, popup: Popup | null) => {
		const rest = untrack(() => this.#open).filter(([name]) => name !== owner);
		this.#open = popup ? [...rest, [owner, popup]] : rest;
	};

	/** The newest popup open, if any (reactive). */
	get current(): Popup | undefined {
		return this.#open.at(-1)?.[1];
	}

	/** The popup the handle `control` of `block` opened, if one is open (reactive). */
	openedBy = (block: string, control: PopupOpener['control']): Popup | undefined =>
		this.#open.find(([, { opener }]) => opener?.block === block && opener.control === control)?.[1];
}
