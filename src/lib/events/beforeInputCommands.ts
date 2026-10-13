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
import { cloneJson, type JSONBlock } from '$lib/utils/json.js';
import { insertionMarks } from '$lib/session/editing/text.js';
import { id, vetoable } from '$lib/utils.js';
import type { Block } from '$lib/block/block.svelte.js';
import { siblingSlot } from '$lib/session/handles.js';
import type { OpResult, Plan, Prepared } from '$lib/crdt/edytor-doc.js';
import type { SplitTail } from '$lib/crdt/placement/model.js';
import { REFUSED } from '$lib/crdt/doc/plan.js';
import { offsetIn } from '$lib/selection/selection.utils.js';
import { bodyShows } from '$lib/selection/visibility.js';
import { runBeforeInputDeleteCommand } from './beforeInputDeleteCommands.js';
import { firstUriListEntry } from './dataTransferPayload.js';
import {
	caretAt,
	intentSnapshot,
	kindOf,
	type Attempt,
	type DropAt
} from '$lib/session/attempt.js';

/** A kind's fresh data: its first preset's (a new to-do is unchecked). */
const freshData = (block: Block): NonNullable<JSONBlock['data']> => ({
	...(block.definition.presets?.[0]?.data ?? {})
});

/**
 * The line Enter starts after `block` (a split's tail, a new sibling): a
 * list-like kind (`continues`) itself, with fresh data; any other, its
 * parent's default child.
 */
const nextLine = (block: Block): JSONBlock =>
	block.definition.continues
		? { type: block.type, data: freshData(block) }
		: { type: block.edytor.defaultChild(block.parent!) };

/** The block an operation answered first (inserted, split off), once written. */
const blockOf = (edytor: Edytor, result: OpResult) => edytor.idToBlock.get(result.ids[0] ?? '');

/**
 * Type `value` at the insertion target (the selection it replaces removed
 * first) with the insertion's marks; `. ` after a space or a dot replaces
 * it (the auto-dot: autocorrect replaces the character before). Answers
 * where it went.
 */
const type = (edytor: Edytor, snapshot: Attempt, value: string) => {
	const marks = insertionMarks(edytor, snapshot);
	const target = replaceSelectionForInsertion(edytor, snapshot);
	if (!target) return null;
	const { text, offset } = target;
	const isAutoDot = value === '. ' && offset > 0 && ' .'.includes(text.stringContent[offset - 1]);
	const at = text.segStart + offset - (isAutoDot ? 1 : 0);
	if (isAutoDot) edytor.deleteText(text.parent.id, at, 1);
	edytor.insertText(text.parent.id, at, value, marks);
	return { text, offset, end: offset + (isAutoDot ? 1 : value.length) };
};

const insertText = (edytor: Edytor, snapshot: Attempt) => {
	const { data } = snapshot;
	// A text insertion while composing is the session's commit.
	if (snapshot.inputType === 'insertText' && edytor.composition.commit(data ?? '')) return;
	const at = snapshot.startText && data && type(edytor, snapshot, data);
	if (at) caretAt(edytor, at.text, at.end);
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
		const line = { type: edytor.defaultChild(last.parent!) };
		caretAt(edytor, blockOf(edytor, edytor.insertBlocks(siblingSlot(last), [line]))?.firstText, 0);
	}
	return true;
};

/**
 * A soft break; the caret lands after it, or before it (Emacs open-line).
 * When normalization splits the block on the break (code lines: the break is
 * gone from its text), "after" is the new block's start and "before" the
 * source block's trailing edge.
 */
export const insertLineBreak = (
	edytor: Edytor,
	snapshot: Attempt,
	caret: 'after' | 'before' = 'after'
) => {
	if (editSelectedBlocks(edytor)) return;
	const at = type(edytor, snapshot, '\n');
	if (!at) return;
	const { text, offset } = at;
	const block = text.parent;
	const before = caret === 'before';
	if (text.stringContent[offset] === '\n') return caretAt(edytor, text, offset + (before ? 0 : 1));
	const line = before
		? (block.lastText ?? text)
		: block.parent?.children[block.index + 1]?.firstText;
	caretAt(edytor, line, before ? (line?.length ?? 0) : 0);
};

const runPastePlugins = (edytor: Edytor, dataTransfer: DataTransfer, at?: DropAt) => {
	const event = { clipboardData: dataTransfer } as unknown as ClipboardEvent;
	for (const plugin of edytor.plugins)
		vetoable((prevent) => plugin.onPaste?.({ prevent, e: event, ...(at && { at }) }));
};

/** The drop point the browser reported: its text and offset (`null`: not in a text). */
const dropPoint = (edytor: Edytor, { declared: range }: Attempt) => {
	const text =
		range && edytor.node?.contains(range.startContainer)
			? edytor.selection.getTextOfNode(range.startContainer, range.startOffset)
			: null;
	return text && { text, offset: offsetIn(text, range!.startContainer, range!.startOffset) };
};

