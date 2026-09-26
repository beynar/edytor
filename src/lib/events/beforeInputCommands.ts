import type { Edytor } from '$lib/edytor.svelte.js';
import {
	replaceSelectedBlocksWithEmptyBlockTargetSync,
	replaceSelectionWithCollapsedTarget,
	replaceSelectionWithCollapsedTargetSync
} from '$lib/selection/replaceSelection.js';
import { Text } from '$lib/text/text.svelte.js';
import { scheduleRemoveStalePlaceholders } from '$lib/text/removeStalePlaceholders.js';
import {
	insertEdytorClipboardFragment,
	readEdytorClipboardFragment
} from '$lib/clipboard/clipboard.js';
import { cloneJson, type JSONText, type SerializableContent } from '$lib/utils/json.js';
import { prevent } from '$lib/utils.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { tick } from 'svelte';
import { runBeforeInputDeleteCommand } from './beforeInputDeleteCommands.js';
import type { BeforeInputSnapshot } from './beforeInputSnapshot.js';
import { isTabTextInput } from './beforeInputSnapshot.js';
import { setSuppressedInputRepairSelectionTarget } from './beforeInputRepairTarget.js';
import { firstUriListEntry } from './dataTransferPayload.js';

const createSyntheticKeyDown = (
	init: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>
): KeyboardEvent => {
	if (typeof KeyboardEvent !== 'undefined') {
		return new KeyboardEvent('keydown', init);
	}

	return {
		...init,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		preventDefault() {},
		stopPropagation() {}
	} as KeyboardEvent;
};

export const runBeforeInputHotkeyBridge = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (snapshot.inputType === 'insertLineBreak' || snapshot.inputType === 'insertParagraph') {
		if (!snapshot.event.cancelable) {
			return false;
		}

		const event = createSyntheticKeyDown({
			key: 'Enter',
			code: 'Enter',
			shiftKey: snapshot.inputType === 'insertLineBreak'
		});

		return edytor.hotKeys.isHotkey(event);
	}

	if (
		snapshot.inputType === 'deleteContentBackward' ||
		snapshot.inputType === 'deleteContentForward'
	) {
		const isForwardDelete = snapshot.inputType === 'deleteContentForward';
		const event = createSyntheticKeyDown({
			key: isForwardDelete ? 'Delete' : 'Backspace',
			code: isForwardDelete ? 'Delete' : 'Backspace',
			shiftKey: false
		});

		return edytor.hotKeys.isHotkey(event);
	}

	return false;
};

const replaceSelectionBeforeTextInsertion = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (edytor.selection.selectedBlocks.size > 0) {
		return replaceSelectedBlocksWithEmptyBlockTargetSync(edytor);
	}

	return replaceSelectionWithCollapsedTargetSync(edytor, snapshot);
};

const areSerializableValuesEqual = (
	left: SerializableContent | undefined,
	right: SerializableContent | undefined
) => JSON.stringify(left) === JSON.stringify(right);

const getSelectedTextParts = (snapshot: BeforeInputSnapshot) => {
	const parts: JSONText[] = [];

	if (snapshot.isCollapsed || !snapshot.startText || !snapshot.endText) {
		return parts;
	}

	if (snapshot.startText === snapshot.endText) {
		return snapshot.startText
			.getMarksAtRange(snapshot.yStart, snapshot.yEnd)
			.filter((part) => part.text.length > 0);
	}

	for (const text of snapshot.texts) {
		const start = text === snapshot.startText ? snapshot.yStart : 0;
		const end = text === snapshot.endText ? snapshot.yEnd : text.length;
		if (end <= start) {
			continue;
		}
		parts.push(...text.getMarksAtRange(start, end).filter((part) => part.text.length > 0));
	}

	return parts;
};

const getInsertionMarksForSelectionReplacement = (snapshot: BeforeInputSnapshot) => {
	if (snapshot.isCollapsed) {
		return undefined;
	}

	const selectedParts = getSelectedTextParts(snapshot);
	if (selectedParts.length === 0) {
		return {};
	}

	const commonMarks: Record<string, SerializableContent | null> = {
		...(selectedParts[0].marks ?? {})
	};

	for (const part of selectedParts.slice(1)) {
		const marks = part.marks ?? {};
		for (const mark of Object.keys(commonMarks)) {
			if (!areSerializableValuesEqual(commonMarks[mark] ?? undefined, marks[mark])) {
				delete commonMarks[mark];
			}
		}
	}

	return commonMarks;
};

