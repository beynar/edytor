/**
 * What every chrome surface shares with the markup that renders it, the
 * built-in one and a snippet's alike: the row payload of an `item` snippet,
 * a row's attributes (`option(index)`), and the small DOM rules the
 * controllers' attachments apply (a press that keeps the focus, an
 * element given its id, role and name).
 */
import { createAttachmentKey, type Attachment } from 'svelte/attachments';

/**
 * One row of a chrome list, for an `item` snippet: the same shape in every
 * menu (the slash menu's, a trigger's, the version history's).
 */
export type MenuItemPayload<T> = {
	/** What the row stands for: a command, a trigger's row, a version. */
	item: T;
	/** The row's element id (page-unique): the keyboard's owner names the highlighted row by it. */
	id: string;
	/** The row's words. */
	label: string;
	/** It is the keyboard's row. */
	selected: boolean;
	/** Run it (pick the row). */
	run: () => void;
	/** Make it the keyboard's row (hover). */
	select: () => void;
	/**
	 * The row's attributes: spread them on its element (`{...option}`). Its
	 * `id`, `role`, `aria-selected` (or `aria-checked`), `tabindex`,
	 * `data-selected`, and an attachment that scrolls the keyboard's row
	 * into view.
	 */
	option: OptionAttributes;
};

/** A row's attributes (`controller.option(index)`, `item.option`): spread them on the row. */
export type OptionAttributes = {
	id: string;
	role: 'option' | 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
	/** `-1` where a field or the editor holds the keyboard; a roving list's own row `0`. */
	tabindex: 0 | -1;
	'aria-selected'?: boolean;
	'aria-checked'?: boolean;
	'aria-haspopup'?: 'menu';
	'aria-expanded'?: boolean;
	'data-selected': boolean;
	[key: symbol]: Attachment<HTMLElement>;
};

/** The key a row's attachment is spread under (one for every row). */
const REVEAL = createAttachmentKey();

/**
 * A row's attributes: the keyboard's row (`selected`) scrolls into view when
 * it becomes it, unless `reveal` is `false` (a list in the page, whose
 * focus scrolls it).
 */
export const optionAttributes = (
	id: string,
	role: OptionAttributes['role'],
	selected: boolean,
	extra: Partial<Omit<OptionAttributes, 'id' | 'role' | 'data-selected'>> = {},
	reveal = true
): OptionAttributes => ({
	id,
	role,
	tabindex: -1,
	...(role === 'option' ? { 'aria-selected': selected } : {}),
	...extra,
	'data-selected': selected,
	...(reveal
		? {
				[REVEAL]: (node: HTMLElement) => {
					if (selected) node.scrollIntoView?.({ block: 'nearest' });
				}
			}
		: {})
});

/** A text field: it takes the focus a press gives it. */
export const isField = (target: EventTarget | null) =>
	target instanceof Element &&
	(target.matches('input, textarea, select') || (target as HTMLElement).isContentEditable);

/**
 * A press on chrome keeps the focus where it is (the editor's caret, or the
 * menu's field): every press but one on a field, which takes its own.
 */
export const keepFocus = (event: MouseEvent) => {
	if (!isField(event.target)) event.preventDefault();
};

/**
 * Give `node` the id the controller names it by (`aria-controls`), and the
 * role and accessible name it lacks (a snippet's own win).
 */
export const identify = (node: HTMLElement, id: string, role?: string, label?: string) => {
	node.id = id;
	if (role && !node.hasAttribute('role')) node.setAttribute('role', role);
	if (label && !node.hasAttribute('aria-label') && !node.hasAttribute('aria-labelledby'))
		node.setAttribute('aria-label', label);
};

/** Set or remove (`undefined`) an attribute the keyboard's owner carries. */
export const attribute = (node: HTMLElement, name: string, value: string | undefined) => {
	if (value === undefined) node.removeAttribute(name);
	else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
};

/** Whether `node` may name a highlighted row (`aria-activedescendant`): a field, or an element with a role. */
export const namesRows = (node: HTMLElement) => isField(node) || node.hasAttribute('role');

/** `id` when an element of `node`'s page has it, else `undefined`. */
export const inPage = (node: Node, id: string | undefined) =>
	id && node.ownerDocument?.getElementById(id) ? id : undefined;
