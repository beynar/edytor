/** @jsxImportSource ../../../jsx */
import { describe, expect, it } from 'vitest';
import { tick } from 'svelte';

import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	assertCanonicalTree,
	blockIdMap,
	canonicalTree,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection,
	type CanonicalBlock
} from '../../dom/test.utils.js';

/**
 * U6 golden command programs — exact, hand-authored deletion contracts run
 * through the real `runBeforeInputCommand` dispatch on mounted editors.
 * Contract IDs reference `docs/editor-delete-contract.md`.
 *
 * Every program: set a logical selection, run the real command, assert the
 * exact resulting CANONICAL TREE (descendant structure, types, data, marks,
 * content parts — not just concatenated text) AND the resulting caret, then
 * type one character at that caret and assert again — a faulty restore
 * cannot hide behind the follow-up input.
 *
 * Honest headless limits (assigned to the browser lane, not faked here):
 * - grapheme-cluster deletion: arrives via the native `targetRange`, which
 *   is browser-derived; a synthetic collapsed command deletes UTF-16 units.
 * - visual soft-line discovery needs layout; headless soft/hard-line both
 *   resolve to the block start (verified identical below).
 * Reversed selections ARE expressible headlessly (Selection.setBaseAndExtent)
 * — the earlier "jsdom collapses them" note was a fixture-helper bug.
 */

const runCommand = (edytor: Edytor, inputType: string, data: string | null = null) =>
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, {
			inputType,
			data,
			dataTransfer: null,
			cancelable: true
		})
	);

/** Compact canonical block builders — the assertion still compares the
 * full recursive tree, so structure the shorthand omits (children, extra
 * parts, marks, data) fails the test if production produces it. */
const p = (text: string, extra: Partial<CanonicalBlock> = {}): CanonicalBlock => ({
	type: 'paragraph',
	...(text === '' ? {} : { content: [{ text }] }),
	...extra
});

const caret = (edytor: Edytor) => ({
	text: edytor.selection.state.startText?.stringContent,
	at: edytor.selection.state.yStart
});

/** delete → assert canonical doc+caret → type `follow` at the caret → assert. */
const program = async (
	fixture: Parameters<typeof renderDomEdytor>[0],
	opts: {
		select: (e: Edytor) => [unknown, number, unknown, number];
		reversed?: boolean;
		inputType?: string;
		expectTree: CanonicalBlock[];
		expectCaret: { text?: string; at: number };
		follow: string;
		expectAfterFollow: CanonicalBlock[];
	}
) => {
	const { edytor } = await renderDomEdytor(fixture, { autoSelectFixture: false });
	const [s0, o0, s1, o1] = opts.select(edytor);
	await setNativeSelection(edytor, s0 as never, o0, (s1 ?? s0) as never, o1 ?? o0, {
		reversed: opts.reversed
	});
	await runCommand(edytor, opts.inputType ?? 'deleteContentBackward');
	await flushDomUpdates();
	assertCanonicalTree(edytor, opts.expectTree);
	expect(caret(edytor)).toEqual(opts.expectCaret);
	await runCommand(edytor, 'insertText', opts.follow);
	await flushDomUpdates();
	await tick();
	assertCanonicalTree(edytor, opts.expectAfterFollow);
	return edytor;
};

const threeFlat = (
	<root>
		<paragraph>aa</paragraph>
		<paragraph>bb</paragraph>
		<paragraph>cc</paragraph>
	</root>
);

const at = (e: Edytor, i: number) => e.root!.children[i]!.firstText!;

