import type { Edytor } from '$lib/edytor.svelte.js';
import {
	getSelectedBlocksInDocumentOrder,
	replaceSelectionForInsertion,
	replaceSelectionWithCollapsedTarget,
	selectedBlocksLine
} from '$lib/selection/replaceSelection.js';
import type { Text } from '$lib/text/text.svelte.js';
import { readEdytorClipboardFragment } from '$lib/clipboard/clipboard.js';
import { flowOfFragment, flowOfText, pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import { flowOfHtml } from '$lib/clipboard/htmlFlow.js';
import { dropText, textDragOf } from '$lib/clipboard/moveText.js';
import { cloneJson, type JSONText } from '$lib/utils/json.js';
import { insertionMarks } from '$lib/session/editing/text.js';
import { id, vetoable } from '$lib/utils.js';
import type { Block } from '$lib/block/block.svelte.js';
import { dispatchPlan, prepareSplitKeepingChildren } from '$lib/block/block.utils.js';
import { getYIndex } from '$lib/selection/selection.utils.js';
import { runBeforeInputDeleteCommand } from './beforeInputDeleteCommands.js';
import { firstUriListEntry } from './dataTransferPayload.js';
import { INTENTS, caretAt, intentSnapshot, kindOf, type Attempt } from '$lib/session/attempt.js';

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
	return Boolean(key && key !== offered && edytor.keymap.run(key));
};

const insertText = (edytor: Edytor, snapshot: Attempt) => {
	const { data } = snapshot;
	// A text insertion while composing is the session's commit.
	if (snapshot.inputType === 'insertText' && edytor.composition.commit(data ?? '')) return;
	if (!snapshot.startText || !data) {
		return;
	}

	const marks = insertionMarks(edytor, snapshot);
	const target = replaceSelectionForInsertion(edytor, snapshot);
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
		caretAt(edytor, target.text, target.offset + 1);
		return;
	}

	target.text.insertText({ value: data, start: target.offset, end: target.offset, marks });
	caretAt(edytor, target.text, target.offset + data.length);
};

/**
 * Enter or Shift+Enter over a block selection edits the text (Notion): the
 * caret goes to the end of the first selected block's line and nothing is
 * removed; over selected voids with no line (dividers), a line after the
 * last. Answers whether there was a block selection.
 */
const editSelectedBlocks = (edytor: Edytor) => {
	const last = getSelectedBlocksInDocumentOrder(edytor).at(-1);
	if (!last) return false;
	const line = selectedBlocksLine(edytor);
	// The caret replaces the block selection; a refused new line keeps it.
	if (line) caretAt(edytor, line, line.length);
	else {
		const block = last.insertBlockAfter({ block: { type: edytor.defaultChild(last.parent!) } });
		caretAt(edytor, block?.firstText, 0);
	}
	return true;
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
	if (editSelectedBlocks(edytor)) return;
	const marks = insertionMarks(edytor, snapshot);
	const target = replaceSelectionForInsertion(edytor, snapshot);
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
	caretAt(edytor, text, offset);
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
		vetoable((prevent) => plugin.onPaste?.({ prevent, e: event }));
	}
};

/** The drop point the browser reported, in block offsets (`null`: not in a text). */
const dropPoint = (edytor: Edytor, snapshot: Attempt) => {
	const range = snapshot.declared;
	const text =
		range && edytor.node?.contains(range.startContainer)
			? edytor.selection.getTextOfNode(range.startContainer, range.startOffset)
			: null;
	if (!text) return null;
	const offset = Math.max(
		0,
		Math.min(getYIndex(text, range!.startContainer, range!.startOffset), text.length)
	);
	return { block: text.parent.id, offset: text.segStart + offset };
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
	selection.setAtTextOffset(text, offset);
	return { text, offset };
};

/**
 * Drop/as-quotation payloads replay the paste pipeline: an embedded Edytor
 * fragment round-trips (cross-editor drags), files and html route through the
 * plugin `onPaste` hook (claimed via `prevent`: the recorded veto aborts
 * this function and is caught by the beforeinput caller), `text/uri-list` becomes
 * a link when a `link` mark is registered, unclaimed `text/html` is imported,
 * and `text/plain` inserts as text.
 * Unclaimed files insert nothing rather than degrading to file-name text.
 */
const insertFromDataTransfer = async (edytor: Edytor, snapshot: Attempt) => {
	// The view's own text drag dropped here: a move (a copy with Alt) of its range.
	const drag = textDragOf(edytor);
	if (drag?.dropping && snapshot.inputType === 'insertFromDrop') {
		drag.dropping = false;
		const to = dropPoint(edytor, snapshot);
		if (to) dropText(edytor, drag, to);
		return;
	}
	const dataTransfer = snapshot.dataTransfer ?? null;
	const fragment = readEdytorClipboardFragment(dataTransfer);
	if (!fragment && dataTransfer) {
		if ((dataTransfer.files?.length ?? 0) > 0) {
			// A plugin places the files at the selection: the drop point, never over selected blocks.
			if (resolveDropPoint(edytor, snapshot) !== null)
				runDataTransferPastePlugins(edytor, dataTransfer);
			return;
		}
		if (dataTransfer.getData('text/html')) {
			runDataTransferPastePlugins(edytor, dataTransfer);
		}
	}
	const flow = fragment
		? flowOfFragment(fragment)
		: (flowOfHtml(edytor, dataTransfer?.getData('text/html')) ??
			textFlow(edytor, dataTransfer, snapshot.data ?? ''));
	const at = flow ? resolveDropPoint(edytor, snapshot) : null;
	if (flow && at !== null) await pasteFlow(edytor, flow, { at, selection: snapshot });
};

