/**
 * A callout's icon (`callout.icon` in the delete contract): its
 * `data.icon`, the view's default when it has none of its own, no icon when
 * it is `''`. The picker is a menu in the overlay, under the icon of the
 * callout it is open on: a choice writes `data.icon` (one `patchData`
 * command, one undo step) and gives the keys back to the editor, with the
 * selection it held; Escape, a press outside or focus leaving closes it
 * with nothing written. Its markup is the default one or the app's
 * `callout.picker` snippet; both take the keys and publish the popup
 * through the controller's attachments (`keys`, `popup`) and rows (`option`).
 */
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { englishLabels, type RichTextLabels } from '$lib/labels.js';
import type { SelectionValue } from '$lib/session/selection.js';
import { takeKeys } from '$lib/events/onFocus.js';

/** A new callout's icon unless `createRichTextPlugin({ callout: { icon } })` names another. */
export const DEFAULT_CALLOUT_ICON = '💡';

/** The picker's choices unless `createRichTextPlugin({ callout: { icons } })` names others. */
export const CALLOUT_ICONS: readonly string[] = [
	'💡',
	'⚠️',
	'❗',
	'❓',
	'ℹ️',
	'✅',
	'❌',
	'📌',
	'📝',
	'📣',
	'🔔',
	'💬',
	'🔥',
	'⭐',
	'✨',
	'🚀',
	'🎯',
	'🎉',
	'❤️',
	'👍',
	'👀',
	'⏰',
	'📅',
	'📚',
	'🧪',
	'🐛',
	'🛠️',
	'🔒',
	'🌱',
	'🤔'
];

/** The choices on a row of the default picker: the arrows up and down move by a row. */
export const ICON_COLUMNS = 8;

/** The callout icon picker of each view (the first rich text plugin listed claims it). */
export const calloutIconViews = new WeakMap<object, CalloutIconPicker>();

/** What `data.icon` shows: its own (`''`: none), else `fallback`. */
export const iconOf = (data: Record<string, unknown> | undefined, fallback: string) =>
	typeof data?.icon === 'string' ? data.icon : fallback;

/**
 * A callout's HTML: a `div` naming its icon (`data-edytor-callout`), its
 * title, then its content. A generic tag: only its attribute claims it back
 * (`parse`), never a tag another kind may export.
 */
export const calloutHtml = (icon: string, content: string, children: string) =>
	`<div data-edytor-callout="${icon.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}"><p>${content}</p>${children}</div>`;

/** What `picker.option(index)` spreads on a row: its id, role, state and handlers. */
export type CalloutIconOption = {
	id: string;
	role: 'menuitemradio' | 'menuitem';
	'aria-checked'?: boolean;
	/** The keyboard's row. */
	'data-active'?: '';
	'data-edytor-callout-icon-choice'?: '';
	'data-edytor-callout-icon-remove'?: '';
	onmousedown: (event: MouseEvent) => void;
	onmouseenter: () => void;
	onclick: () => void;
};

/**
 * A view's callout icon picker: what a `callout.picker` snippet receives.
 * The callout it is open on (`block`), the choices (`icons`) and the icon
 * that callout shows (`current`); `set(icon)` and `remove()` write it and
 * close, `close()` closes with nothing written. Put `{@attach picker.keys}`
 * and `{@attach picker.popup}` on the picker's element (it takes the focus
 * and the keys, names the keyboard's row and is published to the view's
 * root), and spread `picker.option(i)` on each row: `i` in `icons`,
 * `icons.length` for Remove icon.
 */
export class CalloutIconPicker {
	/** The callout the picker is open on (its id), `null` when closed. */
	target = $state<string | null>(null);
	/** The keyboard's row: an index in `icons`, `icons.length` for Remove icon. */
	index = $state(0);
	/**
	 * Where the picker shows, layer-relative: under the target's icon.
	 * @internal
	 */
	box = $state.raw<{ x: number; y: number } | null>(null);
	/** The selection the picker gives back when it closes. */
	#before: SelectionValue | null = null;
	/** The view's rich text words (`labels` is the picker's part). */
	readonly #words: RichTextLabels;

