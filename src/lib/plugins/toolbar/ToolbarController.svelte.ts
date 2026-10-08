import type { Attachment } from 'svelte/attachments';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import type { SelectionValue } from '$lib/session/selection.js';
import { isRecord, type SerializableContent } from '$lib/utils/json.js';
import {
	linkAt,
	openLink,
	richTextOperations,
	type LinkRun,
	type RichTextMark
} from '$lib/plugins/richtext/richTextOperations.js';
import { selectedTextSpans } from '$lib/selection/visibility.js';
import {
	getYIndex,
	SUGGESTION,
	SYNTHETIC_TEXT_OVERLAY_SELECTOR
} from '$lib/selection/selection.utils.js';
import type { Text } from '$lib/text/text.svelte.js';
import { convertBlocks, convertibleKinds, rowOf, type KindRow } from '$lib/kinds.js';
import { getSelectionBlocks } from '$lib/selection/replaceSelection.js';
import type { Popup } from '$lib/surface/popups.svelte.js';
import { englishLabels, type ToolbarLabels } from '$lib/labels.js';
import { identify } from '../chrome.js';

/** The bar's controls the arrows walk (a disabled one is skipped). */
const STOPS = 'button:not([disabled]), input:not([disabled]), select:not([disabled])';

/** Notion's palette: text colors and their backgrounds, by name (shown through the labels' `colors`). */
export const TOOLBAR_COLORS = [
	{ name: 'Default', text: null, background: null },
	{ name: 'Gray', text: '#7d7a75', background: '#f0efed' },
	{ name: 'Brown', text: '#9f765a', background: '#f5ede9' },
	{ name: 'Orange', text: '#d27b2d', background: '#fbebde' },
	{ name: 'Yellow', text: '#cb9434', background: '#f9f3dc' },
	{ name: 'Green', text: '#50946e', background: '#e8f1ec' },
	{ name: 'Blue', text: '#387dc9', background: '#e5f2fc' },
	{ name: 'Purple', text: '#9a6bb4', background: '#f3ebf9' },
	{ name: 'Pink', text: '#c14c8a', background: '#fae9f1' },
	{ name: 'Red', text: '#cf5148', background: '#fce9e7' }
] as const;

const getLinkHref = (value: SerializableContent | undefined) =>
	isRecord(value) && typeof value.href === 'string' ? value.href : null;

export class ToolbarController {
	/** Shown for the current selection; hidden while the editor is readonly. */
	private shown = $state(false);
	linkUrl = $state('');
	/** The open panel: the kind menu, the link field or the colors. */
	panel = $state<null | 'turn' | 'link' | 'color'>(null);
	/** The selection the toolbar acts on: a value (anchors), so peers' edits move it. */
	private selectionSnapshot: SelectionValue | null = null;
	private isRestoringSelection = false;
	/** The link panel's field takes the focus when it next mounts (it was opened, not re-rendered). */
	private focusField = false;
	/** The link under the pointer, for the link card (`link.card`). */
	hovered = $state.raw<HTMLAnchorElement | null>(null);

	constructor(
		private edytor: Edytor,
		/** The words the toolbar shows (the plugin's `labels`): read them in a custom `toolbar`. */
		readonly labels: ToolbarLabels = englishLabels.toolbar
	) {}

	/** A palette color's name as shown (`labels.colors`). */
	colorName = (name: string) => this.labels.colors[name] ?? name;

	get isVisible() {
		return this.shown && !this.edytor.readonly;
	}

	/** The bar's element id (page-unique), for the root's `aria-controls`. */
	get barId() {
		return this.edytor.popups.idOf('toolbar');
	}

	/** Publish the shown bar to the view's root (`edytor.popups`), or withdraw it with `null`. */
	publish = (popup: Popup | null) => this.edytor.popups.set('toolbar', popup);

	/** The link panel's field id (page-unique): a `label`'s `for`. */
	get linkFieldId() {
		return this.edytor.popups.idOf('toolbar-link');
	}

