/**
 * Navigation: one ordered stream of
 * caret stops and one apply step for every horizontal navigation key.
 *
 * The stream is the document order of the displayable blocks (a
 * Surface fact: a collapsed toggle's body or a phantom content slot holds no
 * stop), each block's stops in block offsets (an inline atom counts 1, as
 * the projection's points): grapheme (or word) boundaries inside its texts,
 * the inline atoms between them. A key
 * names a unit (grapheme, word, block edge, document edge) and a direction;
 * the arrow and word keys are visual, resolved once from the focus text's
 * computed direction (RTL).
 *
 * The apply step: a plain key moves the caret (a range or an atom collapses
 * onto its edge in the key's direction); a Shift key moves the focus and
 * keeps the anchor; a range that covers exactly one atom is that atom's
 * selection. A grapheme step inside the focus's own text is left to the
 * browser (it moves visually under bidi) unless the selection came from a
 * node-bound native range, whose extension engines disagree on, or the
 * step starts right after a soft break (Firefox moves nothing there).
 * Vertical extension (Shift+ArrowUp/Down) crosses blocks through the same
 * displayable walk; plain vertical motion stays native, unless the browser
 * lands it on no caret stop (`landed`).
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import {
	getNextGraphemeEnd,
	getNextWordEndOffset,
	getPreviousGraphemeStart,
	getPreviousWordStartOffset
} from '$lib/text/wordBoundary.js';
import { getSelectedBlocksInDocumentOrder, shownText } from '$lib/selection/replaceSelection.js';
import type { HotKey } from './keymap.js';
import {
	atomSelection,
	pointOf,
	segmentsOf,
	type SelectionPoint,
	type SelectionValue
} from './selection.js';
import { untargeted } from './attempt.js';
import { siblingSlot } from './handles.js';
import { partsOf } from '$lib/crdt/parts.js';

/**
 * With no target (`untargeted`: the value is `none`, no gesture placed the
 * host's caret), a navigation key does nothing (Notion): it is claimed, so
 * the browser places no caret of its own to type at. The page keys keep
 * scrolling the page (a caret they park is never adopted, `projector.placed`).
 */
export const stayWithoutTarget = (edytor: Edytor, prevent: () => void) => {
	if (untargeted(edytor)) prevent();
};

/** A caret stop: a block and an offset in its content (an inline atom counts 1). */
type Stop = SelectionPoint;
export type Dir = 1 | -1;
type Unit = 'char' | 'word' | 'line' | 'doc';

/** An inline atom in a block's string. */
const ATOM = '￼';

/** A block's content as one string, each inline atom one `ATOM`. */
const stringOf = (edytor: Edytor, block: string) =>
	partsOf(edytor.facade.runs(block))
		.map((part) => (part.kind === 'text' ? part.text : ATOM))
		.join('');

/** A block's stop at its edge in `dir` (its end going forward, its start going backward). */
const edge = (edytor: Edytor, block: string, dir: Dir): Stop => ({
	block,
	offset: dir > 0 ? edytor.facade.displayLength(block) : 0
});

/** The first displayable block after `from` in document order (`from` null: the document's edge). */
const displayable = (edytor: Edytor, from: string | null, dir: Dir): string | null => {
	const ids = edytor.facade.order();
	const at = from ? ids.indexOf(from) : dir > 0 ? -1 : ids.length;
	for (let i = at + dir; i >= 0 && i < ids.length; i += dir)
		if (edytor.selection.displayable(ids[i]!)) return ids[i]!;
	return null;
};

/**
 * The next stop from `at`: a grapheme or word boundary inside its text (the
 * run between the atoms around it), else the near side of the atom next to
 * it, else the near edge of the next displayable block.
 */
const step = (
	edytor: Edytor,
	{ block, offset }: Stop,
	dir: Dir,
	unit: 'char' | 'word'
): Stop | null => {
	const value = stringOf(edytor, block);
	const from = offset && value.lastIndexOf(ATOM, offset - 1) + 1;
	const to = value.indexOf(ATOM, offset);
	const text = value.slice(from, to < 0 ? undefined : to);
	const at = offset - from;
	if (dir > 0 ? at < text.length : at > 0) {
		const next =
			unit === 'word'
				? (dir > 0 ? getNextWordEndOffset : getPreviousWordStartOffset)(text, at)
				: (dir > 0 ? getNextGraphemeEnd : getPreviousGraphemeStart)(text, at);
		if (next !== at) return { block, offset: from + next };
	}
	if (value[dir > 0 ? offset : offset - 1] === ATOM) return { block, offset: offset + dir };
	const next = displayable(edytor, block, dir);
	return next ? edge(edytor, next, -dir as Dir) : null;
};

const compare = (edytor: Edytor, a: Stop, b: Stop) =>
	a.block === b.block ? a.offset - b.offset : edytor.facade.compare(a.block, b.block);