describe('golden command programs — flat range deletion (del.range.flat)', () => {
	it('partial/partial adjacent siblings merge suffix into head', async () => {
		await program(threeFlat, {
			select: (e) => [at(e, 0), 1, at(e, 1), 1],
			expectTree: [p('ab'), p('cc')],
			expectCaret: { text: 'ab', at: 1 },
			follow: 'X',
			expectAfterFollow: [p('aXb'), p('cc')]
		});
	});

	it('partial/partial nonadjacent siblings kill the interior block', async () => {
		await program(threeFlat, {
			select: (e) => [at(e, 0), 1, at(e, 2), 1],
			expectTree: [p('ac')],
			expectCaret: { text: 'ac', at: 1 },
			follow: 'X',
			expectAfterFollow: [p('aXc')]
		});
	});

	it('full head + partial tail: both die, only the untouched sibling remains', async () => {
		await program(threeFlat, {
			select: (e) => [at(e, 0), 0, at(e, 1), 2],
			expectTree: [p('cc')],
			expectCaret: { text: 'cc', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('Xcc')]
		});
	});

	it('partial head + full tail: head keeps its prefix', async () => {
		await program(threeFlat, {
			select: (e) => [at(e, 0), 1, at(e, 1), 2],
			expectTree: [p('a'), p('cc')],
			expectCaret: { text: 'a', at: 1 },
			follow: 'X',
			expectAfterFollow: [p('aX'), p('cc')]
		});
	});

	it('whole document keeps the head, emptied (del.range.whole-doc)', async () => {
		let head = '';
		const { edytor } = await program(threeFlat, {
			select: (e) => ((head = e.root!.children[0]!.id), [at(e, 0), 0, at(e, 2), 2]),
			expectTree: [p('')],
			expectCaret: { text: '', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('X')]
		});
		assertCanonicalTree(edytor, [p('X', { id: head })]);
	});

	it('whole-text forward delete empties the block but keeps it', async () => {
		await program(threeFlat, {
			select: (e) => [at(e, 1), 0, at(e, 1), 2],
			inputType: 'deleteContentForward',
			expectTree: [p('aa'), p(''), p('cc')],
			expectCaret: { text: '', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('aa'), p('X'), p('cc')]
		});
	});

	it('reversed range selects the same span and deletes identically', async () => {
		const { edytor } = await renderDomEdytor(threeFlat, { autoSelectFixture: false });
		// Anchor at bb@2, focus at aa@1 — the logical range is aa[1..]→bb[..2]
		// with direction reversed (sel.dir.reversed).
		await setNativeSelection(edytor, at(edytor, 0), 1, at(edytor, 1), 2, { reversed: true });
		expect(edytor.selection.state.isReversed).toBe(true);
		expect(edytor.selection.state.isCollapsed).toBe(false);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('a'), p('cc')]);
	});
});

describe('golden command programs — nested boundary deletion (del.range.nested-tail)', () => {
	const nested = (
		<root>
			<paragraph>alpha</paragraph>
			<ordered-list>
				<list-item>beta</list-item>
				<list-item>gamma</list-item>
			</ordered-list>
			<paragraph>omega</paragraph>
		</root>
	);
	const nestedAt = (e: Edytor, block: number, item?: number) =>
		item === undefined
			? e.root!.children[block]!.firstText!
			: e.root!.children[block]!.children[item]!.firstText!;

	it('flat head at offset 0 + nested tail: the doomed head dies with the range', async () => {
		const { edytor } = await renderDomEdytor(nested, { autoSelectFixture: false });
		const beforeIds = blockIdMap(edytor);
		// The reviewer's repro: alpha@0 → beta@2. The ancestor-rescue branch
		// must remove EVERY doomed block outside the rescued subtree — the
		// earlier code returned after the container and left 'alpha' whole.
		await setNativeSelection(edytor, nestedAt(edytor, 0), 0, nestedAt(edytor, 1, 0), 2);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [
			{ type: 'list-item', content: [{ text: 'ta' }] },
			{ type: 'list-item', content: [{ text: 'gamma' }] },
			p('omega')
		]);
		// The rescued survivors keep identity — tail item and its later
		// sibling are moved, not re-created.
		const afterIds = blockIdMap(edytor);
		expect(afterIds.get('0')).toBe(beforeIds.get('1.0'));
		expect(afterIds.get('1')).toBe(beforeIds.get('1.1'));
		expect(afterIds.get('2')).toBe(beforeIds.get('2'));
		expect(caret(edytor)).toEqual({ text: 'ta', at: 0 });
		await runCommand(edytor, 'insertText', 'X');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [
			{ type: 'list-item', content: [{ text: 'Xta' }] },
			{ type: 'list-item', content: [{ text: 'gamma' }] },
			p('omega')
		]);
	});

	it('flat head + nested tail at item start: head dies, whole tail item survives', async () => {
		const { edytor } = await renderDomEdytor(nested, { autoSelectFixture: false });
		// alpha@0 → beta@0: yEnd==0 — tail boundary at text start keeps the
		// tail item fully intact (del.range.flat.yEnd-zero applied nested).
		await setNativeSelection(edytor, nestedAt(edytor, 0), 0, nestedAt(edytor, 1, 0), 0);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [
			{ type: 'list-item', content: [{ text: 'beta' }] },
			{ type: 'list-item', content: [{ text: 'gamma' }] },
			p('omega')
		]);
	});
});