	/** The control the bar's one tab stop is on (its `data-stop`, else its place), kept while it shows. */
	#stop: string | number = 0;

	/**
	 * The bar (`{@attach controller.popup}`): it takes the bar's id, its
	 * `toolbar` role and name unless it has its own, the placement's mark
	 * (`data-edytor-toolbar-bar`, which the toolbar's shortcut also reads),
	 * and is published to the view's root (`edytor.popups`, with that
	 * shortcut as its `aria-keyshortcuts`) while it is in the page.
	 */
	popup: Attachment<HTMLElement> = (node) => {
		identify(node, this.barId, 'toolbar', this.labels.bar);
		node.setAttribute('data-edytor-toolbar-bar', '');
		this.publish({ id: this.barId, keys: 'Alt+F10' });
		return () => this.publish(null);
	};

	/**
	 * The bar's keys (`{@attach controller.keys}`, WAI-ARIA toolbar): one tab
	 * stop, the control it last held (`tabindex="0"`, every other `-1`); the
	 * arrows, Home and End walk its controls, Escape gives the focus back to
	 * the editor over the held selection (`release`). Every key in it is its
	 * own, never the editor's (Enter presses the button).
	 */
	keys: Attachment<HTMLElement> = (node) => {
		const stops = () => [...node.querySelectorAll<HTMLElement>(STOPS)];
		const keyOf = (stop: HTMLElement, at: number) => stop.dataset.stop ?? at;
		/** One tab stop: the remembered control, else the first. */
		const rove = () => {
			const all = stops();
			const at = all.findIndex((stop, index) => keyOf(stop, index) === this.#stop);
			all.forEach((stop, index) => (stop.tabIndex = index === Math.max(0, at) ? 0 : -1));
		};
		const focusin = (event: FocusEvent) => {
			const all = stops();
			const at = all.indexOf(event.target as HTMLElement);
			if (at === -1) return;
			this.#stop = keyOf(all[at]!, at);
			rove();
		};
		const keydown = (event: KeyboardEvent) => {
			event.stopPropagation();
			if (event.defaultPrevented) return;
			const all = stops();
			const at = all.indexOf(event.target as HTMLElement);
			const next = {
				ArrowRight: (at + 1) % all.length,
				ArrowLeft: (at - 1 + all.length) % all.length,
				Home: 0,
				End: all.length - 1
			}[event.key];
			if (event.key === 'Escape') {
				event.preventDefault();
				this.release();
			} else if (next !== undefined && at !== -1) {
				event.preventDefault();
				all[next]?.focus();
			}
		};
		rove();
		node.addEventListener('focusin', focusin);
		node.addEventListener('keydown', keydown);
		return () => {
			node.removeEventListener('focusin', focusin);
			node.removeEventListener('keydown', keydown);
		};
	};

	/**
	 * The link panel's field (`{@attach controller.linkField}`): its id
	 * (`linkFieldId`), the focus when the panel was just opened (Mod+K, Edit,
	 * the Link button), Enter applies the link and Escape closes the panel,
	 * both giving the editor its focus and the selection back.
	 */
	linkField: Attachment<HTMLInputElement> = (node) => {
		node.id = this.linkFieldId;
		if (this.takeFieldFocus()) node.focus({ preventScroll: true });
		const keydown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			if (event.key === 'Enter') {
				event.preventDefault();
				this.applyLink();
				this.closePanel(true);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this.closePanel(true);
			}
		};
		node.addEventListener('keydown', keydown);
		return () => node.removeEventListener('keydown', keydown);
	};

	/** Give the keyboard back to the editor (Escape in the bar), over the held selection. */
	release() {
		const snapshot = this.selectionSnapshot;
		this.panel = null;
		if (snapshot) this.restoreSelection(snapshot);
		this.edytor.expectInternalFocus();
		this.edytor.node?.focus({ preventScroll: true });
	}

