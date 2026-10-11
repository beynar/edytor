/**
 * The one list behaviour every chrome menu shares (the trigger and slash
 * menus, the block menu, the code language list, the callout icon picker,
 * the URL paste menu, the table grip menu): the keyboard's row a key moves
 * to, the list element's id, role, name and publication to the view's root,
 * the element holding the keyboard (its focus, its keys, the row it names),
 * and the editor's keys for a list the editor keeps the keyboard for. Each
 * controller keeps its own state, rows and payload; these are its
 * attachments' and bindings' bodies.
 */
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { HotKey, HotKeyCombination } from '$lib/session/keymap.js';
import type { Popup } from '$lib/surface/popups.svelte.js';
import { attribute, inPage, keepFocus, namesRows } from './chrome.js';

/**
 * The keyboard's row after `key` among `count` rows from `at`, `undefined`
 * when the key does not move it: ArrowDown and ArrowUp step through the
 * rows `usable` keeps (a disabled one is skipped), around the ends; in a
 * grid of `columns`, ArrowRight and ArrowLeft step around the ends, ArrowDown
 * and ArrowUp a whole row, stopping at the first and last; with `ends`, Home
 * and End reach the first and last rows.
 */
export const stepRow = (
	key: string,
	at: number,
	count: number,
	{ columns = 0, ends = false, usable = () => true }: Steps = {}
): number | undefined => {
	const rows = [...Array(count).keys()].filter(usable);
	const length = rows.length;
	const down = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[key];
	const across = columns && ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[key];
	if (down && columns) return Math.max(0, Math.min(length - 1, at + down * columns));
	const step = down || across;
	if (step) return length ? rows[(rows.indexOf(at) + step + length) % length] : at;
	if (ends && length && (key === 'Home' || key === 'End'))
		return rows[key === 'Home' ? 0 : length - 1];
};

/** How a list's keys step (`stepRow`): a grid's columns, Home and End, the rows they stop at. */
type Steps = { columns?: number; ends?: boolean; usable?: (index: number) => boolean };

/**
 * A key on a menu that holds the keyboard itself, not a field (WAI-ARIA's
 * menu keys): the arrows, Home and End move its row (`stepRow`), Enter and
 * Space pick it, Escape and Tab close it. Whether the key was the menu's
 * (then its default is prevented).
 */
export const menuKey = (
	event: KeyboardEvent,
	menu: {
		at: number;
		count: number;
		to: (index: number) => void;
		pick: () => void;
		close: () => void;
	},
	steps?: Steps
) => {
	const { key } = event;
	const to = stepRow(key, menu.at, menu.count, { ends: true, ...steps });
	if (to !== undefined) menu.to(to);
	else if (key === 'Enter' || key === ' ') menu.pick();
	else if (key === 'Escape' || key === 'Tab') menu.close();
	else return false;
	event.preventDefault();
	return true;
};

/**
 * A list's element (`{@attach controller.popup}`, named by its markup): it
 * takes the list's id (`edytor.popups.idOf(owner)`) and its `role` unless
 * it has its own, keeps the focus where it is on a press (a field takes its
 * own), and is published to the view's root (`edytor.popups`, `role` its
 * `aria-haspopup`) while `open` answers the rest of its record (its
 * highlighted row, the control that opened it), withdrawn when it closes or
 * leaves the page.
 */
export const listPopup =
	(
		edytor: Edytor,
		owner: string,
		role: 'listbox' | 'menu',
		open: (node: HTMLElement) => Omit<Popup, 'id'> | false | null = () => ({})
	): Attachment<HTMLElement> =>
	(node) => {
		const id = edytor.popups.idOf(owner);
		node.id = id;
		if (!node.hasAttribute('role')) node.setAttribute('role', role);
		node.addEventListener('mousedown', keepFocus);
		$effect(() => {
			const popup = open(node);
			if (!popup) return;
			edytor.popups.set(owner, { id, haspopup: role, ...popup });
			return () => edytor.popups.set(owner, null);
		});
		return () => node.removeEventListener('mousedown', keepFocus);
	};

/**
 * The element that holds a list's keyboard (a `keys` attachment's body): it
 * takes the focus as it mounts (unless the focus is already in it), `keydown`
 * hears the keys on `keyed` (the element itself by default), and it names
 * the highlighted row (`aria-activedescendant`, once that row is in the
 * page) when it may name one (a field, or an element with a role).
 */
export const holdKeys = (
	node: HTMLElement,
	keydown: (event: KeyboardEvent) => void,
	active: () => string | undefined,
	keyed: HTMLElement = node
) => {
	untrack(() => {
		if (!node.contains(node.ownerDocument.activeElement)) node.focus({ preventScroll: true });
	});
	keyed.addEventListener('keydown', keydown);
	$effect(() => {
		if (namesRows(node)) attribute(node, 'aria-activedescendant', inPage(node, active()));
	});
	return () => keyed.removeEventListener('keydown', keydown);
};

/** An open list the editor keeps the keyboard for, as its keys drive it. */
export type HeldList = {
	/** Move the keyboard's row by `step`; whether it moved (no rows: the arrows stay the caret's). */
	move: (step: number) => boolean;
	/** Pick the keyboard's row; none when Enter is not the list's (no row to pick). */
	pick?: () => void;
	close: () => void;
};

/**
 * The editor's keys for the list it keeps the keyboard for (a trigger's
 * menu, the URL paste menu), while `open` answers one: ArrowDown and ArrowUp
 * move its row, Enter picks it, Escape closes it.
 */
export const listHotkeys = (
	open: () => HeldList | false | undefined
): Partial<Record<HotKeyCombination, HotKey>> => {
	const step =
		(by: number): HotKey =>
		({ prevent }) => {
			const list = open();
			if (list && list.move(by)) prevent();
		};
	return {
		arrowdown: step(1),
		arrowup: step(-1),
		enter: ({ prevent }) => {
			const list = open();
			if (list && list.pick) prevent(list.pick);
		},
		escape: ({ prevent }) => {
			const list = open();
			if (list) prevent(list.close);
		}
	};
};
