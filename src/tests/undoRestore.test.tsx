/** @vitest-environment jsdom */
/** @jsxImportSource ./jsx */
import { describe, expect, it } from 'vitest';

import { runHistoryCommand } from '$lib/events/undoRestore.js';
import { removeSelectedBlocksForReplacement } from '$lib/selection/replaceSelection.js';
import { createOperationEdytor } from './test.utils.js';

// D19 — `runHistoryCommand` is the single owner of the undo/redo +
// selection-restore sequence shared by the mod+z/mod+shift+z hotkeys,
// native `historyUndo`/`historyRedo` beforeinput, and the input-event
// fallback. The redo branch computes the block-range fallback (the
// caret lands on the editable end of the block adjacent to the deleted
// selection) — previously only the hotkey path had it, so native redo
// restored differently.
describe('runHistoryCommand', () => {
	it('restores the collapsed caret on undo and redo', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>Worl|d</paragraph>
			</root>
		);
		const text = edytor.root!.children[0].firstText;
		edytor.undoManager.stopCapturing();
		text.insertText({ value: 'eza ', start: 5, end: 5 });
		edytor.undoManager.stopCapturing();
		expect(text.stringContent).toBe('Worldeza ');

		await runHistoryCommand(edytor, 'undo');
		expect(text.stringContent).toBe('World');

		await runHistoryCommand(edytor, 'redo');
		expect(text.stringContent).toBe('Worldeza ');
		expect(edytor.selection.state.startText).toBe(text);
		expect(edytor.selection.state.yStart).toBe(4);
	});

	it('lands the caret on the adjacent block end when redoing a block-range deletion', async () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>aaa</paragraph>
				<paragraph>bbb</paragraph>
				<paragraph>ccc|</paragraph>
			</root>
		);
		edytor.selection.selectBlocks(edytor.root!.children[1]);
		edytor.undoManager.stopCapturing();
		removeSelectedBlocksForReplacement(edytor, { queueUndoSelectionSnapshot: true });
		expect(edytor.root!.children.map((block) => block.firstText.stringContent)).toEqual([
			'aaa',
			'ccc'
		]);

		await runHistoryCommand(edytor, 'undo');
		expect(edytor.root!.children.length).toBe(3);

		// `firstEditableText` requires a DOM node — give the neighbour one
		// so the fallback resolves headless, then re-select the restored
		// block the way undo's selection restore would.
		const neighbourText = edytor.root!.children[0].firstText;
		neighbourText.node = document.createElement('span');
		edytor.selection.selectBlocks(edytor.root!.children[1]);

		await runHistoryCommand(edytor, 'redo');
		expect(edytor.root!.children.map((block) => block.firstText.stringContent)).toEqual([
			'aaa',
			'ccc'
		]);
		expect(edytor.selection.state.startText).toBe(neighbourText);
		expect(edytor.selection.state.yStart).toBe(3);
	});
});
