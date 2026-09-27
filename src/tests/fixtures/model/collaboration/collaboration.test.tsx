/** @jsxImportSource ../../../jsx */
import { describe, expect, it } from 'vitest';
// Shared-document fixtures run on the vendored v14 engine — a live doc must
// be a unified-node `Y.Doc` (a v13 `yjs` Doc is rejected at the facade
// boundary; stored v13 updates migrate via `crdt.migration`).
import { Y } from '$lib/crdt/engine.js';

import { createOperationEdytor } from '../../../test.utils.js';

const input = (
	<root>
		<paragraph>Hello</paragraph>
	</root>
);

const output = (text: string) => (
	<root>
		<paragraph>{text}</paragraph>
	</root>
);

const createSharedDocEditors = () => {
	const doc = new Y.Doc();
	const first = createOperationEdytor(input, { doc });
	const second = createOperationEdytor(input, { doc });

	first.edytor.undoManager.clear();
	second.edytor.undoManager.clear();

	return { doc, first, second };
};

describe('collaboration provider lifecycle model contracts', () => {
	it('hydrates two editors from one Y.Doc', () => {
		const { doc, first, second } = createSharedDocEditors();

		expect(first.edytor.doc).toBe(doc);
		expect(second.edytor.doc).toBe(doc);
		first.expect(input);
		second.expect(input);
	});

	it('propagates shared Y.Doc updates in both directions', () => {
		const { first, second } = createSharedDocEditors();

		first.edytor.root?.children[0]?.firstText!.insertText({
			value: '!',
			start: 5,
			end: 5
		});
		first.expect(output('Hello!'));
		second.expect(output('Hello!'));

		second.edytor.root?.children[0]?.firstText!.insertText({
			value: 'Say ',
			start: 0,
			end: 0
		});
		first.expect(output('Say Hello!'));
		second.expect(output('Say Hello!'));
	});

	it('composes ONE document — and one shared history — when editors share a raw Y.Doc', () => {
		// U4b/F2: the legacy `{doc}` path goes through `attachDocument`'s
		// raw-doc dedupe — two `Edytor`s on one raw doc can no longer hold
		// two `EdytorDocument`s (two facades/two histories on one doc was
		// the bug). They now share the document AND its undo stack; undo
		// locality is a per-DOCUMENT contract, not per view.
		const { first, second } = createSharedDocEditors();
		expect(first.edytor.document).toBe(second.edytor.document);
		expect(first.edytor.undoManager).toBe(second.edytor.undoManager);

		first.edytor.root?.children[0]?.firstText!.insertText({
			value: '!',
			start: 5,
			end: 5
		});
		first.expect(output('Hello!'));
		second.expect(output('Hello!'));

		// One shared stack — the sibling's undo manager sees it too.
		expect(first.edytor.undoManager.canUndo()).toBe(true);
		expect(second.edytor.undoManager.canUndo()).toBe(true);

		second.edytor.undoManager.undo();
		first.expect(input);
		second.expect(input);
	});

	it('keeps undo local between editors on DIFFERENT raw docs', () => {
		const first = createOperationEdytor(input);
		const second = createOperationEdytor(input);

		first.edytor.root?.children[0]?.firstText!.insertText({
			value: '!',
			start: 5,
			end: 5
		});

		expect(first.edytor.undoManager.canUndo()).toBe(true);
		expect(second.edytor.undoManager.canUndo()).toBe(false);
	});
});