describe('golden command programs — collapsed caret deletion', () => {
	it('del.caret.char: backward mid-text', async () => {
		await program(threeFlat, {
			select: (e) => [at(e, 1), 1, at(e, 1), 1],
			expectTree: [p('aa'), p('b'), p('cc')],
			expectCaret: { text: 'b', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('aa'), p('Xb'), p('cc')]
		});
	});

	it('del.caret.char: forward mid-text', async () => {
		await program(threeFlat, {
			select: (e) => [at(e, 1), 0, at(e, 1), 0],
			inputType: 'deleteContentForward',
			expectTree: [p('aa'), p('b'), p('cc')],
			expectCaret: { text: 'b', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('aa'), p('Xb'), p('cc')]
		});
	});

	it('del.merge.backward-head: Backspace at a block head merges into the previous block', async () => {
		await program(threeFlat, {
			select: (e) => [at(e, 1), 0, at(e, 1), 0],
			expectTree: [p('aabb'), p('cc')],
			expectCaret: { text: 'aabb', at: 2 },
			follow: 'X',
			expectAfterFollow: [p('aaXbb'), p('cc')]
		});
	});

	it('noop.doc-start: Backspace at the very start changes nothing', async () => {
		const { edytor } = await renderDomEdytor(threeFlat, { autoSelectFixture: false });
		await setNativeSelection(edytor, at(edytor, 0), 0, at(edytor, 0), 0);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('aa'), p('bb'), p('cc')]);
		expect(caret(edytor)).toEqual({ text: 'aa', at: 0 });
	});

	it('noop.doc-end: forward delete at the very end changes nothing', async () => {
		const { edytor } = await renderDomEdytor(threeFlat, { autoSelectFixture: false });
		await setNativeSelection(edytor, at(edytor, 2), 2, at(edytor, 2), 2);
		await runCommand(edytor, 'deleteContentForward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('aa'), p('bb'), p('cc')]);
		expect(caret(edytor)).toEqual({ text: 'cc', at: 2 });
	});

	it('whitespace-only text deletes one UTF-16 unit', async () => {
		const fixture = (
			<root>
				<paragraph> </paragraph>
				<paragraph>x</paragraph>
			</root>
		);
		await program(fixture, {
			select: (e) => [at(e, 0), 1, at(e, 0), 1],
			expectTree: [p(''), p('x')],
			expectCaret: { text: '', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('X'), p('x')]
		});
	});
});