/**
 * Marks inherited by a typed insertion at `index` when neither explicit marks
 * nor `markOnNextInsert` apply — mirrors `getMarksForInsertion` in onInput.ts:
 * the character before the caret first, then the character at the caret.
 */
const getAdjacentMarksForInsert = (text: Text, index: number) => {
	if (index > 0) {
		const before = text.getMarksAtRange(index - 1, index)[0]?.marks;
		if (before && Object.keys(before).length > 0) {
			return before;
		}
	}
	if (index < text.length) {
		const after = text.getMarksAtRange(index, index + 1)[0]?.marks;
		if (after && Object.keys(after).length > 0) {
			return after;
		}
	}
	return undefined;
};

const getMarksForTypedInsertion = (text: Text, index: number) =>
	text.markOnNextInsert ?? getAdjacentMarksForInsert(text, index);

const finishCompositionFromBeforeInput = (edytor: Edytor) => {
	edytor.compositionState = null;
	edytor.compositionStartReplacementState = null;
	edytor.isComposing = false;
	edytor.hasHandledCompositionInput = false;
};

const insertCompositionText = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const { data } = snapshot;
	if (!snapshot.startText || data === undefined) {
		return;
	}

	const compositionValue = data ?? '';
	if (!edytor.compositionState) {
		const replacementMarks = getInsertionMarksForSelectionReplacement(snapshot);
		const target = replaceSelectionBeforeTextInsertion(edytor, snapshot);
		if (!target) {
			return;
		}
		edytor.compositionState = {
			textId: target.text.id,
			startOffset: target.offset,
			value: '',
			marks: replacementMarks ?? getMarksForTypedInsertion(target.text, target.offset)
		};
	}

	const compositionText =
		edytor.getTextById(edytor.compositionState.textId) ?? edytor.selection.state.startText;
	if (!compositionText) {
		return;
	}

	if (edytor.compositionState.value.length > 0) {
		compositionText.deleteAt(
			edytor.compositionState.startOffset,
			edytor.compositionState.value.length
		);
	}

	if (compositionValue.length > 0) {
		compositionText.insertText({
			value: compositionValue,
			start: edytor.compositionState.startOffset,
			end: edytor.compositionState.startOffset,
			marks: edytor.compositionState.marks
		});
	}

	edytor.compositionState.value = compositionValue;
	await edytor.selection.setAtTextOffset(
		compositionText,
		edytor.compositionState.startOffset + compositionValue.length
	);
};

const insertFromComposition = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const compositionValue = snapshot.data ?? '';
	if (compositionValue.length === 0) {
		finishCompositionFromBeforeInput(edytor);
		return;
	}

	if (!edytor.compositionState) {
		const replacementMarks = getInsertionMarksForSelectionReplacement(snapshot);
		const target = replaceSelectionBeforeTextInsertion(edytor, snapshot);
		if (!target) {
			return;
		}

		target.text.insertText({
			value: compositionValue,
			start: target.offset,
			end: target.offset,
			marks: replacementMarks ?? getMarksForTypedInsertion(target.text, target.offset)
		});
		finishCompositionFromBeforeInput(edytor);
		await edytor.stabilizeCompositionSelection(
			target.text,
			target.offset + compositionValue.length
		);
		return;
	}

	const compositionText =
		edytor.getTextById(edytor.compositionState.textId) ?? edytor.selection.state.startText;
	if (!compositionText) {
		return;
	}

	if (edytor.compositionState.value.length > 0) {
		compositionText.deleteAt(
			edytor.compositionState.startOffset,
			edytor.compositionState.value.length
		);
	}

	compositionText.insertText({
		value: compositionValue,
		start: edytor.compositionState.startOffset,
		end: edytor.compositionState.startOffset,
		marks: edytor.compositionState.marks
	});
	const selectionOffset = edytor.compositionState.startOffset + compositionValue.length;
	finishCompositionFromBeforeInput(edytor);
	await edytor.stabilizeCompositionSelection(compositionText, selectionOffset);
};