/** Select `anchor` → `focus`: a caret, the one atom the range covers, or the range. */
const select = (edytor: Edytor, anchor: Stop, focus: Stop) => {
	const { selection } = edytor;
	const order = compare(edytor, anchor, focus);
	const [start, end] = order > 0 ? [focus, anchor] : [anchor, focus];
	const atom =
		start.block === end.block && end.offset - start.offset === 1
			? segmentsOf(edytor.facade, start.block).find(
					(part) => part.kind === 'inline' && part.start === start.offset
				)
			: null;
	if (atom?.kind === 'inline')
		return selection.select(atomSelection(start.block, atom.id, order > 0 ? 'after' : 'before'));
	selection.selectAt(start, end, order > 0);
};

/**
 * One apply step for `unit` in `dir` (`left`/`right`: visual). Answers whether
 * the step is the editor's: a grapheme step the browser takes itself (inside
 * one text, or collapsing a text range) is not claimed; the other units are
 * claimed whenever there is a text selection.
 */
export const move = (
	edytor: Edytor,
	unit: Unit,
	key: Dir | 'left' | 'right',
	extend: boolean
): boolean => {
	const { selection } = edytor;
	const { value, projection } = selection;
	let { start, end } = projection;
	if (value.kind === 'none' || !selection.textAt(start) || !selection.textAt(end)) return false;
	if (unit === 'char' && value.kind === 'blocks') return false;
	// A block selection spans its first shown line's start to its last one's
	// end (a list's items, a code block's lines, never a divider; a
	// member's own line, never an unselected child's).
	const blocks = value.kind === 'blocks' && getSelectedBlocksInDocumentOrder(edytor);
	if (blocks) {
		const first = blocks.map((block) => shownText(block, 'first')).find(Boolean);
		const last = blocks.map((block) => shownText(block, 'last')).findLast(Boolean);
		if (first && last) {
			[start, end] = [pointOf(first, 0), pointOf(last, last.length)];
		}
		// Voids alone show no line: the blocks stay selected, except for the
		// document keys, whose target is the document's edge (`select` moves
		// an anchor left in a void beside it).
		else if (unit !== 'doc') return true;
	}
	if (!start || !end) return false;
	const rtl = selection.rtl(selection.textAt(projection.isReversed ? start : end)!.text);
	const dir: Dir = typeof key === 'number' ? key : (key === 'right') !== rtl ? 1 : -1;
	// The focus moves; an atom is the range anchored on the side it came from,
	// a block selection on the side away from the key.
	const reversed =
		value.kind === 'atom' ? value.from === 'after' : blocks ? dir < 0 : projection.isReversed;
	const [anchor, focus] = reversed ? [end, start] : [start, end];
	const nodeBound = unit === 'char' && value.kind === 'text' && selection.hasNativeNodeSelection();
	if (!extend && (blocks || !projection.isCollapsed) && unit !== 'line' && unit !== 'doc') {
		if (unit === 'char' && value.kind === 'text' && !nodeBound) return false;
		const to = dir > 0 ? end : start;
		select(edytor, to, to);
		return true;
	}
	const first = unit === 'doc' ? displayable(edytor, null, -dir as Dir) : null;
	let to =
		unit === 'line'
			? edge(edytor, focus.block, dir)
			: unit !== 'doc'
				? step(edytor, focus, dir, unit)
				: first
					? edge(edytor, first, dir)
					: null;
	// A grapheme step inside the focus's text is the browser's, except past a
	// soft break, where the caret has two DOM positions (the break's node
	// end, the next line's start): Firefox's forward step only trades one for
	// the other, so that step is the editor's (a logical step: bidi never
	// reorders across a line break).
	const text = stringOf(edytor, focus.block);
	const native =
		unit === 'char' &&
		!nodeBound &&
		value.kind === 'text' &&
		to?.block === focus.block &&
		text[Math.min(to.offset, focus.offset)] !== ATOM;
	if (native && !(dir > 0 && text[focus.offset - 1] === '\n')) return false;
	// A forward node-bound extension never rests on another block's first
	// stop (a derive maps that end back onto the previous block's end).
	while (
		nodeBound &&
		extend &&
		to &&
		to.offset === 0 &&
		to.block !== anchor.block &&
		compare(edytor, anchor, to) < 0
	)
		to = step(edytor, to, 1, 'char');
	if (!to) {
		if (!nodeBound) return unit !== 'char';
		// A node-bound focus that cannot move collapses onto itself.
		to = focus;
		extend = false;
	}
	select(edytor, extend ? anchor : to, to);
	return true;
};

/** A block's lines (split at its `\n` soft breaks: logical lines, not layout), as start and end offsets. */
const linesOf = (edytor: Edytor, block: string) => {
	let at = 0;
	return stringOf(edytor, block)
		.split('\n')
		.map((line) => [at, (at += line.length + 1) - 1] as const);
};