describe('golden command programs — word and line intent (del.word/del.line)', () => {
	const words = (
		<root>
			<paragraph>alpha bravo charlie</paragraph>
		</root>
	);
	const atWords = (e: Edytor) => e.root!.children[0]!.firstText!;

	it('deleteWordBackward removes the word plus one separating space', async () => {
		await program(words, {
			select: (e) => [atWords(e), 12, atWords(e), 12],
			inputType: 'deleteWordBackward',
			expectTree: [p('alpha charlie')],
			expectCaret: { text: 'alpha charlie', at: 6 },
			follow: 'X',
			expectAfterFollow: [p('alpha Xcharlie')]
		});
	});

	it('deleteSoftLineBackward deletes to block start (no layout headlessly)', async () => {
		await program(words, {
			select: (e) => [atWords(e), 12, atWords(e), 12],
			inputType: 'deleteSoftLineBackward',
			expectTree: [p('charlie')],
			expectCaret: { text: 'charlie', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('Xcharlie')]
		});
	});

	it('deleteHardLineBackward deletes to block start without newlines', async () => {
		await program(words, {
			select: (e) => [atWords(e), 12, atWords(e), 12],
			inputType: 'deleteHardLineBackward',
			expectTree: [p('charlie')],
			expectCaret: { text: 'charlie', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('Xcharlie')]
		});
	});

	// P1.2 — del.unit.soft-line: a soft line ends at a line break; a hard line
	// is the block (the golden browser shape, delete-shapes.spec.ts).
	const lines = (
		<root>
			<paragraph>{'one\ntwo'}</paragraph>
		</root>
	);
	it('deleteSoftLineBackward stops after the line break', async () => {
		await program(lines, {
			select: (e) => [atWords(e), 6, atWords(e), 6],
			inputType: 'deleteSoftLineBackward',
			expectTree: [p('one\no')],
			expectCaret: { text: 'one\no', at: 4 },
			follow: 'X',
			expectAfterFollow: [p('one\nXo')]
		});
	});

	it('deleteSoftLineForward stops before the line break', async () => {
		await program(lines, {
			select: (e) => [atWords(e), 1, atWords(e), 1],
			inputType: 'deleteSoftLineForward',
			expectTree: [p('o\ntwo')],
			expectCaret: { text: 'o\ntwo', at: 1 },
			follow: 'X',
			expectAfterFollow: [p('oX\ntwo')]
		});
	});

	it('deleteSoftLineBackward right after a line break deletes the break', async () => {
		await program(lines, {
			select: (e) => [atWords(e), 4, atWords(e), 4],
			inputType: 'deleteSoftLineBackward',
			expectTree: [p('onetwo')],
			expectCaret: { text: 'onetwo', at: 3 },
			follow: 'X',
			expectAfterFollow: [p('oneXtwo')]
		});
	});

	it('deleteHardLineBackward crosses line breaks to the block start', async () => {
		await program(lines, {
			select: (e) => [atWords(e), 6, atWords(e), 6],
			inputType: 'deleteHardLineBackward',
			expectTree: [p('o')],
			expectCaret: { text: 'o', at: 0 },
			follow: 'X',
			expectAfterFollow: [p('Xo')]
		});
	});
});