const commitCompositionFromInsertText = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (!edytor.isComposing || snapshot.inputType !== 'insertText' || !edytor.compositionState) {
		return false;
	}

	const state = edytor.compositionState;
	const compositionText = edytor.getTextById(state.textId) ?? snapshot.startText;
	if (!compositionText) {
		return false;
	}

	const finalValue = snapshot.data ?? '';
	edytor.compositionState = null;
	edytor.isComposing = false;
	edytor.hasHandledCompositionInput = false;

	if (finalValue !== state.value) {
		if (state.value.length > 0) {
			compositionText.deleteAt(state.startOffset, state.value.length);
		}

		if (finalValue.length > 0) {
			compositionText.insertText({
				value: finalValue,
				start: state.startOffset,
				end: state.startOffset,
				marks: state.marks
			});
		}
	}

	await edytor.stabilizeCompositionSelection(
		compositionText,
		state.startOffset + finalValue.length
	);
	return true;
};

const insertText = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (
		edytor.isComposing &&
		snapshot.inputType === 'insertText' &&
		(await commitCompositionFromInsertText(edytor, snapshot))
	) {
		return;
	}

	if (isTabTextInput(snapshot)) {
		const event = createSyntheticKeyDown({
			key: 'Tab',
			code: 'Tab',
			shiftKey: false
		});
		if (edytor.hotKeys.isHotkey(event)) {
			await tick();
			return;
		}
	}

	const { data } = snapshot;
	if (!snapshot.startText || !data) {
		return;
	}

	const replacementMarks = getInsertionMarksForSelectionReplacement(snapshot);
	const target = replaceSelectionBeforeTextInsertion(edytor, snapshot);
	if (!target) {
		return;
	}
	const marks = replacementMarks ?? getMarksForTypedInsertion(target.text, target.offset);

	const autoDotPreviousCharacter = target.text.stringContent.slice(
		target.offset - 1,
		target.offset
	);
	const shouldApplyAutoDot =
		data === '. ' && target.offset > 0 && [' ', '.'].includes(autoDotPreviousCharacter);
	if (shouldApplyAutoDot) {
		target.text.insertText({
			value: data,
			start: target.offset,
			end: target.offset,
			marks,
			isAutoDot: true
		});
		setSuppressedInputRepairSelectionTarget(edytor, target.text, target.offset + 1);
		await edytor.selection.setAtTextOffset(target.text, target.offset + 1);
		await tick();
		scheduleRemoveStalePlaceholders(target.text);
		return;
	}

	target.text.insertText({ value: data, start: target.offset, end: target.offset, marks });
	setSuppressedInputRepairSelectionTarget(edytor, target.text, target.offset + data.length);
	await edytor.selection.setAtTextOffset(target.text, target.offset + data.length);
	await tick();
	scheduleRemoveStalePlaceholders(target.text);
};

const insertLineBreak = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const replacementMarks = getInsertionMarksForSelectionReplacement(snapshot);
	const target = replaceSelectionBeforeTextInsertion(edytor, snapshot);
	if (!target) {
		return;
	}

	const marks = replacementMarks ?? getMarksForTypedInsertion(target.text, target.offset);
	const sourceBlock = target.text.parent;
	const sourceParent = sourceBlock.parent;
	const sourceIndex = sourceBlock.index;
	const sourceSiblingCount = sourceParent?.children.length ?? 0;
	target.text.insertText({ value: '\n', start: target.offset, end: target.offset, marks });
	sourceBlock.normalizeContent();

	const normalizedNextBlock = sourceParent?.children[sourceIndex + 1];
	const selectionText =
		sourceParent &&
		sourceParent.children.length > sourceSiblingCount &&
		normalizedNextBlock?.type === sourceBlock.type
			? normalizedNextBlock.firstText
			: target.text;
	const selectionOffset = selectionText === target.text ? target.offset + 1 : 0;
	setSuppressedInputRepairSelectionTarget(edytor, selectionText, selectionOffset);
	await edytor.selection.setAtTextOffset(selectionText, selectionOffset);
};

const getLinkMarksForUri = (edytor: Edytor, uri: string) =>
	edytor.marks.has('link') ? { link: { href: uri } } : undefined;

