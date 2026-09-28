import type { Edytor } from '$lib/edytor.svelte.js';
import {
	replaceSelectedBlocksWithEmptyBlockTargetSync,
	replaceSelectionWithCollapsedTarget
} from '$lib/selection/replaceSelection.js';
import type { Text } from '$lib/text/text.svelte.js';
import { readEdytorClipboardFragment } from '$lib/clipboard/clipboard.js';
import { flowOfFragment, flowOfText, pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import { cloneJson, type JSONText } from '$lib/utils/json.js';
import { marksForInsertion } from '$lib/session/editing/text.js';
import { id, prevent } from '$lib/utils.js';
import type { Block } from '$lib/block/block.svelte.js';
import { dispatchPlan } from '$lib/block/block.utils.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { tick } from 'svelte';
import { runBeforeInputDeleteCommand } from './beforeInputDeleteCommands.js';
import { firstUriListEntry } from './dataTransferPayload.js';
import { INTENTS, intentSnapshot, kindOf, type Attempt } from '$lib/session/attempt.js';

/**
 * Offer an intent's key to the bindings once per occurrence (the key it stands
 * for when no keydown offered it: Android, virtual keyboards): not when its
 * keydown already offered it (`offered`). A non-cancelable intent is offered
 * too — its attempt owns the browser's drift either way.
 */
export const runBeforeInputHotkeyBridge = (
	edytor: Edytor,
	snapshot: Attempt,
	offered: string | null
) => {
	const key =
		snapshot.inputType === 'insertText' && snapshot.data === '\t'
			? 'tab'
			: INTENTS[snapshot.inputType]?.key;
	return Boolean(key && key !== offered && edytor.hotKeys.run(key));
};

const replaceSelectionBeforeTextInsertion = (edytor: Edytor, snapshot: Attempt) => {
	if (edytor.selection.selectedBlocks.size > 0) {
		return replaceSelectedBlocksWithEmptyBlockTargetSync(edytor);
	}

	return replaceSelectionWithCollapsedTarget(edytor, snapshot);
};

/** The marks of text inserted at the snapshot's selection (O29), read before it is replaced. */
export const insertionMarks = (edytor: Edytor, snapshot: Attempt) => {
	const { startText, endText, yStart, yEnd, isCollapsed } = snapshot;
	if (!startText || edytor.selection.selectedBlocks.size > 0) return {};
	const replaced = (snapshot.texts.length ? snapshot.texts : [startText]).flatMap((text) =>
		text.getMarksAtRange(text === startText ? yStart : 0, text === endText ? yEnd : text.length)
	);
	return marksForInsertion(startText, yStart, {
		replaced: isCollapsed ? undefined : replaced,
		side: snapshot.edge,
		pending: edytor.selection.pending
	});
};

const insertText = async (edytor: Edytor, snapshot: Attempt) => {
	const { data } = snapshot;
	// A text insertion while composing is the session's commit.
	if (snapshot.inputType === 'insertText' && edytor.composition.commit(data ?? '')) return;
	if (!snapshot.startText || !data) {
		return;
	}

	const marks = insertionMarks(edytor, snapshot);
	const target = replaceSelectionBeforeTextInsertion(edytor, snapshot);
	if (!target) {
		return;
	}

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
		edytor.attempts.caret(target.text, target.offset + 1);
		edytor.selection.setAtTextOffset(target.text, target.offset + 1);
		await tick();
		return;
	}

	target.text.insertText({ value: data, start: target.offset, end: target.offset, marks });
	edytor.attempts.caret(target.text, target.offset + data.length);
	edytor.selection.setAtTextOffset(target.text, target.offset + data.length);
	await tick();
};

/**
 * A soft break; the caret lands after it, or before it (Emacs open-line).
 * When normalization splits the block on the break (code lines), "after" is
 * the new block's start and "before" the source block's trailing edge.
 */