describe('golden command programs — marks and inline atoms', () => {
	const marked = (
		<root>
			<paragraph>
				ab<bold>cd</bold>ef
			</paragraph>
		</root>
	);
	const atomFixture = (
		<root>
			<paragraph>
				ab<mention id="m1">x</mention>cd
			</paragraph>
		</root>
	);

	it('a mark boundary alone does not change the delete unit', async () => {
		const { edytor } = await renderDomEdytor(marked, { autoSelectFixture: false });
		const t = edytor.root!.children[0]!.firstText!;
		await setNativeSelection(edytor, t, 4, t, 4);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [
			p('', {
				content: [{ text: 'ab' }, { text: 'c', marks: { bold: true } }, { text: 'ef' }]
			})
		]);
		expect(caret(edytor)).toEqual({ text: 'abcef', at: 3 });
	});

	it('Backspace after an inline atom deletes the atom, texts merge', async () => {
		const { edytor } = await renderDomEdytor(atomFixture, { autoSelectFixture: false });
		const last = edytor.root!.children[0]!.lastText!;
		await setNativeSelection(edytor, last, 0, last, 0);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('abcd')]);
		expect(caret(edytor)).toEqual({ text: 'abcd', at: 2 });
	});

	it('forward delete before an inline atom deletes the atom', async () => {
		const { edytor } = await renderDomEdytor(atomFixture, { autoSelectFixture: false });
		const first = edytor.root!.children[0]!.firstText!;
		await setNativeSelection(edytor, first, 2, first, 2);
		await runCommand(edytor, 'deleteContentForward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('abcd')]);
		expect(caret(edytor)).toEqual({ text: 'abcd', at: 2 });
	});

	it('a range across an inline atom removes it with the text', async () => {
		const { edytor } = await renderDomEdytor(atomFixture, { autoSelectFixture: false });
		const first = edytor.root!.children[0]!.firstText!;
		const last = edytor.root!.children[0]!.lastText!;
		await setNativeSelection(edytor, first, 1, last, 1);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('ad')]);
		expect(caret(edytor)).toEqual({ text: 'ad', at: 1 });
	});

	// arch-v2 phase 2 P1 (review probe `del.word-atom`): with nothing of the
	// caret's own text in the delete direction, a word delete was an empty
	// range — a silent no-op. The unit is then the neighbour (`del.caret.one-command`).
	it('word delete right after an inline atom deletes the atom (P1 regression)', async () => {
		const { edytor } = await renderDomEdytor(atomFixture, { autoSelectFixture: false });
		const last = edytor.root!.children[0]!.lastText!;
		await setNativeSelection(edytor, last, 0, last, 0);
		await runCommand(edytor, 'deleteWordBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('abcd')]);
		expect(caret(edytor)).toEqual({ text: 'abcd', at: 2 });
	});

	it('word delete forward right before an inline atom deletes the atom (P1 regression)', async () => {
		const { edytor } = await renderDomEdytor(atomFixture, { autoSelectFixture: false });
		const first = edytor.root!.children[0]!.firstText!;
		await setNativeSelection(edytor, first, 2, first, 2);
		await runCommand(edytor, 'deleteWordForward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('abcd')]);
		expect(caret(edytor)).toEqual({ text: 'abcd', at: 2 });
	});

	it('word delete at a block start merges into the previous block (P1 regression)', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>alpha</paragraph>
				<paragraph>beta</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const t = edytor.root!.children[1]!.firstText!;
		await setNativeSelection(edytor, t, 0, t, 0);
		await runCommand(edytor, 'deleteWordBackward');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('alphabeta')]);
		expect(caret(edytor)).toEqual({ text: 'alphabeta', at: 5 });
	});

	it('typing after an inline atom lands in the following text', async () => {
		const { edytor } = await renderDomEdytor(atomFixture, { autoSelectFixture: false });
		const last = edytor.root!.children[0]!.lastText!;
		await setNativeSelection(edytor, last, 0, last, 0);
		await runCommand(edytor, 'insertText', 'Z');
		await flushDomUpdates();
		expect(
			edytor.value.children?.[0]?.content?.map((part) =>
				'text' in part ? part.text : `[${(part as { type?: string }).type}]`
			)
		).toEqual(['ab', '[mention]', 'Zcd']);
	});
});

describe('golden command programs — typing over a block selection (flow.slot)', () => {
	// arch-v2 phase 2 P1 (review probe `del.select-all-type`): deleting every
	// selected block first let the emptied root normalize in a survivor, and
	// the typed block landed beside it.
	it('typing over every block leaves one block holding the character (P1 regression)', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>first</paragraph>
				<paragraph>note</paragraph>
				<paragraph>tail</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		edytor.selection.selectBlocks(...edytor.root!.children);
		await flushDomUpdates();
		await runCommand(edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('Z')]);
		expect(caret(edytor)).toEqual({ text: 'Z', at: 1 });
	});
});

describe('golden command programs — honest headless UTF-16 semantics', () => {
	it('a synthetic collapsed command deletes one UTF-16 unit (grapheme work is browser-owned)', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>{'ab🇫🇷cd'}</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const t = edytor.root!.children[0]!.firstText!;
		// Caret at 4 = mid-flag (🇫🇷 occupies units 2..6): one unit deleted.
		// In a real browser the targetRange widens this to the whole flag —
		// that derivation is native and lives in advanced-delete.spec.ts.
		await setNativeSelection(edytor, t, 4, t, 4);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		expect(t.stringContent).toBe('ab🇷cd');
	});
});
