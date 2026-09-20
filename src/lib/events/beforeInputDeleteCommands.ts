import type { Edytor } from '$lib/edytor.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { BeforeInputSnapshot } from './beforeInputSnapshot.js';
import { setSuppressedInputRepairSelectionTarget } from './beforeInputRepairTarget.js';

const isForwardDeleteInsideActiveComposition = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const state = edytor.compositionState;
	if (
		!edytor.isComposing ||
		!state ||
		snapshot.inputType !== 'deleteContentForward' ||
		!snapshot.isCollapsed ||
		snapshot.startText?.id !== state.textId
	) {
		return false;
	}

	return (
		snapshot.yStart >= state.startOffset &&
		snapshot.yStart <= state.startOffset + state.value.length
	);
};

const deleteContentForward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;
	if (!startText) {
		return;
	}

	if (isForwardDeleteInsideActiveComposition(edytor, snapshot)) {
		await edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	if (snapshot.isBlockSpanning) {
		const [targetText, targetOffset] = edytor.deleteContentWithinSelection({});
		if (!targetText) {
			return;
		}
		await edytor.selection.setAtTextOffset(targetText, targetOffset);
		return;
	}

	if (snapshot.isCollapsed && snapshot.isAtEndOfBlock) {
		const currentBlock = startText.parent;
		if (currentBlock.definition.void) {
			await edytor.selection.setAtTextOffset(startText, yStart);
			return;
		}

		const nextBlock = currentBlock.closestNextBlock;
		if (nextBlock?.definition.void) {
			edytor.selection.selectBlocks(nextBlock);
			return;
		}

		currentBlock.mergeBlockForward();
		setSuppressedInputRepairSelectionTarget(edytor, startText, yStart);
		await edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	if (snapshot.isCollapsed && snapshot.isAtEndOfText) {
		const index = startText.parent.content.indexOf(startText) + 1;
		startText.parent.removeInlineBlock({ index });
		await edytor.selection.setAtTextOffset(startText, yStart);
		return;
	}

	if (snapshot.isTextSpanning) {
		const firstText = snapshot.texts[0];
		const lastText = snapshot.texts.at(-1);
		if (!firstText || !lastText) {
			return;
		}
		firstText.parent.deleteContentAtRange({
			start: [firstText.index, yStart],
			end: [lastText.index, snapshot.yEnd]
		});
		await edytor.selection.setAtTextOffset(firstText, yStart);
		return;
	}

	startText.deleteText({ direction: 'FORWARD', length: snapshot.length || 1 });
	await edytor.selection.setAtTextOffset(startText, yStart);
};

const deleteContentBackward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;

	if (
		snapshot.isCollapsed &&
		snapshot.isAtStartOfBlock &&
		snapshot.isFirstChildOfDocument &&
		startText?.parent.isEmpty
	) {
		await edytor.selection.setAtTextOffset(startText, 0);
		return;
	}

	if (snapshot.isBlockSpanning) {
		const [targetText, targetOffset] = edytor.deleteContentWithinSelection({});
		if (!targetText) {
			return;
		}
		await edytor.selection.setAtTextOffset(targetText, targetOffset);
		return;
	}

	if (!startText) {
		return;
	}

	if (snapshot.isCollapsed && snapshot.isAtStartOfBlock) {
		if (snapshot.isNested && snapshot.isLastChild && !snapshot.islandRoot) {
			const newBlock = startText.parent.unNestBlock();
			if (newBlock) {
				await edytor.selection.setAtTextOffset(newBlock.firstText, 0);
			}
			return;
		}

		if (snapshot.islandRoot && snapshot.islandRoot.children.length === 1) {
			edytor.selection.selectBlocks(snapshot.islandRoot);
			return;
		}

		if (
			snapshot.islandRoot &&
			snapshot.islandRoot.children.length > 1 &&
			startText.parent.index === 0
		) {
			return;
		}

		const previousBlock = startText.parent.closestPreviousBlock;
		if (previousBlock?.definition.void) {
			edytor.selection.selectBlocks(previousBlock);
			return;
		}

		const previousText = previousBlock?.lastText;
		const offset = previousText?.length;
		startText.parent.mergeBlockBackward();
		if (previousText && typeof offset === 'number') {
			setSuppressedInputRepairSelectionTarget(edytor, previousText, offset);
			await edytor.selection.setAtTextOffset(previousText, offset);
		}
		return;
	}

	if (snapshot.isCollapsed && snapshot.isAtStartOfText) {
		const index = startText.parent.content.indexOf(startText) - 1;
		const previousText = startText.parent.content.at(index - 1);
		const hasPreviousText = previousText && previousText instanceof Text;
		const offset = hasPreviousText ? previousText.yText.length : 0;
		startText.parent.removeInlineBlock({ index });
		if (hasPreviousText) {
			await edytor.selection.setAtTextOffset(previousText, offset);
		}
		return;
	}

	if (snapshot.isTextSpanning) {
		const firstText = snapshot.texts[0];
		const lastText = snapshot.texts.at(-1);
		if (!firstText || !lastText) {
			return;
		}
		firstText.parent.deleteContentAtRange({
			start: [firstText.index, yStart],
			end: [lastText.index, snapshot.yEnd]
		});
		await edytor.selection.setAtTextOffset(firstText, yStart);
		return;
	}

	const deletion = startText.deleteText({ direction: 'BACKWARD', length: snapshot.length || 1 });
	await edytor.selection.setAtTextOffset(
		startText,
		snapshot.isCollapsed ? (deletion?.start ?? yStart - 1) : yStart
	);
};