	updateFromSelection(selection = this.edytor.selection) {
		if (!this.canShowForSelection(selection)) {
			this.shown = false;
			this.linkUrl = '';
			this.panel = null;
			this.selectionSnapshot = null;
			return;
		}

		this.shown = true;
		if (!this.isRestoringSelection) this.linkUrl = this.getSelectedLinkUrl(selection);
		this.selectionSnapshot = selection.value.kind === 'text' ? selection.value : null;
	}

	setLinkUrl(value: string) {
		this.linkUrl = value;
	}

	/** The mark records declaring a toolbar button, in registration order. */
	get marks() {
		return [...this.edytor.marks].flatMap(([mark, { toolbar }]) =>
			toolbar ? [{ mark, ...toolbar }] : []
		);
	}

	/** Whether `mark` covers every character of the selection (its button shows pressed). */
	isActive(mark: string) {
		const runs = selectedTextSpans(this.edytor)
			.flatMap(({ text, start, end }) => text.getMarksAtRange(start, end))
			.filter((run) => run.text);
		return runs.length > 0 && runs.every((run) => Boolean(run.marks?.[mark]));
	}

	/** The kinds the selection's block may turn into (conversions that keep its content). */
	get kinds(): KindRow[] {
		return convertibleKinds(this.edytor);
	}

	/** The row naming the selection's block, for the kind button's label. */
	get currentKind(): KindRow | undefined {
		return rowOf(this.edytor, this.edytor.selection.state.startBlock);
	}

	togglePanel(panel: 'turn' | 'link' | 'color') {
		this.panel = this.panel === panel ? null : panel;
		this.focusField = this.panel === 'link';
	}

	/** Whether the link field mounting now takes the focus (once per opening). */
	takeFieldFocus() {
		const focus = this.focusField;
		this.focusField = false;
		return focus;
	}

	/**
	 * Mod+K (`link.mod-k`): the link panel over the selected text, or, at a
	 * caret inside a link, over that link, selected first. Answers whether
	 * the panel opened (the key is claimed only then).
	 */
	openLinkPanel() {
		const { selection } = this.edytor;
		const { isCollapsed, startText, yStart } = selection.state;
		if (selection.value.kind !== 'text' || !startText) return false;
		const { voidRoot, islandRoot } = selection.projection;
		if (voidRoot !== null || islandRoot !== null) return false;
		if (isCollapsed) {
			const run = linkAt(startText, yStart - 1) ?? linkAt(startText, yStart);
			if (!run) return false;
			selection.setAtRange(startText, run.start, startText, run.end);
		}
		this.updateFromSelection();
		if (!this.isVisible) return false;
		this.panel = 'link';
		this.focusField = true;
		return true;
	}

	/**
	 * Close the open panel. With `focus` (Enter or Escape in the link field)
	 * the editor takes its focus back and the held selection shows again.
	 */
	closePanel(focus = false) {
		this.panel = null;
		const snapshot = this.selectionSnapshot;
		if (!focus || this.edytor.readonly) return;
		this.edytor.expectInternalFocus();
		this.edytor.node?.focus({ preventScroll: true });
		if (snapshot) this.restoreSelection(snapshot);
	}

	/** The link card shows: a link is hovered in an editable view. */
	get card() {
		return this.hovered !== null && !this.edytor.readonly;
	}

	/** The hovered link's URL, as stored (the card shows it). */
	get hoveredHref() {
		return this.hovered?.getAttribute('href') ?? '';
	}

	/** Show the card for `anchor`, or hide it (`null`). */
	hover(anchor: HTMLAnchorElement | null) {
		if (this.hovered === anchor) return;
		this.hovered = anchor;
		this.edytor.overlay.invalidate();
	}

	/** The card's Open: the hovered link in a new tab. */
	openHovered() {
		const href = this.hoveredHref;
		if (href) openLink(href, this.edytor.node?.ownerDocument.defaultView ?? null);
	}