export const insertLineBreak = (
	edytor: Edytor,
	snapshot: Attempt,
	caret: 'after' | 'before' = 'after'
) => {
	const marks = insertionMarks(edytor, snapshot);
	const target = replaceSelectionBeforeTextInsertion(edytor, snapshot);
	if (!target) {
		return;
	}

	const sourceBlock = target.text.parent;
	const sourceParent = sourceBlock.parent;
	const sourceIndex = sourceBlock.index;
	const sourceSiblingCount = sourceParent?.children.length ?? 0;
	target.text.insertText({ value: '\n', start: target.offset, end: target.offset, marks });
	sourceBlock.normalizeContent();

	const normalizedNextBlock = sourceParent?.children[sourceIndex + 1];
	const split =
		sourceParent &&
		sourceParent.children.length > sourceSiblingCount &&
		normalizedNextBlock?.type === sourceBlock.type;
	const before = caret === 'before';
	const text = !split
		? target.text
		: before
			? (sourceBlock.lastText ?? target.text)
			: normalizedNextBlock.firstText!;
	const offset = !split ? target.offset + (before ? 0 : 1) : before ? text.length : 0;
	edytor.attempts.caret(text, offset);
	edytor.selection.setAtTextOffset(text, offset);
};

const getLinkMarksForUri = (edytor: Edytor, uri: string) =>
	edytor.marks.has('link') ? { link: { href: uri } } : undefined;

/** Plain text with `marks` (or a URI, as a link) as a flow (`flow.shape`). */
const textFlow = (
	edytor: Edytor,
	dataTransfer: DataTransfer | null | undefined,
	fallback = '',
	marks?: JSONText['marks']
) => {
	const uri = firstUriListEntry(dataTransfer?.getData('text/uri-list'));
	const plain = dataTransfer?.getData('text/plain') || '';
	const value = plain || uri || fallback;
	return value ? flowOfText(value, !plain && uri ? getLinkMarksForUri(edytor, uri) : marks) : null;
};

