/**
 * What every chrome surface shares with the markup that renders it, the
 * app's snippet: the one host (`mountChrome`), the row payload a controller
 * builds, a row's attributes (`option(index)`), and the small DOM rules the
 * controllers' attachments apply (a press that keeps the focus, an
 * element given its id, role and name).
 */
import type { Snippet } from 'svelte';
import type { Attachment } from 'svelte/attachments';
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
	 * The row's attachment (`{@attach item.option}`): its `id`, `role`,
	 * `aria-selected` (or `aria-checked`) and `tabindex`, and the keyboard's
	 * row scrolled into view. Its look is yours, from `selected`.
	 */
	option: Attachment<HTMLElement>;
};

/** An attribute's value as an attachment writes it: `undefined` or `null` removes it. */
type AttributeValue = string | number | boolean | null | undefined;

/**
 * Write `value` as `node`'s attribute `name`, only when it changes:
 * `undefined` or `null` removes it; a boolean is an ARIA state's
 * `"true"`/`"false"`, else present (`true`) or removed (`false`); a
 * `--custom-property` is set on the element's style.
 */
const write = (node: HTMLElement, name: string, value: AttributeValue) => {
	if (name.startsWith('--')) {
		if (value === undefined || value === null) node.style.removeProperty(name);
		else node.style.setProperty(name, String(value));
		return;
	}
	const aria = name.startsWith('aria-');
	const text =
		value === undefined || value === null || (value === false && !aria)
			? undefined
			: value === true && !aria
				? ''
				: String(value);
	attribute(node, name, text);
};

/**
 * The attachment of an element the package needs something of (a row, a
 * control inside a block): it writes `attributes` (see `write`) and
 * listens for `on`'s events until it is torn down. Read in a template,
 * a new attachment replaces the last one when what it reads changes: the
 * attributes it no longer gives (`undefined`) are removed.
 */
export const attach =
	(
		attributes: Record<string, AttributeValue>,
		on: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void } = {}
	): Attachment<HTMLElement> =>
	(node) => {
		for (const name in attributes) write(node, name, attributes[name]);
		return all(
			...Object.entries(on).map(([type, listener]) => listen(node, type, listener as never))
		);
	};

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

/**
 * Every press in `document` (capture; WebKit's lone `mousedown` after a
 * drag too, `onPress`) outside the elements `inside` matches: `outside`
 * hears it. Answers the teardown.
 */
export const onPressOutside = (
	edytor: Edytor,
	document: Document,
	inside: string,
	outside: (event: MouseEvent) => void
) =>
	onPress(
		edytor,
		document,
		(event) => {
			if (!(event.target as Element | null)?.closest?.(inside)) outside(event);
		},
		true
	);

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
		onPressOutside(edytor, node.ownerDocument, inside, outside)
	);