	/** The card's Edit: select the hovered link and open the link panel on it. */
	editHovered() {
		const link = this.hoveredLink();
		this.hover(null);
		if (!link) return;
		this.edytor.selection.setAtRange(link.text, link.start, link.text, link.end);
		this.updateFromSelection();
		if (!this.isVisible) return;
		this.panel = 'link';
		this.focusField = true;
	}

	/** The card's Remove: unlink the whole hovered link (one undo step); the selection stays. */
	removeHovered() {
		const link = this.hoveredLink();
		this.hover(null);
		if (link) richTextOperations(this.edytor).unlinkText(link.text, link.start, link.end);
	}

	/** The hovered link element's text and link run, read from the model (never from the DOM). */
	private hoveredLink(): (LinkRun & { text: Text }) | null {
		const anchor = this.hovered;
		if (!anchor?.isConnected || anchor.closest(`${SUGGESTION}, ${SYNTHETIC_TEXT_OVERLAY_SELECTOR}`))
			return null;
		const text = this.edytor.selection.getTextOfNode(anchor);
		const leaf = anchor.ownerDocument.createTreeWalker(anchor, NodeFilter.SHOW_TEXT).nextNode();
		if (!text?.node || !leaf || !text.node.contains(anchor)) return null;
		const run = linkAt(text, getYIndex(text, leaf, 0));
		return run && { ...run, text };
	}

	/** Convert every block the selection touches (Notion), as one undo step. */
	turnInto(kind: KindRow) {
		this.panel = null;
		this.runWithSelection(() => convertBlocks(this.edytor, getSelectionBlocks(this.edytor), kind));
	}

	/** Set (or clear, with `null`) the text color or background of the selection. */
	setColor(mark: 'color' | 'highlight', value: string | null) {
		this.panel = null;
		this.runWithSelection(() => {
			const operations = richTextOperations(this.edytor);
			if (value) operations.setMarkValueAtRange(mark, value);
			else operations.removeMarkAtRange(mark);
		});
	}

	toggleMark(mark: string) {
		const run = this.edytor.marks.get(mark)?.toolbar?.run;
		if (run) return run(this.edytor);
		this.runWithSelection(() => {
			richTextOperations(this.edytor).setMarkAtRange(mark as RichTextMark);
		});
	}

	applyLink() {
		const href = this.linkUrl.trim();
		if (!href) this.removeLink();
		else
			this.runWithSelection(() => {
				richTextOperations(this.edytor).setLinkAtRange({ href });
				this.linkUrl = href;
			});
	}

	removeLink() {
		this.runWithSelection(() => {
			richTextOperations(this.edytor).removeLinkAtRange();
			this.linkUrl = '';
		});
	}

	private canShowForSelection(selection: EdytorSelection) {
		const { state } = selection;
		return (
			!state.isCollapsed &&
			Boolean(state.startText) &&
			Boolean(state.endText) &&
			state.texts.length > 0 &&
			selection.selectedBlocks.size === 0 &&
			selection.selectedInlineBlock.size === 0 &&
			selection.projection.voidRoot === null &&
			selection.projection.islandRoot === null
		);
	}

	private getSelectedLinkUrl(selection: EdytorSelection) {
		for (const { text, start, end } of selectedTextSpans(this.edytor, selection.state)) {
			for (const segment of text.getMarksAtRange(start, end)) {
				const href = getLinkHref(segment.marks?.link);
				if (href) return href;
			}
		}
		return '';
	}

	/** Act on the held selection, then select it again (the projector displays it). */
	private runWithSelection(callback: () => void) {
		const snapshot = this.selectionSnapshot;
		if (!this.isVisible || !snapshot) return;
		this.restoreSelection(snapshot);
		callback();
		this.restoreSelection(snapshot);
	}

	private restoreSelection(snapshot: SelectionValue) {
		this.isRestoringSelection = true;
		try {
			this.edytor.selection.select(snapshot);
		} finally {
			this.isRestoringSelection = false;
		}
	}
}
