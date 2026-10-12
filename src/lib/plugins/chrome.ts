/**
 * What every chrome surface shares with the markup that renders it, the
 * app's snippet: the one host (`mountChrome`), the row payload a controller
 * builds, a row's attributes (`option(index)`), and the small DOM rules the
 * controllers' attachments apply (a press that keeps the focus, an
 * element given its id, role and name).
 */
import type { Snippet } from 'svelte';
import { createAttachmentKey, type Attachment } from 'svelte/attachments';
import type { Edytor } from '$lib/edytor.svelte.js';
import Chrome from './Chrome.svelte';
import { onPress } from '$lib/events/onFocus.js';
import { all, listen } from '$lib/utils/listen.js';
import {
	BLOCK_ACTIVATE_EVENT,
	BLOCK_ADD_EVENT,
	type BlockActivation,
	type BlockAddition
} from './blockHandles/BlockHandleController.svelte.js';

/**
 * Mount the app's `snippet` for a chrome surface in a fixed host of the
 * overlay (`data-<name>`, placed by `measure`), rendered with `payload`
 * while `shown` holds and closed (`close`) when the view turns readonly.
 * Without a snippet the surface renders nothing (its controller still
 * works): nothing is mounted. Answers the teardown.
 */
export const mountChrome = <T>(
	edytor: Edytor,
	snippet: Snippet<[T]> | undefined,
	payload: T,
	shown: () => unknown,
	place: {
		name: string;
		zIndex: number;
		measure: (host: HTMLElement, origin: DOMRect) => (() => void) | void;
	},
	close?: () => void
) =>
	snippet
		? edytor.overlay.mount(
				Chrome<T>,
				{ edytor, snippet, payload, shown, close },
				place.name,
				place.zIndex,
				place.measure
			)
		: () => {};

/**
 * One row of a chrome list a controller builds for the app's markup: the
 * same shape in every menu (a table grip's, the code language list's).
 */
export type MenuItemPayload<T> = {
	/** What the row stands for: a command, a trigger's row, a version. */
	item: T;
	/** The row's element id (page-unique): the keyboard's owner names the highlighted row by it. */
	id: string;
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
	/** A row that cannot run now (a table menu's Move up on the first row). */
	'aria-disabled'?: boolean;
	'aria-haspopup'?: 'menu';
	'aria-expanded'?: boolean;
	'data-selected': boolean;
	[key: symbol]: Attachment<HTMLElement>;
};

/**
 * A control's attributes inside a block (a to-do's checkbox, a page's
 * link, a table of contents' entry…): spread them on the element the
 * control's snippet draws (`{...payload.attributes}`), so custom markup
 * keeps its marker, its ARIA, its press and its action.
 */
export type ControlAttributes = {
	[name: string]: unknown;
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

/** A press on a control inside a block keeps the editor's selection (and its focus). */
export const keepSelection = (event: MouseEvent) => event.preventDefault();

/** Give `node` the id the controller names it by (`aria-controls`), and the role it lacks. */
export const identify = (node: HTMLElement, id: string, role?: string) => {
	node.id = id;
	if (role && !node.hasAttribute('role')) node.setAttribute('role', role);
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

/**
 * A handle menu's events on the editor `node` (the block menu, the `+`'s
 * menu): a grip's activation (`BLOCK_ACTIVATE_EVENT`), a `+`'s offer
 * (`BLOCK_ADD_EVENT`), and every press outside the elements `inside`
 * matches (WebKit's lone `mousedown` after a drag too, `onPress`). Answers
 * the teardown.
 */
export const handleMenuEvents = (
	edytor: Edytor,
	node: HTMLElement,
	activate: (event: CustomEvent<BlockActivation>) => void,
	add: (event: CustomEvent<BlockAddition>) => void,
	inside: string,
	outside: () => void
) =>
	all(
		listen(node, BLOCK_ACTIVATE_EVENT, activate),
		listen(node, BLOCK_ADD_EVENT, add),
		onPress(
			edytor,
			node.ownerDocument,
			(event) => {
				if (!(event.target as Element | null)?.closest?.(inside)) outside();
			},
			true
		)
	);