const islandOf = (edytor: Edytor, block: string) =>
	[block, ...edytor.facade.ancestorsOf(block)].find((id) => edytor.facade.isIsland(id));

/**
 * The stop one line from `from` in `dir` at `goal` (default: its own column;
 * an atom is one column): the next line of its block, else the facing line
 * of the next displayable non-void block inside the same island, else its
 * own block's edge.
 */
const lineStop = (edytor: Edytor, from: Stop, dir: Dir, goal?: number) => {
	const lines = linesOf(edytor, from.block);
	const index = lines.findIndex(([start, end]) => from.offset >= start && from.offset <= end);
	if (index < 0) return null;
	const column = goal ?? from.offset - lines[index]![0];
	let block = from.block;
	let line: (typeof lines)[number] | undefined = lines[index + dir];
	const island = islandOf(edytor, block);
	for (
		let next = line ? null : displayable(edytor, block, dir);
		next && !line;
		next = displayable(edytor, next, dir)
	) {
		if (islandOf(edytor, next) !== island) break;
		if (!edytor.facade.isVoid(next))
			[block, line] = [next, linesOf(edytor, next).at(dir > 0 ? 0 : -1)];
	}
	const [start, end] = line ?? lines.at(dir > 0 ? -1 : 0)!;
	const offset = start + (line ? column : dir * Infinity);
	return { block, offset: Math.min(Math.max(offset, start), end), column };
};

const goals = new WeakMap<Edytor, { column: number; value: SelectionValue }>();

/**
 * Shift+ArrowUp/Down over a text selection. Native vertical
 * extension is engine-defined (Firefox collapses at the anchor or drops the
 * focus on stray boundary nodes), so the editor owns it with the horizontal
 * keys' rule: the focus moves one line and the anchor stays; consecutive
 * moves keep the goal column. Answers whether a text selection moved.
 */
export const extendVertically = (edytor: Edytor, dir: Dir): boolean => {
	const { value, projection } = edytor.selection;
	const { start, end } = projection;
	if (value.kind !== 'text' || !start || !end) return false;
	const [anchor, focus] = projection.isReversed ? [end, start] : [start, end];
	const kept = goals.get(edytor);
	const to = lineStop(edytor, focus, dir, kept?.value === value ? kept.column : undefined);
	if (!to) return false;
	select(edytor, anchor, to);
	goals.set(edytor, { column: to.column, value: edytor.selection.value });
	return true;
};

/**
 * A plain vertical key is the browser's: it knows the visual lines. The
 * key's origin is noted until the next gesture (`vertical`); a native move
 * that lands on no caret stop — a foreign or kind line beside the slots
 * — is not the key's destination, the key's line stop from its origin
 * is (`landed`), so the key is never swallowed and the DOM shows a stop.
 */
const natives = new WeakMap<Edytor, { serial: number; dir: Dir; value: SelectionValue }>();

/**
 * Whether a caret stop shows below `block`: a displayable block after it in
 * document order that is not beside it — in another column of a layout it
 * sits in, or another cell of its table row (what follows the last column
 * or the last row is below).
 */
const stopBelow = (edytor: Edytor, block: string): boolean => {
	const { facade } = edytor;
	const items = [block, ...facade.ancestorsOf(block)].filter(
		(id) => facade.isLayoutItem(id) || facade.isTableCell(id)
	);
	const ids = facade.order();
	const from = ids.indexOf(block);
	if (from < 0) return true;
	for (let i = from + 1; i < ids.length; i++) {
		const id = ids[i]!;
		if (!edytor.selection.displayable(id)) continue;
		const ancestors = [id, ...facade.ancestorsOf(id)];
		const beside = items.some(
			(item) => !ancestors.includes(item) && ancestors.includes(facade.parentOf(item)!)
		);
		if (!beside) return true;
	}
	return false;
};

/**
 * ArrowDown leaves the document's last stop (`nav.trailing.exit`, Notion):
 * a collapsed caret on the last line of its block (a line box where the
 * view lays one out, else a line break), with no stop below it, in a block
 * that is not a top-level block of the root's default kind (a toggle's
 * body or header, a callout, a quote, a nested item, a column, a table
 * cell, a code line, a heading). Never in a view that writes nothing.
 */
const leavesLastStop = (edytor: Edytor): boolean => {
	const block = onLastLine(edytor);
	const { root } = edytor;
	if (!block || !root || !edytor.dispatcher.permits()) return false;
	if (block.parent?.isRoot && block.type === edytor.defaultChild(root)) return false;
	return !stopBelow(edytor, block.id);
};

/**
 * The block a collapsed text caret sits on the last line of (a line box
 * where the view lays one out, else a line break), if it does: where
 * ArrowDown leaves the block (`nav.trailing.exit`, `body.down`).
 */
