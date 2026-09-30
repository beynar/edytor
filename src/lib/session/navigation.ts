/**
 * Navigation (R9, §4.3 `session/navigation`, L53): one ordered stream of
 * caret stops and one apply step for every horizontal navigation key.
 *
 * The stream is the document order (D2) of the displayable blocks (§2.4, a
 * Surface fact: a collapsed toggle's body or a phantom content slot holds no
 * stop), each block's content parts in order: offsets inside its texts at
 * grapheme (or word) boundaries, with the inline atoms between them. A key
 * names a unit (grapheme, word, block edge, document edge) and a direction;
 * the arrow and word keys are visual, resolved once from the focus text's
 * computed direction (RTL).
 *
 * The apply step: a plain key moves the caret (a range or an atom collapses
 * onto its edge in the key's direction); a Shift key moves the focus and
 * keeps the anchor; a range that covers exactly one atom is that atom's
 * selection. A grapheme step inside the focus's own text is left to the
 * browser (it moves visually under bidi) unless the selection came from a
 * node-bound native range, whose extension engines disagree on (K10), or the
 * step starts right after a soft break (Firefox moves nothing there).
 * Vertical extension (Shift+ArrowUp/Down) crosses blocks through the same
 * displayable walk; plain vertical motion stays native, unless the browser
 * lands it on no caret stop (`landed`).
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import { getNextGraphemeEnd, getPreviousGraphemeStart } from '$lib/text/text.utils.js';
import { getNextWordEndOffset, getPreviousWordStartOffset } from '$lib/events/wordBoundary.js';
import type { HotKey } from './keymap.js';
import type { SelectionValue } from './selection.js';

/** A caret stop: an offset inside one text segment. */
type Stop = { text: Text; offset: number };
export type Dir = 1 | -1;
type Unit = 'char' | 'word' | 'line' | 'doc';

/**
 * A block's stop at its edge in `dir` (its end going forward, its start
 * going backward); none in a block that shows no content (a divider's
 * phantom text is no stop: Home over a lone selected divider keeps it).
 */
const edge = (block: Block, dir: Dir): Stop | null => {
	if (!block.rendersContent) return null;
	const texts = block.content.filter((part): part is Text => part instanceof Text);
	const text = dir > 0 ? texts.at(-1) : texts[0];
	return text ? { text, offset: dir > 0 ? text.length : 0 } : null;
};

/** The first displayable block after `from` in document order (`from` null: the document's edge). */
const displayable = (edytor: Edytor, from: Block | null, dir: Dir): Block | null => {
	const ids = edytor.facade.order();
	const at = from ? ids.indexOf(from.id) : dir > 0 ? -1 : ids.length;
	for (let i = at + dir; i >= 0 && i < ids.length; i += dir)
		if (edytor.selection.displayable(ids[i]!)) return edytor.idToBlock.get(ids[i]!) ?? null;
	return null;
};

/**
 * The next stop from `at`: a grapheme or word boundary inside its text, else
 * the near side of the text beyond the atom next to it, else the near edge of
 * the next displayable block.
 */
const step = (edytor: Edytor, { text, offset }: Stop, dir: Dir, unit: 'char' | 'word') => {
	const value = text.stringContent;
	if (dir > 0 ? offset < value.length : offset > 0) {
		const next =
			unit === 'word'
				? (dir > 0 ? getNextWordEndOffset : getPreviousWordStartOffset)(value, offset)
				: (dir > 0 ? getNextGraphemeEnd : getPreviousGraphemeStart)(value, offset);
		if (next !== offset) return { text, offset: next };
	}
	const { content } = text.parent;
	const index = content.indexOf(text);
	const beyond = content[index + 2 * dir];
	if (content[index + dir] instanceof InlineBlock)
		return beyond instanceof Text ? { text: beyond, offset: dir > 0 ? 0 : beyond.length } : null;
	const block = displayable(edytor, text.parent, dir);
	return block && edge(block, -dir as Dir);
};

const compare = (a: Stop, b: Stop, edytor: Edytor) =>
	a.text === b.text
		? a.offset - b.offset
		: a.text.parent === b.text.parent
			? a.text.parent.content.indexOf(a.text) - b.text.parent.content.indexOf(b.text)
			: edytor.compareBlocks(a.text.parent, b.text.parent);

