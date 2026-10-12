/**
 * The controls inside the rich text kinds (a to-do's checkbox, a callout's
 * icon, an empty body's hint): the package's markup by default, the app's
 * snippet when `createRichTextPlugin` names one. Each snippet receives a
 * payload: the state, the action (written through the document) and the
 * words the markup reads, and the control's attachment (its marker, its
 * ARIA, its press and click), so custom markup keeps the keys, the
 * accessibility and what the editor reads of it.
 */
import type { Snippet } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { BlockView } from '$lib/plugins.js';
import { labelsOf, richTextEnglish } from '$lib/labels.js';
import { attach, keepSelection } from '../chrome.js';
import { calloutPickers, iconOf } from './callouts.js';
import { openBody } from './body.js';

/** What a to-do's `checkbox` snippet receives. */
export type TodoCheckboxPayload = {
	/** The to-do; `undefined` in a suggestion's preview (its box writes nothing). */
	readonly block: Block | undefined;
	/** It is checked: its `data.checked` (reactive). */
	readonly checked: boolean;
	/** The checkbox's accessible name (the view's `richText.checkbox`). */
	readonly label: string;
	/** Check or uncheck it: one data write, refused in a readonly view. */
	toggle: () => void;
	/**
	 * The control's attachment (`{@attach box.control}`), on an `input
	 * type="checkbox"` (give it `checked={box.checked}`) or a `button` (it
	 * gets `role="checkbox"` and `aria-checked`): its marker
	 * (`data-edytor-todo-checkbox`), `contenteditable="false"`, its
	 * `aria-label`, a press that keeps the editor's selection and a click
	 * that toggles the to-do.
	 */
	readonly control: Attachment<HTMLElement>;
};

/** What a callout's `calloutIcon` snippet receives. */
export type CalloutIconPayload = {
	/** The callout; `undefined` in a suggestion's preview. */
	readonly block: Block | undefined;
	/** Its icon: its `data.icon`, the view's default without one, `''` for none (reactive). */
	readonly icon: string;
	/**
	 * The icon opens the view's picker: an editable view listing a picker,
	 * not a suggestion's preview. Draw a `button` then, else the icon alone.
	 */
	readonly editable: boolean;
	/** The picker is open on this callout (reactive). */
	readonly expanded: boolean;
	/** The button's accessible name: Change icon, or Add icon over an empty slot. */
	readonly label: string;
	/** Open the view's picker on this callout, or close it. */
	toggle: () => void;
	/**
	 * The icon's attachment (`{@attach icon.control}`): its marker
	 * (`data-edytor-callout-icon`, which the picker opens under), `data-empty`
	 * without an icon, `contenteditable="false"`; editable, its
	 * `aria-label`, `aria-haspopup`, `aria-expanded`, `aria-controls`, a
	 * press that keeps the editor's selection and a click that toggles the
	 * picker; else `aria-hidden`.
	 */
	readonly control: Attachment<HTMLElement>;
};

/** What the `emptyBody` snippet of an open toggle's or a callout's empty body receives. */
export type EmptyBodyPayload = {
	/** The toggle or callout. */
	readonly block: Block;
	/** Which kind's body. */
	readonly kind: 'toggle' | 'callout';
	/** The hint (the view's `richText.emptyBody`). */
	readonly label: string;
	/** Start the body: a first child, the caret in it (one command, one undo step). */
	open: () => void;
	/**
	 * The hint's attachment (`{@attach hint.control}`): its marker
	 * (`data-edytor-empty-body`, where a dragged block drops inside),
	 * `contenteditable="false"`, `aria-hidden` (Enter at the end of the
	 * header is the keyboard's way in) and a click that starts the body.
	 */
	readonly control: Attachment<HTMLElement>;
};

/** `createRichTextPlugin`'s control snippets. */
export type RichTextControls = {
	checkbox?: Snippet<[TodoCheckboxPayload]>;
	calloutIcon?: Snippet<[CalloutIconPayload]>;
	emptyBody?: Snippet<[EmptyBodyPayload]>;
};

/** Each view's control snippets (the first rich text plugin listed sets them). */
export const richTextControls = new WeakMap<object, RichTextControls>();

