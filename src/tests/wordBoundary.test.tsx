/** @jsxImportSource ./jsx */
import { describe, expect, it } from 'vitest';

import { createOperationEdytor, runBeforeInput, runHotkey } from './test.utils.js';

// D18 — one word-boundary rule (`events/wordBoundary.ts`) shared by
// caret word jumps and `deleteWord*`: a word is a run of Unicode
// letters/numbers/`_`; whitespace and punctuation are boundaries. These
// pins reproduce the old divergence — `deleteWord*` matched `\S+` runs
// and would eat `bar` right past the comma.
describe('shared word boundaries', () => {
	it('deleteWordBackward stops at punctuation instead of eating the run', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>foo,bar|</paragraph>
			</root>
		);

		await runBeforeInput(edytor, { inputType: 'deleteWordBackward' });

		expect(edytor.root!.children[0].firstText.stringContent).toBe('foo,');
		expect(edytor.selection.state.yStart).toBe(4);
	});

	it('deleteWordForward stops at punctuation', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>foo|bar,baz</paragraph>
			</root>
		);

		await runBeforeInput(edytor, { inputType: 'deleteWordForward' });

		expect(edytor.root!.children[0].firstText.stringContent).toBe('foo,baz');
		expect(edytor.selection.state.yStart).toBe(3);
	});

	it('deleteWordBackward skips whitespace then deletes the word run', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>foo bar |</paragraph>
			</root>
		);

		await runBeforeInput(edytor, { inputType: 'deleteWordBackward' });

		expect(edytor.root!.children[0].firstText.stringContent).toBe('foo ');
		expect(edytor.selection.state.yStart).toBe(4);
	});

	it('word jumps land on word edges across punctuation', async () => {
		const { edytor: forward } = createOperationEdytor(
			<root>
				<paragraph>foo,|bar</paragraph>
			</root>
		);
		await runHotkey(forward, 'mod+arrowright');
		expect(forward.selection.state.yStart).toBe(7);

		const { edytor: backward } = createOperationEdytor(
			<root>
				<paragraph>foo,bar|</paragraph>
			</root>
		);
		await runHotkey(backward, 'mod+arrowleft');
		expect(backward.selection.state.yStart).toBe(4);
	});
});

// D12 — word extension must move the selection's FOCUS edge: the
// document-order start for a reversed selection, the end otherwise. The
// old code always extended `endText`/`yEnd`, so Shift+Alt+Right on a
// reversed range dragged the anchor instead of the focus.
describe('moveByWord reversed selection', () => {
	it('extends the focus (document start) forward on a reversed selection', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>|foo bar| baz</paragraph>
			</root>
		);
		const { startText, yStart, endText, yEnd } = edytor.selection.state;
		edytor.selection.setRangeStateAtTextOffsets(startText!, yStart, endText!, yEnd, {
			isReversed: true
		});

		await runHotkey(edytor, 'mod+shift+arrowright');

		expect(edytor.selection.state.yStart).toBe(3);
		expect(edytor.selection.state.yEnd).toBe(7);
		expect(edytor.selection.state.isReversed).toBe(true);
	});

	it('extends the focus (document start) backward on a reversed selection', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>foo b|ar baz|</paragraph>
			</root>
		);
		const { startText, yStart, endText, yEnd } = edytor.selection.state;
		edytor.selection.setRangeStateAtTextOffsets(startText!, yStart, endText!, yEnd, {
			isReversed: true
		});

		await runHotkey(edytor, 'mod+shift+arrowleft');

		expect(edytor.selection.state.yStart).toBe(4);
		expect(edytor.selection.state.yEnd).toBe(11);
		expect(edytor.selection.state.isReversed).toBe(true);
	});

	it('keeps the anchor when extending a forward selection forward', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>foo |bar| baz</paragraph>
			</root>
		);

		await runHotkey(edytor, 'mod+shift+arrowright');

		expect(edytor.selection.state.yStart).toBe(4);
		expect(edytor.selection.state.yEnd).toBe(11);
		expect(edytor.selection.state.isReversed).toBe(false);
	});

	it('collapses onto the anchor when the focus crosses it', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>foo |bar| baz</paragraph>
			</root>
		);

		await runHotkey(edytor, 'mod+shift+arrowleft');

		expect(edytor.selection.state.isCollapsed).toBe(true);
		expect(edytor.selection.state.yStart).toBe(4);
	});
});
