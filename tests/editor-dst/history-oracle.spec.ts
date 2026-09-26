import { expect, test } from '@playwright/test';

import type { DstAction } from './generator.js';
import {
	assertHistoryEquivalence,
	expectedHistorySemantic,
	type DstEngineName,
	type DstHistorySummary
} from './runner.js';

const forEveryEngine = <T>(create: () => T): Record<DstEngineName, T> => ({
	chromium: create(),
	firefox: create(),
	webkit: create()
});

const historyStep = ({
	action = { kind: 'type', text: 'x' },
	beforeSemantic = 'before',
	afterSemantic = 'after',
	beforeUndoDepth,
	afterUndoDepth
}: {
	action?: DstAction;
	beforeSemantic?: string;
	afterSemantic?: string;
	beforeUndoDepth: number;
	afterUndoDepth: number;
}): DstHistorySummary => ({
	stepIndex: 0,
	action,
	selection: {
		kind: 'text',
		startTextIndex: 0,
		startOffset: 0,
		endTextIndex: 0,
		endOffset: 0,
		reversed: false
	},
	status: 'passed',
	before: forEveryEngine(() => ({
		semantic: beforeSemantic,
		selection: null,
		undoDepth: beforeUndoDepth,
		redoDepth: 0
	})),
	after: forEveryEngine(() => ({
		semantic: afterSemantic,
		selection: null,
		undoDepth: afterUndoDepth,
		redoDepth: 0,
		events: []
	}))
});

test.describe('DST history oracle', () => {
	test('requires all undo and redo state to agree across engines', () => {
		const baseline = { undoDepth: 1, redoDepth: 2, canUndo: true, canRedo: true };
		const equivalent = forEveryEngine(() => ({ history: { ...baseline } }));
		expect(() => assertHistoryEquivalence(equivalent, null)).not.toThrow();

		for (const divergentHistory of [
			{ ...baseline, undoDepth: 3 },
			{ ...baseline, redoDepth: 3 },
			{ ...baseline, canUndo: false },
			{ ...baseline, canRedo: false }
		]) {
			const divergent = forEveryEngine(() => ({ history: { ...baseline } }));
			divergent.webkit.history = divergentHistory;
			expect(() => assertHistoryEquivalence(divergent, { kind: 'undo' })).toThrow(
				/cross-browser-history-divergence/
			);
		}
	});

	test('expects the prior state only when the action added one undo item', () => {
		const distinct = historyStep({ beforeUndoDepth: 4, afterUndoDepth: 5 });
		const coalesced = historyStep({ beforeUndoDepth: 5, afterUndoDepth: 5 });

		expect(
			expectedHistorySemantic({ kind: 'undo' }, { kind: 'preserve' }, [distinct], 'chromium')
		).toBe('before');
		expect(
			expectedHistorySemantic({ kind: 'undo' }, { kind: 'preserve' }, [coalesced], 'chromium')
		).toBeUndefined();
	});

	test('undo expectations are action-kind agnostic across the v3 input surface', () => {
		// A synthetic paste that added exactly one undo item restores the
		// prior semantic on undo — same contract as a trusted type step.
		const paste = historyStep({
			action: { kind: 'paste', text: 'clip', html: '' },
			beforeUndoDepth: 2,
			afterUndoDepth: 3
		});
		expect(
			expectedHistorySemantic({ kind: 'undo' }, { kind: 'preserve' }, [paste], 'chromium')
		).toBe('before');

		// A non-mutating synthetic action (copy) cannot seed an undo
		// expectation even when scheduled right before an undo.
		const copy = historyStep({
			action: { kind: 'copy' },
			beforeSemantic: 'same',
			afterSemantic: 'same',
			beforeUndoDepth: 2,
			afterUndoDepth: 2
		});
		expect(
			expectedHistorySemantic({ kind: 'undo' }, { kind: 'preserve' }, [copy], 'chromium')
		).toBeUndefined();
	});

	test('keeps the redo round-trip expectation after a coalesced undo', () => {
		const undo = historyStep({
			action: { kind: 'undo' },
			beforeSemantic: 'state-before-undo',
			afterSemantic: 'state-after-undo',
			beforeUndoDepth: 5,
			afterUndoDepth: 4
		});

		expect(expectedHistorySemantic({ kind: 'redo' }, { kind: 'preserve' }, [undo], 'webkit')).toBe(
			'state-before-undo'
		);
	});
});
