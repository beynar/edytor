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
import type { SelectionValue } from '$lib/session/selection.js';
import { takeKeys } from '$lib/events/onFocus.js';
import { ChromeList, holdKeys, menuKey } from '../list.svelte.js';
import { optionAttributes, type OptionAttributes } from '../chrome.js';
import { Anchored } from '../anchored.svelte.js';
import { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';

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

/** The choices on a row of the picker: the arrows up and down move by a row (`picker.columns`). */
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
	`<div data-edytor-callout="${escapeHtml(icon)}"><p>${content}</p>${children}</div>`;

/**
 * A view's callout icon picker: what a `callout.picker` snippet receives.
 * The callout it is open on (`block`), the choices (`icons`) and the icon
 * that callout shows (`current`); `set(icon)` and `remove()` write it and
 * close, `close()` closes with nothing written. Put `{@attach picker.keys}`
 * and `{@attach picker.popup}` on the picker's element (it takes the focus
 * and the keys, names the keyboard's row and is published to the view's
 * root), spread `picker.option(i)` on each row (`i` in `icons`,
 * `icons.length` for Remove icon) and run `picker.pick(i)` on its click.
 */
export class CalloutIconPicker extends ChromeList {
	/** The callout the picker is open on (its id), `null` when closed. */
	target = $state<string | null>(null);
	/** The choices on a row: ArrowUp and ArrowDown move by a row, so lay the icons out in as many columns. */
	readonly columns = ICON_COLUMNS;
	/**
	 * The picker's panel under the target's icon (its block without one): its
	 * place, and what closes it (a press or focus outside, the icon gone,
	 * readonly).
	 * @internal
	 */
	readonly panel: Anchored;
	/** The selection the picker gives back when it closes. */
	#before: SelectionValue | null = null;

	constructor(
		edytor: Edytor,
		/** A new callout's icon, and the one a callout without `data.icon` shows. */
		readonly icon: string = DEFAULT_CALLOUT_ICON,
		/** The picker's choices. */
		readonly icons: readonly string[] = CALLOUT_ICONS
	) {
		super(edytor, 'callout-icons', 'menu');
		this.panel = new Anchored(
			edytor,
			'edytor-callout-icons-host',
			() => {
				if (this.target === null) return undefined;
				const node = this.block?.node;
				const icon = [...(node?.querySelectorAll('[data-edytor-callout-icon]') ?? [])].find(
					(element) => element.closest('[data-edytor-block="true"]') === node
				);
				return icon ?? node ?? null;
			},
			() => this.close(false)
		);
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

	/** The keyboard's rows: the icons, then Remove icon. */
	protected get count() {
		return this.icons.length + 1;
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
		this.panel.box = null;
		this.#before = null;
		this.edytor.overlay.invalidate();
		if (!keys) return;
		if (before && before.kind !== 'none') this.edytor.selection.select(before);
		takeKeys(this.edytor);
	};

	/** Write `icon` on the callout (one undo step), then close. */
	set = (icon: string) => {
		const block = this.block;
		if (block && block.data.icon !== icon)
			block.edytor.patchData(block.id, [{ path: ['icon'], value: icon }]);
		this.close();
	};

	/** Leave the callout without an icon (`data.icon` is `''`), then close. */
	remove = () => this.set('');

	/** Pick row `index`: its icon, or Remove icon (`icons.length`). */
	pick = (index: number) => {
		const icon = this.icons[index];
		if (icon === undefined) this.remove();
		else this.set(icon);
	};

	/**
	 * What row `index` spreads (`icons.length`: Remove icon), as every menu's
	 * rows: its id, `menuitemradio` role and `aria-checked` (`menuitem` for
	 * Remove icon), `data-selected` on the keyboard's row.
	 */
	option(index: number): OptionAttributes {
		const icon = this.icons[index];
		return optionAttributes(
			this.rowId(index),
			icon === undefined ? 'menuitem' : 'menuitemradio',
			index === this.index,
			icon === undefined ? {} : { 'aria-checked': icon === this.current },
			false
		);
	}

	/**
	 * The picker's element (`{@attach picker.keys}`): it takes the focus as
	 * it opens and names the keyboard's row (`aria-activedescendant`). The
	 * arrows walk the rows (up and down by `ICON_COLUMNS`), Home and End
	 * reach the ends, Enter or Space picks, Escape and Tab close; no key
	 * reaches the page behind it. Focus leaving it closes it.
	 */
	keys: Attachment<HTMLElement> = (node) => untrack(() => this.#keys(node));

	#keys = (node: HTMLElement) => {
		const keydown = (event: KeyboardEvent) => {
			event.stopPropagation();
			const at = this.index;
			menuKey(
				event,
				{
					at,
					count: this.count,
					to: (index) => (this.index = index),
					pick: () => this.pick(at),
					close: this.close
				},
				// Left and right wrap; up and down stop at the first and last rows.
				{ columns: ICON_COLUMNS }
			);
		};
		// Focus leaving for somewhere else closes it (the window going to the background does not).
		node.tabIndex = -1;
		node.addEventListener('focusout', this.panel.blurred);
		// It gives back the editor's selection as it is now: a block menu that
		// opened it gave its caret back first.
		this.#before ??= this.edytor.selection.value;
		const off = holdKeys(node, keydown, () => this.rowId(this.index));
		return () => {
			off();
			node.removeEventListener('focusout', this.panel.blurred);
		};
	};
}