/**
 * A paste occurrence inserts the plain text (or the URI, as a link) the
 * paste handler left to it. A drop replays the paste pipeline: an embedded Edytor
 * fragment round-trips (cross-editor drags), files and html route through the
 * plugin `onPaste` hook (claimed via `prevent`: the recorded veto aborts
 * this function and is caught by the beforeinput caller), unclaimed
 * `text/html` is imported, `text/plain` inserts as text and `text/uri-list`
 * as a link when a `link` mark is registered. Unclaimed files insert nothing
 * rather than degrading to file-name text. A paste's text takes the caret's
 * insertion marks and consumes its pending ones, as typing does. A drop over
 * selected blocks or an atom lands at its point (the declared-range sync
 * skips a block selection: the DOM caret sits in a selected block), never
 * over them; the view's own text drag dropped is a move (a copy with Alt) of
 * its range.
 */
const insertPayload = async (edytor: Edytor, snapshot: Attempt) => {
	const { selection } = edytor;
	const paste = snapshot.inputType === 'insertFromPaste';
	const point = dropPoint(edytor, snapshot);
	const drag = textDragOf(edytor);
	if (drag?.dropping && snapshot.inputType === 'insertFromDrop') {
		drag.dropping = false;
		if (point)
			dropText(edytor, drag, {
				block: point.text.parent.id,
				offset: point.text.segStart + point.offset
			});
		return;
	}
	// `undefined`: no block or atom selection for the drop to land beside.
	const land = () => {
		if (paste || !(selection.selectedBlocks.size || selection.selectedInlineBlock.size)) return;
		if (point) selection.selectText(point.text, point.offset);
		return point;
	};
	const dataTransfer = snapshot.dataTransfer ?? null;
	// A paste occurrence is the plain text its handler left to it (Shift-paste too).
	const fragment = !paste && readEdytorClipboardFragment(dataTransfer);
	if (!paste && !fragment && dataTransfer) {
		// A plugin places the files at the drop indicator's placement, else at the
		// selection: the drop point, never over selected blocks.
		if (dataTransfer.files?.length) {
			if (snapshot.placement) return void runPastePlugins(edytor, dataTransfer, snapshot.placement);
			return void (land() !== null && runPastePlugins(edytor, dataTransfer));
		}
		if (dataTransfer.getData('text/html')) runPastePlugins(edytor, dataTransfer);
	}
	const uri = firstUriListEntry(dataTransfer?.getData('text/uri-list'));
	const plain = dataTransfer?.getData('text/plain') || '';
	const text = plain || uri || snapshot.data || '';
	const flow = fragment
		? flowOfFragment(fragment)
		: (!paste && flowOfHtml(edytor, dataTransfer?.getData('text/html'))) ||
			(text
				? flowOfText(
						text,
						!plain && uri
							? edytor.marks.has('link')
								? { link: { href: uri } }
								: undefined
							: paste
								? insertionMarks(edytor, snapshot)
								: undefined
					)
				: null);
	if (!flow) return;
	const at = land();
	if (at === null) return;
	if (paste && selection.pending) selection.stage(undefined);
	await pasteFlow(edytor, flow, { at, selection: snapshot });
};

/**
 * Enter at the end of a block with content and children: a split whose tail
 * keeps the kind — a continuing kind's with its first preset's data (a new
 * to-do is unchecked), any other's with the block's (a heading's level).
 */
const liftContent = (block: Block, text: Text) => {
	const { edytor } = block;
	const data = block.definition.continues ? freshData(block) : cloneJson(block.data);
	const tail = { type: block.type, data };
	return blockOf(edytor, edytor.splitBlock(block.id, text.segStart + text.length, id('b'), tail));
};

/**
 * A split whose children stay with the block (a container's header): the
 * tail becomes the block's first child (`child`) or its next sibling. One
 * plan: the document's split step, placed there, without the move that
 * gives the tail the children.
 */
const splitKeepingChildren = (
	edytor: Edytor,
	[id, offset, born, tail]: [string, number, string, SplitTail?],
	child: boolean
): Prepared => {
	const { facade } = edytor;
	const split = facade.prepare.splitBlock(id, offset, born, tail);
	const step = 'writes' in split ? split.writes[0] : undefined;
	if (step?.op !== 'splitBlock') return REFUSED;
	if (!child) return facade.compose({ ...(split as Plan), writes: [step] });
	// The rank of a first child, and the document's answer on placing the kind there.
	const slot = facade.prepare.insertBlocks({ parent: id, index: 0 }, [
		{ id: born, type: tail?.type ?? facade.defaultChild(id) }
	]);
	const first = 'writes' in slot ? slot.writes[0] : undefined;
	if (first?.op !== 'insertBlocks') return REFUSED;
	const placed = { ...step, parent: id, rank: first.ranks[0]! };
	return facade.compose({ ...(split as Plan), writes: [placed] });
};

