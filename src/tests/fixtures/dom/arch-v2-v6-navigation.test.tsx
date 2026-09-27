/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint V6 rows, dom lane: one ordered stream of caret stops
 * for every horizontal navigation key (R9, §2.4 "Caret-stop stream", §4.3
 * `session/navigation`, L53).
 *
 * The stream is the document order (D2) of the displayable blocks (V3's
 * Surface fact: mounted and not hidden by view state), each block's content
 * parts in order: text positions at grapheme (or word) boundaries and inline
 * atoms between them. Every key — arrow, word, line start/end, document
 * start/end, atom stepping, block edges — is one apply step over it: a plain
 * key moves the caret (a range collapses to its edge in the key's direction),
 * a Shift key moves the focus and keeps the anchor, a range that covers
 * exactly one atom is that atom's selection. A step inside one text of a
 * text-bound selection stays native (the browser moves by grapheme,
 * visually under bidi).
 *
 * - Skipping non-displayable content (D52, O65, BI-12): a collapsed toggle's
 *   body is never a caret stop — not for an arrow, a Shift+Arrow, a word
 *   jump, nor the document edge.
 * - Atoms at block edges: an atom that starts or ends a block is a stop like
 *   any other; extending from its selection grows past it in the key's
 *   direction, across the block edge.
 * - A range's focus steps over an atom or a block edge (the reference left
 *   those to the engine: nothing moves in jsdom, three answers in browsers).
 * - Line extension moves the focus: Shift+Home then Shift+End keeps the
 *   anchor at the caret.
 *
 * RTL rows run in the browser lane (they need the engine's computed
 * direction): `tests/editor-dom/arch-v2-v6-navigation.spec.ts`.
 *
 * Expected values come from the plan rows and the key contract (K9, K10),
 * never from running the code.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Edytor } from '$lib/edytor.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { JSONDoc } from '$lib/utils/json.js';