/** Check or uncheck a to-do: one key patched, so a peer's concurrent edit of another key is kept. */
export const toggleTodo = (block: Block) =>
	block.edytor.patchData(block.id, [{ path: ['checked'], value: !block.data.checked }]);

/**
 * A to-do's checkbox in `view` (a suggestion's preview included: no
 * handle, no write), named in its labels.
 */
export const todoCheckbox = (
	view: Edytor,
	block: () => BlockView<{ checked?: boolean }>
): TodoCheckboxPayload => {
	const label = labelsOf(view, 'richText', richTextEnglish).checkbox;
	const checked = () => Boolean(block().data.checked);
	const toggle = () => {
		const handle = block().handle;
		if (handle) toggleTodo(handle);
	};
	return {
		get block() {
			return block().handle;
		},
		get checked() {
			return checked();
		},
		label,
		toggle,
		get control(): Attachment<HTMLElement> {
			const on = checked();
			return (node) => {
				const native = node instanceof HTMLInputElement && node.type === 'checkbox';
				// Another element than a native checkbox is one to assistive technology,
				// unless the markup gave it its own role.
				const role = native ? {} : { role: node.getAttribute('role') ?? 'checkbox' };
				return attach(
					{
						contenteditable: 'false',
						'aria-label': label,
						'data-edytor-todo-checkbox': '',
						...role,
						'aria-checked': native ? undefined : on
					},
					{
						mousedown: keepSelection,
						click: () => {
							// Never cancel the click: the browser reverts a canceled checkbox click
							// after its handlers, over the re-render this write makes, so the box
							// would show the old state here while peers show the new one. Toggle the
							// document, then show what it holds (a refused write, readonly or vetoed,
							// shows unchanged).
							toggle();
							if (native) node.checked = checked();
						}
					}
				)(node);
			};
		}
	};
};

/**
 * A callout's icon in `view` (`callout.icon`): its `data.icon`, the view's
 * default without one, none when it is `''`; a button opening the view's
 * picker where it may be picked (an editable view listing a picker, not a
 * suggestion's preview), else the icon alone.
 */
export const calloutIcon = (
	view: Edytor,
	block: () => BlockView<{ icon?: string }>
): CalloutIconPayload => {
	const labels = labelsOf(view, 'richText', richTextEnglish).calloutIcon;
	const picker = calloutPickers.get(view);
	const editable = () => Boolean(block().handle && picker && !view.readonly);
	const icon = () => iconOf(block().data, view);
	const expanded = () => picker?.target === block().id;
	const toggle = () => {
		const handle = block().handle;
		if (handle && editable()) picker?.toggle(handle);
	};
	const label = () => (icon() ? labels.change : labels.add);
	return {
		get block() {
			return block().handle;
		},
		get icon() {
			return icon();
		},
		get editable() {
			return editable();
		},
		get expanded() {
			return expanded();
		},
		get label() {
			return label();
		},
		toggle,
		get control() {
			const can = editable();
			return attach(
				{
					contenteditable: 'false',
					'data-edytor-callout-icon': '',
					'data-empty': !icon(),
					'aria-label': can ? label() : undefined,
					'aria-haspopup': can ? 'menu' : undefined,
					'aria-expanded': can ? expanded() : undefined,
					'aria-controls': can && expanded() ? picker?.listId : undefined,
					'aria-hidden': can ? undefined : 'true'
				},
				can ? { mousedown: keepSelection, click: toggle } : {}
			);
		}
	};
};

/**
 * The hint of `block`'s empty body in `view` (`body.hint`), or `null` where
 * none shows: a readonly view, a suggestion's preview (no handle).
 */
export const emptyBody = (
	view: Edytor,
	block: BlockView,
	kind: 'toggle' | 'callout'
): EmptyBodyPayload | null => {
	const handle = block.handle;
	if (!handle || view.readonly) return null;
	const open = () => void openBody(handle);
	return {
		block: handle,
		kind,
		label: labelsOf(view, 'richText', richTextEnglish).emptyBody[kind],
		open,
		control: attach(
			{ contenteditable: 'false', 'data-edytor-empty-body': kind, 'aria-hidden': 'true' },
			{ click: open }
		)
	};
};