/** Select `anchor` → `focus`: a caret, the one atom the range covers, or the range. */
const select = (edytor: Edytor, anchor: Stop, focus: Stop) => {
	const order = compare(anchor, focus, edytor);
	if (order === 0) return edytor.selection.setAtTextOffset(focus.text, focus.offset);
	const [start, end] = order < 0 ? [anchor, focus] : [focus, anchor];
	const { content } = start.text.parent;
	const index = content.indexOf(start.text);
	const atom = content[index + 1];
	if (
		atom instanceof InlineBlock &&
		content[index + 2] === end.text &&
		start.offset === start.text.length &&
		end.offset === 0
	)
		return edytor.selection.selectInlineBlock(atom, order > 0 ? 'after' : 'before');
	edytor.selection.setAtRange(start.text, start.offset, end.text, end.offset, {
		isReversed: order > 0
	});
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
	const { value, state } = selection;
	if (value.kind === 'none' || !state.startText || !state.endText) return false;
	if (unit === 'char' && value.kind === 'blocks') return false;
	const start = { text: state.startText, offset: state.yStart };
	const end = { text: state.endText, offset: state.yEnd };
	const rtl = selection.rtl(state.isReversed ? start.text : end.text);
	const dir: Dir = typeof key === 'number' ? key : (key === 'right') !== rtl ? 1 : -1;
	// The focus moves; an atom is the range anchored on the side it came from.
	const reversed = value.kind === 'atom' ? value.from === 'after' : state.isReversed;
	const [anchor, focus] = reversed ? [end, start] : [start, end];
	const nodeBound = unit === 'char' && value.kind === 'text' && selection.hasNativeNodeSelection();
	if (!extend && !state.isCollapsed && unit !== 'line' && unit !== 'doc') {
		if (unit === 'char' && value.kind === 'text' && !nodeBound) return false;
		const to = dir > 0 ? end : start;
		select(edytor, to, to);
		return true;
	}
	let to =
		unit === 'line'
			? edge(focus.text.parent, dir)
			: unit === 'doc'
				? (() => {
						const block = displayable(edytor, null, -dir as Dir);
						return block && edge(block, dir);
					})()
				: step(edytor, focus, dir, unit);
	// Past a soft break the caret has two DOM positions (the break's node end,
	// the next line's start): Firefox's forward step only trades one for the
	// other, so that step is the editor's (a logical step: bidi never reorders
	// across a line break).
	const native = unit === 'char' && !nodeBound && to?.text === focus.text && value.kind === 'text';
	if (native && !(dir > 0 && focus.text.stringContent[focus.offset - 1] === '\n')) return false;
	// K10: a forward node-bound extension never rests on another block's first
	// stop (a derive maps that end back onto the previous block's end).
	while (
		nodeBound &&
		extend &&
		to &&
		to.offset === 0 &&
		to.text === to.text.parent.content[0] &&
		to.text.parent !== anchor.text.parent &&
		compare(anchor, to, edytor) < 0
	)
		to = step(edytor, to, 1, 'char');
	if (!to) {
		if (!nodeBound) return unit !== 'char';
		// K10: a node-bound focus that cannot move collapses onto itself.
		to = focus;
		extend = false;
	}
	select(edytor, extend ? anchor : to, to);
	return true;
};

/** A line of a block for vertical motion: text pieces, and `null` for an atom (one column). */
type Line = Array<{ text: Text; offset: number; length: number } | null>;

/** A block's lines: its texts split at `\n` soft breaks (logical lines, not layout). */
const linesOf = (block: Block): Line[] => {
	const lines: Line[] = [[]];
	for (const part of block.content) {
		if (!(part instanceof Text)) {
			lines.at(-1)!.push(null);
			continue;
		}
		let offset = 0;
		part.stringContent.split('\n').forEach((line, index) => {
			if (index) lines.push([]);
			lines.at(-1)!.push({ text: part, offset, length: line.length });
			offset += line.length + 1;
		});
	}
	return lines;
};

/** The stop at `column` of a line; past its end, the end of its last text. */
const onLine = (line: Line, column: number): Stop | null => {
	let rest = Math.max(column, 0);
	let last: Line[number] = null;
	for (const piece of line) {
		if (!piece) {
			rest = Math.max(0, rest - 1);
			continue;
		}
		last = piece;
		if (piece.length === 0 && rest > 0) continue;
		if (rest <= piece.length) return { text: piece.text, offset: piece.offset + rest };
		rest -= piece.length;
	}
	return last && { text: last.text, offset: last.offset + last.length };
};

const islandOf = (edytor: Edytor, block: Block) =>
	[block.id, ...edytor.facade.ancestorsOf(block.id)].find((id) => edytor.facade.isIsland(id));