import {
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since V6. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

afterEach(() => {
	document.body.innerHTML = '';
});

const p = (...content: Array<string | '@'>) => ({
	type: 'paragraph',
	content: content.map((part) => (part === '@' ? { type: 'mention', data: {} } : { text: part }))
});

const mount = async (value: JSONDoc) => {
	const rendered = await renderDomEdytor(<root></root>, { value, autoSelectFixture: false });
	const blocks = () =>
		rendered.edytor.facade.order().map((id) => rendered.edytor.idToBlock.get(id)!);
	return { ...rendered, blocks };
};

/** The selection in the plan's coordinates: [block index in document order, display offset]. */
const sel = (edytor: Edytor) => {
	const { kind, start, end, isCollapsed, isReversed } = edytor.selection.projection;
	const ids = edytor.facade.order();
	const at = (point: typeof start) => (point ? [ids.indexOf(point.block), point.offset] : null);
	return {
		kind,
		start: at(start),
		end: at(end),
		collapsed: isCollapsed,
		reversed: isReversed
	};
};

const caretAt = (block: number, offset: number) => ({
	kind: 'text',
	start: [block, offset],
	end: [block, offset],
	collapsed: true
});

const press = (
	editor: HTMLElement,
	key: string,
	modifiers: { shift?: boolean; mod?: boolean } = {}
) =>
	dispatchDomKeyDown(editor, {
		key,
		shiftKey: modifiers.shift ?? false,
		// jsdom is not an Apple platform: `mod` (and the word keys) are Ctrl.
		ctrlKey: modifiers.mod ?? false
	});

/** A caret at `offset` of `block`'s display (atoms count one). */
const place = async (
	edytor: Edytor,
	block: ReturnType<Edytor['idToBlock']['get']>,
	offset: number
) => {
	let at = offset;
	for (const part of block!.content) {
		if (part instanceof InlineBlock) {
			at -= 1;
			continue;
		}
		if (at <= part.length) return setNativeSelection(edytor, part, at);
		at -= part.length;
	}
	throw new Error(`no text at ${offset}`);
};

const selectAtom = async (edytor: Edytor, block: ReturnType<Edytor['idToBlock']['get']>) => {
	const atom = block!.content.find((part): part is InlineBlock => part instanceof InlineBlock)!;
	edytor.selection.selectInlineBlock(atom);
	await flushDomUpdates();
	expect(edytor.selection.value.kind).toBe('atom');
};

/** A collapsed toggle (`sum`, body `one`/`two`) between `before` and `after`. */
const toggleDoc = (withAfter = true): JSONDoc => ({
	children: [
		p('before'),
		{ type: 'toggle', content: [{ text: 'sum' }], children: [p('one'), p('two')] },
		...(withAfter ? [p('after')] : [])
	]
});

describe('caret stops skip non-displayable content (D52, O65)', () => {
	row('ArrowRight at a collapsed toggle summary end lands after the toggle', async () => {
		const { edytor, editor, blocks } = await mount(toggleDoc());
		await place(edytor, blocks()[1], 3);
		const { defaultPrevented } = await press(editor, 'ArrowRight');
		expect(defaultPrevented).toBe(true);
		// Order: before 0, toggle 1, one 2, two 3, after 4.
		expect(sel(edytor)).toMatchObject(caretAt(4, 0));
	});

	row(
		'ArrowLeft at the start of the block after a collapsed toggle lands at its summary end',
		async () => {
			const { edytor, editor, blocks } = await mount(toggleDoc());
			await place(edytor, blocks()[4], 0);
			await press(editor, 'ArrowLeft');
			expect(sel(edytor)).toMatchObject(caretAt(1, 3));
		}
	);

	row(
		'Shift+ArrowRight at the summary end extends over the hidden body to the next block',
		async () => {
			const { edytor, editor, blocks } = await mount(toggleDoc());
			await place(edytor, blocks()[1], 3);
			await press(editor, 'ArrowRight', { shift: true });
			expect(sel(edytor)).toMatchObject({
				kind: 'text',
				start: [1, 3],
				end: [4, 0],
				collapsed: false,
				reversed: false
			});
		}
	);

	row('a word jump at the summary end crosses the hidden body', async () => {
		const { edytor, editor, blocks } = await mount(toggleDoc());
		await place(edytor, blocks()[1], 3);
		await press(editor, 'ArrowRight', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(4, 0));
		await press(editor, 'ArrowLeft', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(1, 3));
	});

	pin('the document end is the last displayable stop: a collapsed toggle summary end', async () => {
		const { edytor, editor, blocks } = await mount(toggleDoc(false));
		await place(edytor, blocks()[0], 2);
		await press(editor, 'PageDown');
		expect(sel(edytor)).toMatchObject(caretAt(1, 3));
		await place(edytor, blocks()[0], 2);
		await press(editor, 'ArrowDown', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(1, 3));
	});

	row(
		'…and with the toggle open, its last child end (the last stop, not the summary)',
		async () => {
			const { edytor, editor, blocks } = await mount(toggleDoc(false));
			(blocks()[1]!.node as HTMLDetailsElement).open = true;
			await place(edytor, blocks()[0], 2);
			await press(editor, 'PageDown');
			expect(sel(edytor)).toMatchObject(caretAt(3, 3));
		}
	);

	pin('an open toggle: ArrowRight at the summary end enters its first child', async () => {
		const { edytor, editor, blocks } = await mount(toggleDoc());
		(blocks()[1]!.node as HTMLDetailsElement).open = true;
		await place(edytor, blocks()[1], 3);
		await press(editor, 'ArrowRight');
		expect(sel(edytor)).toMatchObject(caretAt(2, 0));
	});

	pin('PageUp and PageDown reach the document edges', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('ab'), p('cd'), p('ef')] });
		await place(edytor, blocks()[1], 1);
		await press(editor, 'PageUp');
		expect(sel(edytor)).toMatchObject(caretAt(0, 0));
		await press(editor, 'PageDown');
		expect(sel(edytor)).toMatchObject(caretAt(2, 2));
	});

	row('Shift+PageUp moves the focus to the document start: a reversed range', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('ab'), p('cd'), p('ef')] });
		await place(edytor, blocks()[1], 1);
		await press(editor, 'PageUp', { shift: true });
		expect(sel(edytor)).toMatchObject({ start: [0, 0], end: [1, 1], reversed: true });
		await press(editor, 'PageDown', { shift: true });
		expect(sel(edytor)).toMatchObject({ start: [1, 1], end: [2, 2], reversed: false });
	});
});