const insertFromPaste = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const uri = firstUriListEntry(snapshot.dataTransfer?.getData('text/uri-list'));
	const plain = snapshot.dataTransfer?.getData('text/plain') || '';
	const value = plain || uri || '';
	if (!value) {
		return;
	}

	const target = replaceSelectionBeforeTextInsertion(edytor, snapshot);
	if (!target) {
		return;
	}

	target.text.insertText({
		value,
		start: target.offset,
		end: target.offset,
		marks: !plain && uri ? getLinkMarksForUri(edytor, uri) : undefined
	});
	setSuppressedInputRepairSelectionTarget(edytor, target.text, target.offset + value.length);
	await edytor.selection.setAtTextOffset(target.text, target.offset + value.length);
};

const runDataTransferPastePlugins = (edytor: Edytor, dataTransfer: DataTransfer) => {
	const event = { clipboardData: dataTransfer } as unknown as ClipboardEvent;
	for (const plugin of edytor.plugins) {
		plugin.onPaste?.({ prevent, e: event });
	}
};

// A drop reported while whole blocks are selected must insert at the drop
// point — not replace the block selection. The earlier target-range sync is
// skipped for block selections (the DOM caret sits inside a selected block),
// so resolve the reported range directly.
const resolveDataTransferInsertionTarget = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	if (edytor.selection.selectedBlocks.size > 0 || edytor.selection.selectedInlineBlock.size > 0) {
		const targetRange =
			typeof snapshot.event.getTargetRanges === 'function'
				? snapshot.event.getTargetRanges()[0]
				: null;
		const node = edytor.node;
		if (!targetRange || !node?.contains(targetRange.startContainer)) {
			return null;
		}
		const text = edytor.selection.getTextOfNode(
			targetRange.startContainer,
			targetRange.startOffset
		);
		if (!text) {
			return null;
		}
		const offset = Math.max(
			0,
			Math.min(getYIndex(text, targetRange.startContainer, targetRange.startOffset), text.length)
		);
		edytor.selection.setCollapsedStateAtTextOffset(text, offset);
		return { text, offset };
	}

	return replaceSelectionBeforeTextInsertion(edytor, snapshot);
};

/**
 * Drop/as-quotation payloads replay the paste pipeline: an embedded Edytor
 * fragment round-trips (cross-editor drags), files and html route through the
 * plugin `onPaste` hook (claimed via `prevent`, which throws out of this
 * function and is caught by the beforeinput caller), `text/uri-list` becomes
 * a link when a `link` mark is registered, and `text/plain` inserts as text.
 * Unclaimed files insert nothing rather than degrading to file-name text.
 */
const insertFromDataTransfer = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const dataTransfer = snapshot.dataTransfer ?? null;

	if (dataTransfer) {
		const fragment = readEdytorClipboardFragment(dataTransfer);
		if (fragment) {
			await insertEdytorClipboardFragment(edytor, fragment);
			return;
		}

		if ((dataTransfer.files?.length ?? 0) > 0) {
			runDataTransferPastePlugins(edytor, dataTransfer);
			return;
		}

		if (dataTransfer.getData('text/html')) {
			runDataTransferPastePlugins(edytor, dataTransfer);
		}
	}

	const uri = firstUriListEntry(dataTransfer?.getData('text/uri-list'));
	const plain = dataTransfer?.getData('text/plain') || '';
	const value = plain || uri || snapshot.data || '';
	if (!value) {
		return;
	}

	const target = resolveDataTransferInsertionTarget(edytor, snapshot);
	if (!target) {
		return;
	}

	target.text.insertText({
		value,
		start: target.offset,
		end: target.offset,
		marks: !plain && uri ? getLinkMarksForUri(edytor, uri) : undefined
	});
	setSuppressedInputRepairSelectionTarget(edytor, target.text, target.offset + value.length);
	await edytor.selection.setAtTextOffset(target.text, target.offset + value.length);
};

