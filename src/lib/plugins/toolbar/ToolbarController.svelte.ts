import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import type { SelectionValue } from '$lib/session/selection.js';
import type { SerializableContent } from '$lib/utils/json.js';
import { richTextOperations, type RichTextMark } from '$lib/plugins/richtext/richTextOperations.js';

const isRecord = (
	value: SerializableContent | undefined
): value is Record<string, SerializableContent> => typeof value === 'object' && value !== null;

const getLinkHref = (value: SerializableContent | undefined) => {
	if (!isRecord(value)) {
		return null;
	}
	return typeof value.href === 'string' ? value.href : null;
};

export class ToolbarController {
	isVisible = $state(false);
	linkUrl = $state('');
	/** The selection the toolbar acts on: a value (anchors), so peers' edits move it (L52). */
	private selectionSnapshot: SelectionValue | null = null;
	private isRestoringSelection = false;

	constructor(private edytor: Edytor) {}

	updateFromSelection(selection = this.edytor.selection) {
		if (!this.canShowForSelection(selection)) {
			this.isVisible = false;
			this.linkUrl = '';
			this.selectionSnapshot = null;
			return;
		}

		this.isVisible = true;
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
			!this.edytor.readonly &&
			!state.isCollapsed &&
			Boolean(state.startText) &&
			Boolean(state.endText) &&
			state.texts.length > 0 &&
			selection.selectedBlocks.size === 0 &&
			selection.selectedInlineBlock.size === 0 &&
			!state.isVoid &&
			!state.isIsland
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