	constructor(
		/** @internal */
		readonly edytor: Edytor,
		/** A new callout's icon, and the one a callout without `data.icon` shows. */
		readonly icon: string = DEFAULT_CALLOUT_ICON,
		/** The picker's choices. */
		readonly icons: readonly string[] = CALLOUT_ICONS,
		labels: RichTextLabels = englishLabels.richText
	) {
		this.#words = labels;
	}

	/** The picker's words: Change icon, Add icon, its name, Remove icon. */
	get labels(): RichTextLabels['calloutIcon'] {
		return this.#words.calloutIcon;
	}

	/** Whether the picker is open (reactive). */
	get isOpen() {
		return this.target !== null;
	}

	/** The callout it is open on (reactive). */
	get block(): Block | undefined {
		const block = this.target ? this.edytor.idToBlock.get(this.target) : undefined;
		return block?.isInTree ? block : undefined;
	}

	/** The icon that callout shows (`''`: none; reactive). */
	get current(): string | undefined {
		const block = this.block;
		return block ? this.iconOf(block.data) : undefined;
	}

	/** The picker element's id (`edytor.popups`). */
	get id() {
		return this.edytor.popups.idOf('callout-icons');
	}

	/** The view is readonly (reactive): the picker closes. */
	get readonly() {
		return this.edytor.readonly;
	}

	/** The icon a callout with `data` shows. */
	iconOf = (data: Record<string, unknown> | undefined) => iconOf(data, this.icon);

	/** Open the picker on `block`, or close it when it is open there. */
	toggle = (block: Block) => (this.target === block.id ? this.close() : this.open(block));

	/** Open the picker on the callout `block`, its icon the keyboard's row (refused in a view that may not write). */
	open = (block: Block) => {
		if (!this.edytor.dispatcher.permits() || !block.isInTree) return;
		const at = this.icons.indexOf(this.iconOf(block.data));
		this.index = at === -1 ? 0 : at;
		this.#before = null;
		this.target = block.id;
		this.edytor.overlay.invalidate();
	};

	/** Close the picker; with `keys` (by default), the editor takes the keys back, with its selection. */
	close = (keys = true) => {
		if (this.target === null) return;
		const before = this.#before;
		this.target = null;
		this.box = null;
		this.#before = null;
		this.edytor.overlay.invalidate();
		if (!keys) return;
		if (before && before.kind !== 'none') this.edytor.selection.select(before);
		takeKeys(this.edytor);
	};

	/** Write `icon` on the callout (one undo step), then close. */
	set = (icon: string) => {
		const block = this.block;
		if (block && block.data.icon !== icon) block.data.icon = icon;
		this.close();
	};

	/** Leave the callout without an icon (`data.icon` is `''`), then close. */
	remove = () => this.set('');

	/** Row `index`'s element id. */
	optionId = (index: number) => `${this.id}-${index}`;

	/** What row `index` spreads (`icons.length`: Remove icon): its id, role, state and handlers. */
	option = (index: number): CalloutIconOption => {
		const icon = this.icons[index];
		const handlers = {
			onmousedown: (event: MouseEvent) => event.preventDefault(),
			onmouseenter: () => void (this.index = index),
			onclick: () => (icon === undefined ? this.remove() : this.set(icon))
		};
		const active = index === this.index ? ({ 'data-active': '' } as const) : {};
		return icon === undefined
			? {
					id: this.optionId(index),
					role: 'menuitem',
					'data-edytor-callout-icon-remove': '',
					...active,
					...handlers
				}
			: {
					id: this.optionId(index),
					role: 'menuitemradio',
					'aria-checked': icon === this.current,
					'data-edytor-callout-icon-choice': '',
					...active,
					...handlers
				};
	};

