/** @vitest-environment jsdom */
/** @jsxImportSource ./jsx */
import { describe, expect, test } from 'vitest';

import {
	beginHistoryCommandRestore,
	captureHistoryCommandDocVersion,
	getHistorySelectionSnapshot,
	restoreCollapsedHistorySelection,
	restoreCollapsedHistorySelectionState
} from '$lib/history/historySelectionSnapshot.js';
import { createOperationEdytor } from './test.utils.js';

// Regression coverage for the undo → redo → typing race: the history
// command's selection restore is applied asynchronously, several tasks
// after `undo()`/`redo()` commits. A keystroke landing in that window is
// a committed document change — the pending restore must NOT regress the
// caret back over it, or the next insertion lands at a stale offset.
describe('history selection restore invalidation', () => {
	const setupUndoneInsert = () => {
		const { edytor } = createOperationEdytor(
			<root>
				<paragraph>Worl|d</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText;
		edytor.undoManager.stopCapturing();
		text.insertText({ value: 'eza ', start: 5, end: 5 });
		edytor.undoManager.stopCapturing();
		expect(text.stringContent).toBe('Worldeza ');
		edytor.undoManager.undo();
		expect(text.stringContent).toBe('World');
		return { edytor, text };
	};

	const redoWithSnapshot = (edytor: ReturnType<typeof setupUndoneInsert>['edytor']) => {
		const stackItem = edytor.undoManager.redoStack.at(-1);
		const selectionSnapshot = getHistorySelectionSnapshot(stackItem, { preferRestore: true });
		const shouldRestore = beginHistoryCommandRestore(edytor);
		edytor.undoManager.redo();
		restoreCollapsedHistorySelectionState(edytor, selectionSnapshot, shouldRestore);
		// `refreshDomAfterHistoryChange` baselines the command's document
		// version synchronously after the commit in every caller.
		captureHistoryCommandDocVersion(edytor);
		return { selectionSnapshot, shouldRestore };
	};

	test('pending history selection restore is skipped after an intervening commit', async () => {
		const { edytor, text } = setupUndoneInsert();
		const { selectionSnapshot, shouldRestore } = redoWithSnapshot(edytor);
		expect(text.stringContent).toBe('Worldeza ');
		expect(shouldRestore()).toBe(true);

		// The user types before the delayed DOM restore lands.
		text.insertText({ value: 'e', start: 9, end: 9 });
		edytor.selection.setCollapsedStateAtTextOffset(text, 10);
		expect(text.stringContent).toBe('Worldeza e');
		expect(shouldRestore()).toBe(false);

		await restoreCollapsedHistorySelection(edytor, selectionSnapshot, shouldRestore);

		// The stale restore must not pull the caret back to the snapshot offset.
		expect(edytor.selection.state.startText).toBe(text);
		expect(edytor.selection.state.yStart).toBe(10);
	});

	test('history selection restore still applies when nothing intervenes', async () => {
		const { edytor, text } = setupUndoneInsert();
		const { selectionSnapshot, shouldRestore } = redoWithSnapshot(edytor);

		expect(shouldRestore()).toBe(true);
		await restoreCollapsedHistorySelection(edytor, selectionSnapshot, shouldRestore);

		expect(edytor.selection.state.startText).toBe(text);
		expect(edytor.selection.state.yStart).toBe(Math.min(selectionSnapshot!.yEnd, text.length));
	});

	test('a new history command resets the baseline', () => {
		const { edytor, text } = setupUndoneInsert();
		const { shouldRestore } = redoWithSnapshot(edytor);
		text.insertText({ value: 'e', start: 9, end: 9 });
		expect(shouldRestore()).toBe(false);

		const nextShouldRestore = beginHistoryCommandRestore(edytor);
		expect(nextShouldRestore()).toBe(true);
	});
});