const insertParagraph = async (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	const target = await replaceSelectionWithCollapsedTarget(edytor, snapshot);
	if (!target) {
		return;
	}

	const defaultBlock = edytor.getDefaultBlock();
	const { startText, isCollapsed, isAtEndOfBlock, isAtStartOfBlock, yStart } =
		edytor.selection.state;

	if (!isCollapsed || !startText) {
		return;
	}

	try {
		if (isAtEndOfBlock) {
			const currentBlock = startText.parent;
			if (currentBlock.hasChildren && currentBlock.hasContent) {
				const currentValue = cloneJson(currentBlock.value);
				currentBlock.insertBlockBefore({
					block: {
						type: currentBlock.type,
						data: currentValue.data,
						content: currentValue.content
					}
				});
				const emptyText = new Text({
					parent: currentBlock,
					content: [{ text: '' }]
				});
				currentBlock.deleteParts(0, currentBlock.content.length);
				currentBlock.insertParts(0, [emptyText]);
				currentBlock.normalizeContent();
				const currentText = edytor.getTextById(emptyText.id) || emptyText;
				setSuppressedInputRepairSelectionTarget(edytor, currentText, 0);
				await edytor.selection.setAtTextOffset(currentText, 0);
				return;
			}

			const newBlock = currentBlock.insertBlockAfter({
				block: {
					type: defaultBlock
				}
			});
			if (newBlock) {
				setSuppressedInputRepairSelectionTarget(
					edytor,
					newBlock.firstText,
					newBlock.firstText.length
				);
				await edytor.selection.setAtTextOffset(newBlock.firstText, newBlock.firstText.length);
			}
			return;
		}

		if (isAtStartOfBlock) {
			startText.parent.insertBlockBefore({
				block: {
					type: defaultBlock
				}
			});
			setSuppressedInputRepairSelectionTarget(edytor, startText, 0);
			await edytor.selection.setAtTextOffset(startText, 0);
			return;
		}

		const newBlock = startText.parent.splitBlock({
			index: yStart,
			text: startText
		});
		if (newBlock) {
			setSuppressedInputRepairSelectionTarget(edytor, newBlock.firstText, 0);
			await edytor.selection.setAtTextOffset(newBlock.firstText, 0);
		}
	} finally {
		edytor.undoManager.stopCapturing();
	}
};

export const isCompositionInput = (inputType: InputEvent['inputType']) =>
	inputType === 'insertCompositionText' ||
	inputType === 'insertFromComposition' ||
	inputType === 'deleteCompositionText';

export const shouldRefreshDomAfterModelCommand = (snapshot: BeforeInputSnapshot) =>
	!isCompositionInput(snapshot.inputType) &&
	(snapshot.inputType === 'insertText' ||
		snapshot.inputType === 'insertReplacementText' ||
		snapshot.inputType === 'insertFromYank' ||
		snapshot.inputType === 'insertTranspose' ||
		snapshot.inputType === 'insertFromPaste' ||
		snapshot.inputType === 'insertFromPasteAsQuotation' ||
		snapshot.inputType === 'insertFromDrop');

export const runBeforeInputCommand = (edytor: Edytor, snapshot: BeforeInputSnapshot) => {
	switch (snapshot.inputType) {
		case 'insertCompositionText':
			return insertCompositionText(edytor, snapshot);
		case 'insertFromComposition':
			return insertFromComposition(edytor, snapshot);
		case 'insertTranspose':
		case 'insertFromYank':
		case 'insertReplacementText':
		case 'insertText':
			return insertText(edytor, snapshot);
		case 'deleteContentForward':
		case 'deleteContentBackward':
		case 'deleteWordBackward':
		case 'deleteSoftLineBackward':
		case 'deleteHardLineBackward':
		case 'deleteWordForward':
		case 'deleteSoftLineForward':
		case 'deleteHardLineForward':
		case 'deleteByCut':
		case 'deleteByDrag':
		case 'deleteByComposition':
		case 'deleteContent':
		case 'deleteEntireSoftLine':
			return runBeforeInputDeleteCommand(edytor, snapshot);
		case 'insertLineBreak':
			return insertLineBreak(edytor, snapshot);
		case 'insertFromPaste':
			return insertFromPaste(edytor, snapshot);
		case 'insertFromPasteAsQuotation':
		case 'insertFromDrop':
			return insertFromDataTransfer(edytor, snapshot);
		case 'insertParagraph':
			return insertParagraph(edytor, snapshot);
	}
};