describe('atoms at block edges', () => {
	/** `ab` / `@x` (an atom starts the block) / `y@` (an atom ends it) / `cd`. */
	const edges = (): JSONDoc => ({
		children: [p('ab'), p('', '@', 'x'), p('y', '@', ''), p('cd')]
	});

	pin(
		'ArrowRight from a block end stops before an atom that starts the next block, then after it',
		async () => {
			const { edytor, editor, blocks } = await mount(edges());
			await place(edytor, blocks()[0], 2);
			await press(editor, 'ArrowRight');
			expect(sel(edytor)).toMatchObject(caretAt(1, 0));
			await press(editor, 'ArrowRight');
			expect(sel(edytor)).toMatchObject(caretAt(1, 1));
		}
	);

	pin(
		'ArrowLeft before an atom that starts a block crosses to the previous block end',
		async () => {
			const { edytor, editor, blocks } = await mount(edges());
			await place(edytor, blocks()[1], 1);
			await press(editor, 'ArrowLeft');
			expect(sel(edytor)).toMatchObject(caretAt(1, 0));
			await press(editor, 'ArrowLeft');
			expect(sel(edytor)).toMatchObject(caretAt(0, 2));
		}
	);

	pin('after an atom that ends a block, ArrowRight crosses and ArrowLeft comes back', async () => {
		const { edytor, editor, blocks } = await mount(edges());
		await place(edytor, blocks()[2], 2);
		await press(editor, 'ArrowRight');
		expect(sel(edytor)).toMatchObject(caretAt(3, 0));
		await press(editor, 'ArrowLeft');
		expect(sel(edytor)).toMatchObject(caretAt(2, 2));
	});

	pin('Shift+ArrowLeft after an atom that starts a block selects the atom', async () => {
		const { edytor, editor, blocks } = await mount(edges());
		await place(edytor, blocks()[1], 1);
		await press(editor, 'ArrowLeft', { shift: true });
		expect(sel(edytor)).toMatchObject({ kind: 'atom', start: [1, 0], end: [1, 1] });
	});

	pin('a selected atom collapses to the side of the arrow', async () => {
		const { edytor, editor, blocks } = await mount(edges());
		await selectAtom(edytor, blocks()[2]);
		await press(editor, 'ArrowRight');
		expect(sel(edytor)).toMatchObject(caretAt(2, 2));
		await selectAtom(edytor, blocks()[2]);
		await press(editor, 'ArrowLeft');
		expect(sel(edytor)).toMatchObject(caretAt(2, 1));
	});

	row('Shift+ArrowRight on the atom that ends a block extends across the block edge', async () => {
		const { edytor, editor, blocks } = await mount(edges());
		await selectAtom(edytor, blocks()[2]);
		const { defaultPrevented } = await press(editor, 'ArrowRight', { shift: true });
		expect(defaultPrevented).toBe(true);
		expect(sel(edytor)).toMatchObject({
			kind: 'text',
			start: [2, 1],
			end: [3, 0],
			collapsed: false,
			reversed: false
		});
	});

	row('Shift+ArrowLeft on the atom that starts a block extends across the block edge', async () => {
		const { edytor, editor, blocks } = await mount(edges());
		await selectAtom(edytor, blocks()[1]);
		await press(editor, 'ArrowLeft', { shift: true });
		expect(sel(edytor)).toMatchObject({
			kind: 'text',
			start: [0, 2],
			end: [1, 1],
			collapsed: false,
			reversed: true
		});
	});

	pin('a word extension from the caret before an atom selects the atom', async () => {
		const { edytor, editor, blocks } = await mount(edges());
		await place(edytor, blocks()[2], 1);
		await press(editor, 'ArrowRight', { shift: true, mod: true });
		expect(sel(edytor)).toMatchObject({ kind: 'atom', start: [2, 1], end: [2, 2] });
	});
});

describe('a range focus steps over atoms and block edges', () => {
	row('Shift+ArrowRight at a range focus before an atom covers the atom', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('lead', '@', 'tail')] });
		const [lead] = blocks()[0]!.content;
		await setNativeSelection(edytor, lead as never, 1, lead as never, 4);
		const { defaultPrevented } = await press(editor, 'ArrowRight', { shift: true });
		expect(defaultPrevented).toBe(true);
		expect(sel(edytor)).toMatchObject({
			kind: 'text',
			start: [0, 1],
			end: [0, 5],
			collapsed: false
		});
	});

	row(
		'Shift+ArrowRight at a range focus at a block end extends to the next block start',
		async () => {
			const { edytor, editor, blocks } = await mount({ children: [p('note'), p('tail')] });
			const note = blocks()[0]!.firstText!;
			await setNativeSelection(edytor, note, 1, note, 4);
			await press(editor, 'ArrowRight', { shift: true });
			expect(sel(edytor)).toMatchObject({
				kind: 'text',
				start: [0, 1],
				end: [1, 0],
				reversed: false
			});
		}
	);

	row(
		'Shift+ArrowLeft at a reversed range focus at a block start extends to the previous end',
		async () => {
			const { edytor, editor, blocks } = await mount({ children: [p('note'), p('tail')] });
			const tail = blocks()[1]!.firstText!;
			await setNativeSelection(edytor, tail, 0, tail, 3, { reversed: true });
			await press(editor, 'ArrowLeft', { shift: true });
			expect(sel(edytor)).toMatchObject({
				kind: 'text',
				start: [0, 4],
				end: [1, 3],
				reversed: true
			});
		}
	);

	pin('Shift+ArrowRight inside a text stays native', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('note'), p('tail')] });
		const note = blocks()[0]!.firstText!;
		await setNativeSelection(edytor, note, 1, note, 2);
		const { defaultPrevented } = await press(editor, 'ArrowRight', { shift: true });
		expect(defaultPrevented).toBe(false);
	});

	pin('a collapsed ArrowRight inside a text stays native', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('note'), p('tail')] });
		await place(edytor, blocks()[0], 2);
		const { defaultPrevented } = await press(editor, 'ArrowRight');
		expect(defaultPrevented).toBe(false);
	});
});