/** The line holding `at` and its column there. */
const locate = (lines: Line[], at: Stop) => {
	for (const [index, line] of lines.entries()) {
		let column = 0;
		for (const piece of line) {
			if (
				piece?.text === at.text &&
				at.offset >= piece.offset &&
				at.offset <= piece.offset + piece.length
			)
				return { index, column: column + at.offset - piece.offset };
			column += piece ? piece.length : 1;
		}
	}
	return null;
};

/**
 * The stop one line from `from` in `dir` at `goal` (default: its own column):
 * the next line of its block, else the facing line of the next displayable
 * non-void block inside the same island, else its own block's edge. Every
 * line holds a text, so `onLine` always finds a stop.
 */
const lineStop = (edytor: Edytor, from: Stop, dir: Dir, goal?: number) => {
	const block = from.text.parent;
	const lines = linesOf(block);
	const at = locate(lines, from);
	if (!at) return null;
	const column = goal ?? at.column;
	let line: Line | undefined = lines[at.index + dir];
	const island = islandOf(edytor, block);
	for (
		let next = line ? null : displayable(edytor, block, dir);
		next && !line;
		next = displayable(edytor, next, dir)
	) {
		if (islandOf(edytor, next) !== island) break;
		if (!edytor.facade.isVoid(next.id)) line = linesOf(next).at(dir > 0 ? 0 : -1);
	}
	const to = line ? onLine(line, column) : onLine(lines.at(dir > 0 ? -1 : 0)!, dir * Infinity);
	return to && { ...to, column };
};

const goals = new WeakMap<Edytor, { column: number; value: SelectionValue }>();

/**
 * Shift+ArrowUp/Down over a text selection (K1, O44). Native vertical
 * extension is engine-defined (Firefox collapses at the anchor or drops the
 * focus on stray boundary nodes), so the editor owns it with the horizontal
 * keys' rule: the focus moves one line and the anchor stays; consecutive
 * moves keep the goal column. Answers whether a text selection moved.
 */
export const extendVertically = (edytor: Edytor, dir: Dir): boolean => {
	const { value, state } = edytor.selection;
	if (value.kind !== 'text' || !state.startText || !state.endText) return false;
	const start = { text: state.startText, offset: state.yStart };
	const end = { text: state.endText, offset: state.yEnd };
	const [anchor, focus] = state.isReversed ? [end, start] : [start, end];
	const kept = goals.get(edytor);
	const to = lineStop(edytor, focus, dir, kept?.value === value ? kept.column : undefined);
	if (!to) return false;
	select(edytor, anchor, to);
	goals.set(edytor, { column: to.column, value: edytor.selection.value });
	return true;
};

/**
 * A plain vertical key is the browser's: it knows the visual lines (O44). The
 * key's origin is noted until the next gesture (`vertical`); a native move
 * that lands on no caret stop — a foreign or kind line beside the slots
 * (D-25) — is not the key's destination, the key's line stop from its origin
 * is (`landed`), so the key is never swallowed and the DOM shows a stop.
 */
const natives = new WeakMap<Edytor, { serial: number; dir: Dir; value: SelectionValue }>();

/** Note a plain vertical key over a text selection, then run the block-selection `binding`. */
export const vertical =
	(dir: Dir, binding: HotKey): HotKey =>
	(payload) => {
		const { edytor } = payload;
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
	const { startText, endText, yStart, yEnd, isReversed } = selection.state;
	if (!startText || !endText) return false;
	const focus = isReversed ? { text: startText, offset: yStart } : { text: endText, offset: yEnd };
	const to = lineStop(edytor, focus, native.dir) ?? focus;
	select(edytor, to, to);
	return true;
};

/** `[unit, direction, platform]`: a navigation key as a row of the keymap. */
type Row = readonly [Unit, Dir | 'left' | 'right', ('mac' | 'other')?];

/**
 * The navigation keys (K9). Word motion is Alt+Arrow on Apple and Mod+Arrow
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
	([unit, key, platform]: Row, extend: boolean): HotKey =>
	({ edytor, prevent }) => {
		if (platform && edytor.hotKeys.isMac !== (platform === 'mac')) return;
		if (move(edytor, unit, key, extend)) prevent();
	};

export const navigationBindings: Record<string, HotKey> = Object.fromEntries(
	Object.entries(rows).flatMap(([chord, row]) => [
		[chord, bind(row, false)],
		...(chord.startsWith('ctrl+') ? [] : [[`shift+${chord}`, bind(row, true)]])
	])
);
