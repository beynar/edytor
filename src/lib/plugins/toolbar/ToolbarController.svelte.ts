import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorSelection } from '$lib/selection/selection.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import type { SerializableContent } from '$lib/utils/json.js';
import { richTextOperations, type RichTextMark } from '$lib/plugins/richtext/richTextOperations.js';

export type ToolbarMark = Extract<
	RichTextMark,
	'bold' | 'italic' | 'underline' | 'strike' | 'code'
>;

type ToolbarSelectionSnapshot = {
	startText: Text;
	endText: Text;
	yStart: number;
	yEnd: number;
	isReversed: boolean;
};

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
	private selectionSnapshot: ToolbarSelectionSnapshot | null = null;
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
		this.selectionSnapshot = this.createSelectionSnapshot(selection);
	}

	setLinkUrl(value: string) {
		this.linkUrl = value;
	}

	toggleMark(mark: ToolbarMark) {
		this.runWithSelection(() => {
			richTextOperations(this.edytor).setMarkAtRange(mark);
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
			const end = isLast ? yEnd : text.yText.length;

			for (const segment of text.getMarksAtRange(start, end)) {
				const href = getLinkHref(segment.marks?.link);
				if (href) {
					return href;
				}
			}
		}

		return '';
	}

	private createSelectionSnapshot(selection: EdytorSelection): ToolbarSelectionSnapshot | null {
		const { startText, endText, yStart, yEnd, isReversed } = selection.state;
		if (!startText || !endText) {
			return null;
		}

		return { startText, endText, yStart, yEnd, isReversed };
	}

	private runWithSelection(callback: () => void) {
		const snapshot = this.selectionSnapshot;
		if (!this.isVisible || !snapshot) {
			return;
		}

		this.restoreModelSelection(snapshot);
		callback();
		this.restoreSelection(snapshot);
	}

	private restoreSelection(snapshot: ToolbarSelectionSnapshot) {
		this.restoreModelSelection(snapshot);
		void this.edytor.selection
			.setAtRange(snapshot.startText, snapshot.yStart, snapshot.endText, snapshot.yEnd, {
				isReversed: snapshot.isReversed
			})
			.finally(() => {
				this.restoreModelSelection(snapshot);
			});

		const view = this.edytor.node?.ownerDocument?.defaultView;
		view?.setTimeout(() => {
			this.restoreModelSelection(snapshot);
		}, 0);
	}

	private restoreModelSelection(snapshot: ToolbarSelectionSnapshot) {
		this.isRestoringSelection = true;
		try {
			this.edytor.selection.setRangeStateAtTextOffsets(
				snapshot.startText,
				snapshot.yStart,
				snapshot.endText,
				snapshot.yEnd,
				{ isReversed: snapshot.isReversed }
			);
		} finally {
			this.isRestoringSelection = false;
		}
	}
}