describe('line and word extension move the focus', () => {
	row('Shift+Home then Shift+End keeps the anchor at the caret', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('Marked middle')] });
		await place(edytor, blocks()[0], 3);
		await press(editor, 'Home', { shift: true });
		expect(sel(edytor)).toMatchObject({ start: [0, 0], end: [0, 3], reversed: true });
		await press(editor, 'End', { shift: true });
		expect(sel(edytor)).toMatchObject({ start: [0, 3], end: [0, 13], reversed: false });
	});

	pin('Home and End go to the block edges', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('lead', '@', 'tail'), p('x')] });
		await place(edytor, blocks()[0], 2);
		await press(editor, 'End');
		expect(sel(edytor)).toMatchObject(caretAt(0, 9));
		await press(editor, 'Home');
		expect(sel(edytor)).toMatchObject(caretAt(0, 0));
	});

	pin('a plain word jump off a range collapses onto its edge in the direction', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('foo bar baz')] });
		const text = blocks()[0]!.firstText!;
		await setNativeSelection(edytor, text, 4, text, 7);
		await press(editor, 'ArrowRight', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(0, 7));
		await setNativeSelection(edytor, text, 4, text, 7);
		await press(editor, 'ArrowLeft', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(0, 4));
	});

	pin('word jumps cross an atom and a block edge at their near side', async () => {
		const { edytor, editor, blocks } = await mount({ children: [p('ab', '@', 'cd ef'), p('gh')] });
		await place(edytor, blocks()[0], 2);
		await press(editor, 'ArrowRight', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(0, 3));
		await press(editor, 'ArrowRight', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(0, 5));
		await press(editor, 'ArrowRight', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(0, 8));
		await press(editor, 'ArrowRight', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(1, 0));
		await press(editor, 'ArrowLeft', { mod: true });
		expect(sel(edytor)).toMatchObject(caretAt(0, 8));
	});
});

describe('vertical extension walks the same displayable blocks (O44)', () => {
	row('Shift+ArrowDown at a collapsed toggle summary extends past its hidden body', async () => {
		const { edytor, editor, blocks } = await mount(toggleDoc());
		await place(edytor, blocks()[1], 2);
		await press(editor, 'ArrowDown', { shift: true });
		expect(sel(edytor)).toMatchObject({
			kind: 'text',
			start: [1, 2],
			end: [4, 2],
			reversed: false
		});
		// Going up from the block after it (K1: the start edge moves up).
		await place(edytor, blocks()[4], 2);
		await press(editor, 'ArrowUp', { shift: true });
		expect(sel(edytor)).toMatchObject({ kind: 'text', start: [1, 2], end: [4, 2], reversed: true });
	});

	row('Shift+ArrowDown into a list lands in its first item, never the container slot', async () => {
		const { edytor, editor, blocks } = await mount({
			children: [
				p('abc'),
				{ type: 'ordered-list', children: [{ type: 'list-item', content: [{ text: 'First' }] }] }
			]
		});
		await place(edytor, blocks()[0], 2);
		await press(editor, 'ArrowDown', { shift: true });
		// Order: abc 0, list 1, First 2.
		expect(sel(edytor)).toMatchObject({
			kind: 'text',
			start: [0, 2],
			end: [2, 2],
			reversed: false
		});
	});

	pin('Shift+ArrowUp then Shift+ArrowDown keeps the goal column over a shorter line', async () => {
		const { edytor, editor, blocks } = await mount({
			children: [p('abcdef'), p('ab'), p('uvwxyz')]
		});
		await place(edytor, blocks()[2], 5);
		await press(editor, 'ArrowUp', { shift: true });
		expect(sel(edytor)).toMatchObject({ start: [1, 2], end: [2, 5], reversed: true });
		await press(editor, 'ArrowUp', { shift: true });
		expect(sel(edytor)).toMatchObject({ start: [0, 5], end: [2, 5], reversed: true });
	});
});