const getPreviousWordStartOffset = (value: string, offset: number) => {
	const beforeCaret = value.slice(0, offset);
	const match = beforeCaret.match(/\S+\s*$/u);
	return match?.index ?? offset;
};

const getNextWordEndOffset = (value: string, offset: number) => {
	const afterCaret = value.slice(offset);
	const match = afterCaret.match(/^\s*\S+/u);
	return match ? offset + match[0].length : offset;
};

const deleteCollapsedWordBackward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;
	if (!startText) {
		return;
	}

	const start = getPreviousWordStartOffset(startText.stringContent, yStart);
	startText.deleteText({ direction: 'BACKWARD', length: yStart - start });
	await edytor.selection.setAtTextOffset(startText, start);
};

const deleteCollapsedWordForward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;
	if (!startText) {
		return;
	}

	const end = getNextWordEndOffset(startText.stringContent, yStart);
	startText.deleteText({ direction: 'FORWARD', length: end - yStart });
	await edytor.selection.setAtTextOffset(startText, yStart);
};

const deleteCollapsedLineBackward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;
	if (!startText) {
		return;
	}

	const firstText = startText.parent.firstText;
	firstText.parent.deleteContentAtRange({
		start: [firstText.index, 0],
		end: [startText.index, yStart]
	});
	await edytor.selection.setAtTextOffset(firstText, 0);
};

const deleteCollapsedLineForward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { startText, yStart } = snapshot;
	if (!startText) {
		return;
	}

	const lastText = startText.parent.lastText;
	startText.parent.deleteContentAtRange({
		start: [startText.index, yStart],
		end: [lastText.index, lastText.length]
	});
	await edytor.selection.setAtTextOffset(startText, yStart);
};

const deleteAdvancedBackward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (!snapshot.isCollapsed) {
		return deleteContentBackward(edytor, snapshot);
	}

	return snapshot.inputType === 'deleteWordBackward'
		? deleteCollapsedWordBackward(edytor, snapshot)
		: deleteCollapsedLineBackward(edytor, snapshot);
};

const deleteAdvancedForward = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (!snapshot.isCollapsed) {
		return deleteContentForward(edytor, snapshot);
	}

	return snapshot.inputType === 'deleteWordForward'
		? deleteCollapsedWordForward(edytor, snapshot)
		: deleteCollapsedLineForward(edytor, snapshot);
};

const deleteFragment = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (snapshot.isCollapsed) {
		return;
	}

	return deleteContentBackward(edytor, snapshot);
};

const deleteContent = async (edytor: Edytor, snapshot: BeforeInputSnapshot) =>
	deleteContentForward(edytor, snapshot);

const deleteEntireSoftLine = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (!snapshot.isCollapsed) {
		return deleteContentForward(edytor, snapshot);
	}

	const { startText } = snapshot;
	if (!startText) {
		return;
	}

	const firstText = startText.parent.firstText;
	const lastText = startText.parent.lastText;
	firstText.parent.deleteContentAtRange({
		start: [firstText.index, 0],
		end: [lastText.index, lastText.length]
	});
	await edytor.selection.setAtTextOffset(firstText, 0);
};

export const runBeforeInputDeleteCommand = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	switch (snapshot.inputType) {
		case 'deleteContentForward':
			return deleteContentForward(edytor, snapshot);
		case 'deleteContentBackward':
			return deleteContentBackward(edytor, snapshot);
		case 'deleteWordBackward':
		case 'deleteSoftLineBackward':
		case 'deleteHardLineBackward':
			return deleteAdvancedBackward(edytor, snapshot);
		case 'deleteWordForward':
		case 'deleteSoftLineForward':
		case 'deleteHardLineForward':
			return deleteAdvancedForward(edytor, snapshot);
		case 'deleteByCut':
		case 'deleteByDrag':
		case 'deleteByComposition':
			return deleteFragment(edytor, snapshot);
		case 'deleteContent':
			return deleteContent(edytor, snapshot);
		case 'deleteEntireSoftLine':
			return deleteEntireSoftLine(edytor, snapshot);
	}
};