export const onLastLine = (edytor: Edytor): Block | undefined => {
	const { value, projection } = edytor.selection;
	const at = projection.start;
	const block = at && edytor.idToBlock.get(at.block);
	if (value.kind !== 'text' || !projection.isCollapsed || !block) return;
	const text = stringOf(edytor, at.block);
	if (text.includes('\n', at.offset)) return;
	const last = edytor.ports.surface.sameLine(at, { block: at.block, offset: text.length });
	return last === false ? undefined : block;
};

/**
 * The trailing paragraph (`nav.trailing`, Notion): the caret goes to an
 * empty top-level block of the root's default kind after the document's
 * last top-level block — that block itself when it is one, else a new one
 * inserted after it (one command, its own undo step: its undo gives the
 * caret back). Two peers doing it at once each insert theirs. Answers
 * whether the caret went there (refused in a view that writes nothing,
 * vetoed by a hook).
 */
export const toTrailingParagraph = (edytor: Edytor): boolean => {
	const { root } = edytor;
	const last = root?.children.at(-1);
	if (!root || !last) return false;
	const kind = edytor.defaultChild(root);
	if (last.type === kind && last.isEmpty && last.firstText) {
		edytor.selection.selectText(last.firstText, 0);
		return true;
	}
	const { ids } = edytor.insertBlocks(siblingSlot(last), [{ type: kind }]);
	const text = edytor.idToBlock.get(ids[0] ?? '')?.firstText;
	if (!text) return false;
	edytor.dispatcher.caretIn(text, 0);
	return true;
};

/**
 * Note a plain vertical key over a text selection, then run the
 * block-selection `binding`; ArrowDown at the document's last stop goes to
 * the trailing paragraph instead (`leavesLastStop`).
 */
export const vertical =
	(dir: Dir, binding: HotKey): HotKey =>
	(payload) => {
		const { edytor } = payload;
		stayWithoutTarget(edytor, payload.prevent);
		if (dir > 0 && leavesLastStop(edytor))
			return payload.prevent(() => void toTrailingParagraph(edytor));
		const { value } = edytor.selection;
		if (value.kind === 'text') natives.set(edytor, { serial: edytor.intentSerial, dir, value });
		binding(payload);
	};

/**
 * The browser moved a caret for the noted vertical key onto no caret stop:
 * select the key's line stop from its origin. Answers whether it did.
 */
export const landed = (edytor: Edytor): boolean => {
	const native = natives.get(edytor);
	const { selection } = edytor;
	if (!native || native.serial !== edytor.intentSerial || native.value !== selection.value)
		return false;
	natives.delete(edytor);
	const { start, end, isReversed } = selection.projection;
	const focus = isReversed ? start : end;
	if (!focus) return false;
	const to = lineStop(edytor, focus, native.dir) ?? focus;
	select(edytor, to, to);
	return true;
};

/** `[unit, direction, platform]`: a navigation key as a row of the keymap. */
type Row = readonly [Unit, Dir | 'left' | 'right', ('mac' | 'other')?];

/**
 * The navigation keys. Word motion is Alt+Arrow on Apple and Mod+Arrow
 * elsewhere; every row but the Emacs ones (Apple only by their chord) also
 * binds its Shift variant, which extends.
 */
const rows: Record<string, Row> = {
	arrowleft: ['char', 'left'],
	arrowright: ['char', 'right'],
	home: ['line', -1],
	end: ['line', 1],
	pageup: ['doc', -1],
	pagedown: ['doc', 1],
	'mod+arrowup': ['doc', -1],
	'mod+arrowdown': ['doc', 1],
	'alt+arrowleft': ['word', 'left', 'mac'],
	'alt+arrowright': ['word', 'right', 'mac'],
	'mod+arrowleft': ['word', 'left', 'other'],
	'mod+arrowright': ['word', 'right', 'other'],
	'ctrl+a': ['line', -1],
	'ctrl+e': ['line', 1],
	'ctrl+b': ['char', -1],
	'ctrl+f': ['char', 1]
};

const bind =
	([unit, key, platform]: Row, extend: boolean, page: boolean): HotKey =>
	({ edytor, prevent }) => {
		if (platform && edytor.keymap.isMac !== (platform === 'mac')) return;
		if (!page) stayWithoutTarget(edytor, prevent);
		if (move(edytor, unit, key, extend)) prevent();
	};

export const navigationBindings: Record<string, HotKey> = Object.fromEntries(
	Object.entries(rows).flatMap(([chord, row]) => {
		const page = chord === 'pageup' || chord === 'pagedown';
		return [
			[chord, bind(row, false, page)],
			...(chord.startsWith('ctrl+') ? [] : [[`shift+${chord}`, bind(row, true, page)]])
		];
	})
);
