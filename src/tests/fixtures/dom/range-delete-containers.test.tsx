/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint D6 rows, dom lane (the doc halves live in
 * `src/tests/crdt/arch-v2/d6-range-delete.test.ts`).
 *
 * - F-D12 — `[ordered-list > [i1 "one", i2 "two"], P "three"]`; select
 *   i1@0 → P@2; Backspace → `[P "ree"]`, caret `P@0`; no empty container
 *   left (P5: red on the reference, the emptied `ordered-list` stays).
 * - `del.range.outside-survives` through the real command: the later item of
 *   a container the range dies through survives (red on the reference: it
 *   died with the container).
 *
 * Expected values come from the plan rows and the contract, never from
 * running the code.
 */
import { describe, expect, it } from 'vitest';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	assertCanonicalTree,
	dispatchDomBeforeInput,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since D6. */
const row = it;

const backspace = (edytor: Edytor) =>
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, {
			inputType: 'deleteContentBackward',
			data: null,
			dataTransfer: null,
			cancelable: true
		})
	);

const caret = (edytor: Edytor) => ({
	text: edytor.selection.state.startText?.stringContent,
	at: edytor.selection.state.yStart,
	collapsed: edytor.selection.state.isCollapsed
});

describe('F-D12 — nested, empty container (dom)', () => {
	row('i1@0 → P@2, Backspace → [P "ree"], caret P@0', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>one</list-item>
					<list-item>two</list-item>
				</ordered-list>
				<paragraph>three</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const i1 = edytor.root!.children[0]!.children[0]!.firstText!;
		const p = edytor.root!.children[1]!.firstText!;
		const pId = edytor.root!.children[1]!.id;
		await setNativeSelection(edytor, i1, 0, p, 2);
		await backspace(edytor);
		await flushDomUpdates();
		assertCanonicalTree(edytor, [{ type: 'paragraph', id: pId, content: [{ text: 'ree' }] }]);
		expect(caret(edytor)).toEqual({ text: 'ree', at: 0, collapsed: true });
	});
});

describe('del.range.outside-survives (dom)', () => {
	row('alpha@2 → beta@2: the list keeps gamma (DR-crdt-4)', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>alpha</paragraph>
				<ordered-list>
					<list-item>beta</list-item>
					<list-item>gamma</list-item>
				</ordered-list>
				<paragraph>omega</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const alpha = edytor.root!.children[0]!.firstText!;
		const beta = edytor.root!.children[1]!.children[0]!.firstText!;
		await setNativeSelection(edytor, alpha, 2, beta, 2);
		await backspace(edytor);
		await flushDomUpdates();
		assertCanonicalTree(edytor, [
			{ type: 'paragraph', content: [{ text: 'alta' }] },
			{
				type: 'ordered-list',
				children: [{ type: 'list-item', content: [{ text: 'gamma' }] }]
			},
			{ type: 'paragraph', content: [{ text: 'omega' }] }
		]);
		expect(caret(edytor)).toEqual({ text: 'alta', at: 2, collapsed: true });
	});
});

describe('D6 follow-up — seam delete and undo selection (dom)', () => {
	const basic = () => (
		<root>
			<paragraph></paragraph>
			<paragraph>note</paragraph>
			<paragraph>tail</paragraph>
		</root>
	);
	const texts = (edytor: Edytor) =>
		edytor.root!.children.map((block) => block.firstText?.stringContent ?? '');

	it('a range from a block end to the next block start joins them (del.range.flat)', async () => {
		const { edytor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		const note = edytor.root!.children[1]!.firstText!;
		const tail = edytor.root!.children[2]!.firstText!;
		// The model range the Shift+ArrowRight extension hands the command.
		edytor.selection.setAtRange(note!, 4, tail!, 0);
		await backspace(edytor);
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['', 'notetail']);
		expect(caret(edytor)).toEqual({ text: 'notetail', at: 4, collapsed: true });
	});

	it('undo restores the cross-block range a replacement consumed', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		const empty = edytor.root!.children[0]!.firstText!;
		const note = edytor.root!.children[1]!.firstText!;
		await setNativeSelection(edytor, empty, 0, note, 3);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'Z' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['Ze', 'tail']);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['', 'note', 'tail']);
		const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
		expect({
			start: startText?.parent.index,
			end: endText?.parent.index,
			yStart,
			yEnd,
			isCollapsed
		}).toEqual({ start: 0, end: 1, yStart: 0, yEnd: 3, isCollapsed: false });
	});

	it('undo restores a reversed in-block range a soft break replaced', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>lead</paragraph>
				<paragraph>note</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const lead = edytor.root!.children[0]!.firstText!;
		await setNativeSelection(edytor, lead, 1, lead, 4, { reversed: true });
		await dispatchDomBeforeInput(editor, { inputType: 'insertLineBreak' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['l\n', 'note']);
		await setNativeSelection(edytor, edytor.root!.children[1]!.firstText!, 0);
		edytor.historyUndo();
		await flushDomUpdates();
		const { yStart, yEnd, isCollapsed, isReversed } = edytor.selection.state;
		expect(texts(edytor)).toEqual(['lead', 'note']);
		expect({ yStart, yEnd, isCollapsed, isReversed }).toEqual({
			yStart: 1,
			yEnd: 4,
			isCollapsed: false,
			isReversed: true
		});
	});
});