/**
 * Enter in the middle of a container's header: the children stay with it.
 * The tail becomes its first child (its default child kind); a closed
 * toggle's goes to a toggle after it instead. One plan, dispatched as the
 * `splitBlock` it is.
 */
const splitHeader = (block: Block, text: Text, index: number, open: boolean | undefined) => {
	const { edytor } = block;
	const inside = open !== false;
	const tail = inside
		? { type: edytor.defaultChild(block), data: {} }
		: { type: block.type, data: freshData(block) };
	const args: [string, number, string, SplitTail] = [
		block.id,
		text.segStart + index,
		id('b'),
		tail
	];
	const split = (a: typeof args) => splitKeepingChildren(edytor, a, inside);
	return blockOf(edytor, edytor.dispatcher.plan('splitBlock', args, split, block));
};

const insertParagraph = (edytor: Edytor, snapshot: Attempt) => {
	if (editSelectedBlocks(edytor)) return;
	// Enter in a table's cell is a line break in it: a cell never splits (`table.merge`).
	const cell = snapshot.startText?.parent;
	if (cell && edytor.facade.isTableCell(cell.id)) return insertLineBreak(edytor, snapshot);
	const target = replaceSelectionWithCollapsedTarget(edytor, snapshot);
	if (!target?.text.parent.parent) return;
	const { text: startText, offset: yStart } = target;
	edytor.selection.selectText(startText, yStart);
	const { isAtEndOfBlock, isAtStartOfBlock } = edytor.selection.projection;
	// The new sibling's actual parent decides its type.
	const defaultBlock = edytor.defaultChild(startText.parent.parent!);
	const current = startText.parent;
	const { continues } = current.definition;
	const sibling = nextLine(current);

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
		edytor.deleteBlock(current.id);
		const line = { type: edytor.defaultChild(island.parent) };
		const after = blockOf(edytor, edytor.insertBlocks(siblingSlot(island), [line]));
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
		const outdents = item || current.parent?.definition.continues;
		if (outdents && edytor.unNestBlock(current.id).status === 'applied')
			return caretAt(edytor, current.firstText, 0);
		if (item) return;
		edytor.setBlock(current.id, { type: defaultBlock, data: {} });
		return caretAt(edytor, current.firstText, 0);
	}

	// A container's header whose body shows (`body.enter`: one with children, an
	// open toggle, a callout) keeps it: Enter opens a first child (Notion); a
	// closed toggle's — the browser owns `open` — a sibling after it instead.
	const open = (current.node as HTMLDetailsElement | undefined)?.open;
	const header = current.definition.container && (current.hasChildren || bodyShows(current));

	if (isAtEndOfBlock) {
		if (header) {
			const opened =
				open === false
					? edytor.insertBlocks(siblingSlot(current), [sibling])
					: edytor.insertBlocks({ parent: current.id, index: 0 }, [
							{ type: edytor.defaultChild(current) }
						]);
			return caretAt(edytor, blockOf(edytor, opened)?.firstText, 0);
		}
		const currentBlock = startText.parent;
		if (currentBlock.hasChildren && currentBlock.hasContent) {
			// Lift the content above the children: one split at the end whose
			// tail keeps the kind and takes the children.
			return caretAt(edytor, liftContent(currentBlock, startText)?.firstText, 0);
		}

		const newBlock = blockOf(edytor, edytor.insertBlocks(siblingSlot(currentBlock), [sibling]));
		const text = newBlock?.firstText;
		return caretAt(edytor, text, text?.length ?? 0);
	}

	if (isAtStartOfBlock) {
		edytor.insertBlocks(siblingSlot(startText.parent, false), [sibling]);
		caretAt(edytor, startText, 0);
		return;
	}

	const newBlock = header
		? splitHeader(current, startText, yStart, open)
		: blockOf(edytor, edytor.splitBlock(current.id, startText.segStart + yStart, id('b'), sibling));
	caretAt(edytor, newBlock?.firstText, 0);
};

/** The model command for a `beforeinput`, run as one user command (undo policy, prevention scope). */
export const runBeforeInputCommand = (edytor: Edytor, snapshot: Attempt) =>
	edytor.dispatcher.run(snapshot.inputType, () => {
		const { inputType, data } = snapshot;
		switch (kindOf(inputType)) {
			case 'text':
				return insertText(edytor, snapshot);
			case 'delete':
				return runBeforeInputDeleteCommand(edytor, snapshot);
			case 'break':
				return inputType === 'insertParagraph'
					? insertParagraph(edytor, snapshot)
					: insertLineBreak(edytor, snapshot);
			case 'payload':
				return insertPayload(edytor, snapshot);
			case 'composition':
				if (inputType === 'insertCompositionText')
					return edytor.composition.update(data ?? '', snapshot);
				if (inputType === 'insertFromComposition') return edytor.composition.commit(data ?? '');
		}
	});

/** An editing intent at the current selection (a key binding's command): no event to fabricate. */
export const runIntent = (edytor: Edytor, inputType: string) =>
	runBeforeInputCommand(edytor, intentSnapshot(edytor, inputType));