const insertFromPaste = async (edytor: Edytor, snapshot: Attempt) => {
	const flow = textFlow(edytor, snapshot.dataTransfer, '', insertionMarks(edytor, snapshot));
	if (!flow) return;
	// The paste consumes the caret's pending marks, as typing does.
	if (edytor.selection.pending) edytor.selection.stage(undefined);
	await pasteFlow(edytor, flow, { selection: snapshot });
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
// so resolve the reported range directly. `undefined`: no such selection.
const resolveDropPoint = (edytor: Edytor, snapshot: Attempt) => {
	const { selection, node } = edytor;
	if (selection.selectedBlocks.size === 0 && selection.selectedInlineBlock.size === 0) return;
	const range = snapshot.declared;
	const text =
		range && node?.contains(range.startContainer)
			? selection.getTextOfNode(range.startContainer, range.startOffset)
			: null;
	if (!text) return null;
	const offset = Math.max(
		0,
		Math.min(getYIndex(text, range!.startContainer, range!.startOffset), text.length)
	);
	selection.setCollapsedStateAtTextOffset(text, offset);
	return { text, offset };
};

/**
 * Drop/as-quotation payloads replay the paste pipeline: an embedded Edytor
 * fragment round-trips (cross-editor drags), files and html route through the
 * plugin `onPaste` hook (claimed via `prevent`, which throws out of this
 * function and is caught by the beforeinput caller), `text/uri-list` becomes
 * a link when a `link` mark is registered, and `text/plain` inserts as text.
 * Unclaimed files insert nothing rather than degrading to file-name text.
 */
const insertFromDataTransfer = async (edytor: Edytor, snapshot: Attempt) => {
	const dataTransfer = snapshot.dataTransfer ?? null;
	const fragment = readEdytorClipboardFragment(dataTransfer);
	if (!fragment && dataTransfer) {
		if ((dataTransfer.files?.length ?? 0) > 0) {
			runDataTransferPastePlugins(edytor, dataTransfer);
			return;
		}
		if (dataTransfer.getData('text/html')) {
			runDataTransferPastePlugins(edytor, dataTransfer);
		}
	}
	const flow = fragment
		? flowOfFragment(fragment)
		: textFlow(edytor, dataTransfer, snapshot.data ?? '');
	const at = flow ? resolveDropPoint(edytor, snapshot) : null;
	if (flow && at !== null) await pasteFlow(edytor, flow, { at, selection: snapshot });
};

/** Enter at the end of a block with content and children: a split whose tail keeps the kind. */
const liftContent = (block: Block, text: Text): Block | null => {
	const plan = dispatchPlan(block, 'splitBlock', { index: text.length, text }, ({ index, text }) =>
		block.edytor.facade.prepare.splitBlock(block.model!.id, text.segStart + index, id('b'), {
			type: block.type,
			data: cloneJson(block.data)
		})
	);
	return plan && (block.edytor.idToBlock.get(plan.ids[0]!) ?? null);
};

const insertParagraph = (edytor: Edytor, snapshot: Attempt) => {
	const target = replaceSelectionWithCollapsedTarget(edytor, snapshot);
	if (!target) {
		return;
	}
	edytor.selection.setAtTextOffset(target.text, target.offset);

	const { startText, isCollapsed, isAtEndOfBlock, isAtStartOfBlock, yStart } =
		edytor.selection.state;

	if (!isCollapsed || !startText?.parent.parent) {
		return;
	}
	// The new sibling's actual parent decides its type (G5, O9).
	const defaultBlock = edytor.defaultChild(startText.parent.parent);

	if (isAtEndOfBlock) {
		const currentBlock = startText.parent;
		if (currentBlock.hasChildren && currentBlock.hasContent) {
			// Lift the content above the children: one split at the end whose
			// tail keeps the kind and takes the children.
			const lifted = liftContent(currentBlock, startText);
			const text = lifted?.firstText;
			if (text) {
				edytor.attempts.caret(text, 0);
				edytor.selection.setAtTextOffset(text, 0);
			}
			return;
		}

		const newBlock = currentBlock.insertBlockAfter({
			block: {
				type: defaultBlock
			}
		});
		const text = newBlock?.firstText;
		if (text) {
			edytor.attempts.caret(text, text.length);
			edytor.selection.setAtTextOffset(text, text.length);
		}
		return;
	}

	if (isAtStartOfBlock) {
		startText.parent.insertBlockBefore({
			block: {
				type: defaultBlock
			}
		});
		edytor.attempts.caret(startText, 0);
		edytor.selection.setAtTextOffset(startText, 0);
		return;
	}

	const newBlock = startText.parent.splitBlock({
		index: yStart,
		text: startText
	});
	const text = newBlock?.firstText;
	if (text) {
		edytor.attempts.caret(text, 0);
		edytor.selection.setAtTextOffset(text, 0);
	}
};

/** The model command for a `beforeinput`, run as one user command (undo policy, prevention scope). */
export const runBeforeInputCommand = (edytor: Edytor, snapshot: Attempt) =>
	edytor.dispatcher.run(snapshot.inputType, () => beforeInputCommand(edytor, snapshot));

/** An editing intent at the current selection (a key binding's command): no event to fabricate. */
export const runIntent = (edytor: Edytor, inputType: string) =>
	runBeforeInputCommand(edytor, intentSnapshot(edytor, inputType));

const beforeInputCommand = (edytor: Edytor, snapshot: Attempt) => {
	const type = snapshot.inputType;
	switch (kindOf(type)) {
		case 'text':
			return insertText(edytor, snapshot);
		case 'delete':
			return runBeforeInputDeleteCommand(edytor, snapshot);
		case 'break':
			return type === 'insertParagraph'
				? insertParagraph(edytor, snapshot)
				: insertLineBreak(edytor, snapshot);
		case 'payload':
			return type === 'insertFromPaste'
				? insertFromPaste(edytor, snapshot)
				: insertFromDataTransfer(edytor, snapshot);
		case 'composition':
			if (type === 'insertCompositionText')
				return edytor.composition.update(snapshot.data ?? '', snapshot);
			if (type === 'insertFromComposition') return edytor.composition.commit(snapshot.data ?? '');
	}
};
