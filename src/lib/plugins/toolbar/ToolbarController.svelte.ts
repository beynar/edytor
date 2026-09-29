import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import type { SelectionValue } from '$lib/session/selection.js';
import { isRecord, type SerializableContent } from '$lib/utils/json.js';
import { richTextOperations, type RichTextMark } from '$lib/plugins/richtext/richTextOperations.js';
import {
	convertBlocks,
	convertibleKinds,
	rowOf,
	selectionBlocks,
	type KindRow
} from '$lib/kinds.js';

/** Notion's palette: text colors and their backgrounds, by name. */
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

const getLinkHref = (value: SerializableContent | undefined) => {
	if (!isRecord(value)) {
		return null;
	}
	return typeof value.href === 'string' ? value.href : null;
};

export class ToolbarController {
	/** Shown for the current selection; hidden while the editor is readonly. */
	private shown = $state(false);
	linkUrl = $state('');
	/** The open panel: the kind menu, the link field or the colors. */
	panel = $state<null | 'turn' | 'link' | 'color'>(null);
	/** The selection the toolbar acts on: a value (anchors), so peers' edits move it (L52). */
	private selectionSnapshot: SelectionValue | null = null;
	private isRestoringSelection = false;

	constructor(private edytor: Edytor) {}

	get isVisible() {
		return this.shown && !this.edytor.readonly;
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
		if (!this.isRestoringSelection) {
			this.linkUrl = this.getSelectedLinkUrl(selection);
		}
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
		const { texts, yStart, yEnd } = this.edytor.selection.state;
		const runs = texts
			.flatMap((text, index) =>
				text.getMarksAtRange(index ? 0 : yStart, index < texts.length - 1 ? text.length : yEnd)
			)
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
	}

	/** Convert every block the selection touches (Notion), as one undo step. */
	turnInto(kind: KindRow) {
		this.panel = null;
		this.runWithSelection(() => convertBlocks(this.edytor, selectionBlocks(this.edytor), kind));
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
		this.runWithSelection(() => {
			richTextOperations(this.edytor).setMarkAtRange(mark as RichTextMark);
		});
	}

	applyLink() {
		const href = this.linkUrl.trim();
		if (!href) {
			this.removeLink();
			return;
		}

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
		const { texts, yStart, yEnd } = selection.state;

		for (const [index, text] of texts.entries()) {
			const isFirst = index === 0;
			const isLast = index === texts.length - 1;
			const start = isFirst ? yStart : 0;
			const end = isLast ? yEnd : text.length;

			for (const segment of text.getMarksAtRange(start, end)) {
				const href = getLinkHref(segment.marks?.link);
				if (href) {
					return href;
				}
			}
		}

		return '';
	}

	/** Act on the held selection, then select it again (the projector displays it). */
	private runWithSelection(callback: () => void) {
		const snapshot = this.selectionSnapshot;
		if (!this.isVisible || !snapshot) {
			return;
		}

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