/**
 * Enter at the end of a block with content and children: a split whose tail
 * keeps the kind — a continuing kind's with its first preset's data (a new
 * to-do is unchecked), any other's with the block's (a heading's level).
 */
const liftContent = (block: Block, text: Text): Block | null => {
	const { continues, presets } = block.definition;
	const data = continues ? { ...(presets?.[0]?.data ?? {}) } : cloneJson(block.data);
	const plan = dispatchPlan(block, 'splitBlock', { index: text.length, text }, ({ index, text }) =>
		block.edytor.facade.prepare.splitBlock(block.id, text.segStart + index, id('b'), {
			type: block.type,
			data
		})
	);
	return plan && (block.edytor.idToBlock.get(plan.ids[0]!) ?? null);
};

/**
 * Enter in the middle of a container's header: the children stay with it.
 * The tail becomes its first child (its default child kind); a closed
 * toggle's goes to a toggle after it instead. One plan.
 */
const splitHeader = (block: Block, text: Text, index: number, open: boolean | undefined) => {
	const edytor = block.edytor;
	const { presets } = block.definition;
	const inside = open !== false;
	const tail = inside
		? { type: edytor.defaultChild(block), data: {} }
		: { type: block.type, data: { ...(presets?.[0]?.data ?? {}) } };
	const plan = dispatchPlan(block, 'splitBlock', { index, text }, (payload) =>
		prepareSplitKeepingChildren.call(block, payload, tail, inside)
	);
	return plan && edytor.idToBlock.get(plan.ids[0]!);
};

const insertParagraph = (edytor: Edytor, snapshot: Attempt) => {
	if (editSelectedBlocks(edytor)) return;
	// Enter in a table's cell is a line break in it: a cell never splits (`table.merge`).
	const cell = snapshot.startText?.parent;
	if (cell && edytor.facade.isTableCell(cell.id)) return insertLineBreak(edytor, snapshot);
	const target = replaceSelectionWithCollapsedTarget(edytor, snapshot);
	if (!target) {
		return;
	}
	edytor.selection.setAtTextOffset(target.text, target.offset);

	const { startText, isCollapsed, yStart } = edytor.selection.state;
	const { isAtEndOfBlock, isAtStartOfBlock } = edytor.selection.projection;

	if (!isCollapsed || !startText?.parent.parent) {
		return;
	}
	// The new sibling's actual parent decides its type.
	const defaultBlock = edytor.defaultChild(startText.parent.parent);
	const current = startText.parent;
	const { continues, presets } = current.definition;
	/** A list-like kind continues itself (a fresh to-do is unchecked); others start the default. */
	const sibling = continues
		? { type: current.type, data: { ...(presets?.[0]?.data ?? {}) } }
		: { type: defaultBlock };

	// Enter in the empty last line of a lines island (a code block) holding
	// other lines leaves it: the line goes, and the parent's default kind
	// after the island takes the caret (one step). An empty line elsewhere,
	// or the only one, is a newline.
	const island = current.parent;
	if (
		island?.parent &&
		edytor.facade.isLines(island.id) &&
		isAtStartOfBlock &&
		isAtEndOfBlock &&
		current.isEmpty &&
		current.index > 0 &&
		current.index === island.children.length - 1
	) {
		current.removeBlock();
		const after = island.insertBlockAfter({ block: { type: edytor.defaultChild(island.parent) } });
		return caretAt(edytor, after?.firstText, 0);
	}

	// Enter in an empty list-like block ends the run (Notion): out one level
	// when nested in another list-like block, else — at the top level or in a
	// container such as a callout — the parent's default kind, in place. An
	// empty item of a list leaves it, where Shift+Tab lifts it:
	// out of a nested list into the item holding it, then out of that item,
	// then out of the list.
	const item = Boolean(current.list);
	if ((continues || item) && isAtEndOfBlock && isAtStartOfBlock && !current.hasChildren) {
		if ((item || current.parent?.definition.continues) && current.unNestBlock())
			return caretAt(edytor, current.firstText, 0);
		if (item) return;
		current.setBlock({ value: { type: defaultBlock, data: {} } });
		return caretAt(edytor, current.firstText, 0);
	}

	// A container's header (toggle, callout, quote) with children, or an open
	// toggle's even without, keeps them: Enter opens a first child (Notion); a
	// closed toggle's — the browser owns `open` — a sibling after it instead.
	const open = (current.node as HTMLDetailsElement | undefined)?.open;
	const header = current.definition.container && (current.hasChildren || open);

	if (isAtEndOfBlock) {
		if (header) {
			const opened =
				open === false
					? current.insertBlockAfter({ block: sibling })
					: current.addChildBlock({ block: { type: edytor.defaultChild(current) }, index: 0 });
			return caretAt(edytor, opened?.firstText, 0);
		}
		const currentBlock = startText.parent;
		if (currentBlock.hasChildren && currentBlock.hasContent) {
			// Lift the content above the children: one split at the end whose
			// tail keeps the kind and takes the children.
			return caretAt(edytor, liftContent(currentBlock, startText)?.firstText, 0);
		}

		const newBlock = currentBlock.insertBlockAfter({ block: sibling });
		const text = newBlock?.firstText;
		return caretAt(edytor, text, text?.length ?? 0);
	}

	if (isAtStartOfBlock) {
		startText.parent.insertBlockBefore({ block: sibling });
		caretAt(edytor, startText, 0);
		return;
	}

	const newBlock = header
		? splitHeader(current, startText, yStart, open)
		: current.splitBlock({ index: yStart, text: startText });
	caretAt(edytor, newBlock?.firstText, 0);
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