	/**
	 * The picker's element (`{@attach picker.keys}`): it takes the focus as
	 * it opens and names the keyboard's row (`aria-activedescendant`). The
	 * arrows walk the rows (up and down by `ICON_COLUMNS`), Home and End
	 * reach the ends, Enter or Space picks, Escape and Tab close; no key
	 * reaches the page behind it. Focus leaving it closes it.
	 */
	keys: Attachment<HTMLElement> = (node) => untrack(() => this.#keys(node));

	#keys = (node: HTMLElement) => {
		const steps: Record<string, number> = {
			ArrowRight: 1,
			ArrowLeft: -1,
			ArrowDown: ICON_COLUMNS,
			ArrowUp: -ICON_COLUMNS
		};
		const keydown = (event: KeyboardEvent) => {
			const count = this.icons.length + 1;
			const at = this.index;
			const step = steps[event.key];
			if (event.key === 'Escape' || event.key === 'Tab') {
				event.preventDefault();
				this.close();
			} else if (step !== undefined) {
				event.preventDefault();
				// Left and right wrap; up and down stop at the first and last rows.
				this.index =
					Math.abs(step) === 1
						? (at + step + count) % count
						: Math.min(count - 1, Math.max(0, at + step));
			} else if (event.key === 'Home' || event.key === 'End') {
				event.preventDefault();
				this.index = event.key === 'Home' ? 0 : count - 1;
			} else if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				this.option(at).onclick();
			}
			event.stopPropagation();
		};
		// Focus leaving for somewhere else closes it (the window going to the background does not).
		const focusout = (event: FocusEvent) => {
			const to = event.relatedTarget;
			if (to instanceof Node && !node.contains(to)) this.close(false);
		};
		node.tabIndex = -1;
		node.addEventListener('keydown', keydown);
		node.addEventListener('focusout', focusout);
		// It gives back the editor's selection as it is now: a block menu that
		// opened it gave its caret back first.
		this.#before ??= this.edytor.selection.value;
		node.focus({ preventScroll: true });
		$effect(() => node.setAttribute('aria-activedescendant', this.optionId(this.index)));
		return () => {
			node.removeEventListener('keydown', keydown);
			node.removeEventListener('focusout', focusout);
		};
	};

	/**
	 * The picker's element (`{@attach picker.popup}`): its id, role and name,
	 * published to the view's root (`edytor.popups`) while it is in the page.
	 */
	popup: Attachment<HTMLElement> = (node) => untrack(() => this.#popup(node));

	#popup = (node: HTMLElement) => {
		node.id = this.id;
		node.setAttribute('role', 'menu');
		node.setAttribute('aria-label', this.labels.picker);
		this.edytor.popups.set('callout-icons', { id: this.id, haspopup: 'menu' });
		return () => this.edytor.popups.set('callout-icons', null);
	};

	/**
	 * A press anywhere (`onPress`): one outside the picker and the target's icon closes it.
	 * @internal
	 */
	pressed = (event: MouseEvent) => {
		if (this.target === null) return;
		const target = event.target as Element | null;
		if (target?.closest?.('[data-edytor-callout-icons-host]')) return;
		const icon = target?.closest?.('[data-edytor-callout-icon]');
		if (icon && icon.closest('[data-edytor-block="true"]') === this.block?.node) return;
		this.close(false);
	};

	/**
	 * The overlay measure: under the target callout's icon (its block's start without one).
	 * @internal
	 */
	measure = (host: HTMLElement, origin: DOMRect) => {
		const node = this.block?.node;
		const icon = [...(node?.querySelectorAll('[data-edytor-callout-icon]') ?? [])].find(
			(element) => element.closest('[data-edytor-block="true"]') === node
		);
		const rect = (icon ?? node)?.getBoundingClientRect();
		const box = rect ? { x: rect.left - origin.left, y: rect.bottom - origin.top + 4 } : null;
		return () => {
			// Never `display: none`: the picker takes the focus before its first measure.
			Object.assign(host.style, {
				position: 'absolute',
				left: `${box?.x ?? 0}px`,
				top: `${box?.y ?? 0}px`
			});
			if (box?.x !== this.box?.x || box?.y !== this.box?.y) this.box = box;
			if (!box && this.target !== null) this.close(false);
		};
	};
}
