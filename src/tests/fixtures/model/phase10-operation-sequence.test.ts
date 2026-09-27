import { describe, expect, it } from 'vitest';

import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import type { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
import {
	createOperationEdytor,
	expectBlockInvariantSnapshot,
	expectTextValue,
	removeIds
} from '../../test.utils.js';
import { emptyFixture } from '../helpers/model.js';

type OperationEdytor = ReturnType<typeof createOperationEdytor>['edytor'];

const initialDoc: JSONDoc = {
	children: [
		{
			type: 'paragraph',
			content: [{ text: 'Alpha' }]
		},
		{
			type: 'paragraph',
			content: [{ text: 'Beta' }]
		},
		{
			type: 'paragraph',
			content: [
				{ text: 'Gamma' },
				{ type: 'mention', data: { id: 'phase10-mention' } },
				{ text: 'Delta' }
			]
		},
		{
			type: 'paragraph',
			content: [{ text: 'Epsilon' }]
		}
	]
};

const cloneDoc = (doc: JSONDoc): JSONDoc => structuredClone(doc);

const getRoot = (edytor: OperationEdytor) => {
	if (!edytor.root) {
		throw new Error('Expected Phase 10 operation test editor to have a root block');
	}

	return edytor.root;
};

const getText = (block: Block, label: string): Text => {
	const text = block.content.find((part): part is Text => part instanceof Text);
	if (!text) {
		throw new Error(`Missing text for ${label}`);
	}
	return text;
};

const expectValue = (value: JSONBlock, expected: JSONDoc) => {
	const actualChildren = removeIds(JSON.parse(JSON.stringify(value.children ?? [])) as JSONBlock[]);
	const expectedChildren = removeIds(structuredClone(expected.children));

	expect(actualChildren).toEqual(expectedChildren);
};

const assertSequenceProperty = (edytor: OperationEdytor) => {
	expectBlockInvariantSnapshot(edytor);
	expect(() => JSON.stringify(edytor.value)).not.toThrow();
	const { edytor: rehydrated } = createOperationEdytor(emptyFixture, {
		value: { children: structuredClone(edytor.value.children ?? []) }
	});
	expectBlockInvariantSnapshot(rehydrated);
};

const stopHistoryCapture = (edytor: OperationEdytor) => {
	edytor.undoManager.stopCapturing();
};

describe('phase 10 deterministic operation sequence checks', () => {
	it('keeps model invariants across insert, split, merge, range delete, hierarchy, move, mark, undo, and redo', () => {
		const { edytor } = createOperationEdytor(emptyFixture, { value: cloneDoc(initialDoc) });
		const root = getRoot(edytor);
		assertSequenceProperty(edytor);

		const alphaText = getText(root.children[0], 'initial insert');
		alphaText.insertText({ value: ' one', start: alphaText.length, end: alphaText.length });
		stopHistoryCapture(edytor);
		assertSequenceProperty(edytor);
		expect(root.children[0].firstText!.stringContent).toBe('Alpha one');

		const splitText = getText(root.children[0], 'split');
		const splitBlock = root.children[0].splitBlock({ index: 6, text: splitText });
		stopHistoryCapture(edytor);
		assertSequenceProperty(edytor);
		expect(splitBlock?.firstText!.stringContent).toBe('one');
		expect(root.children.map((block) => block.firstText!.stringContent)).toEqual([
			'Alpha ',
			'one',
			'Beta',
			'Gamma',
			'Epsilon'
		]);

		const mergedBlock = splitBlock?.mergeBlockBackward();
		stopHistoryCapture(edytor);
		assertSequenceProperty(edytor);
		expect(mergedBlock?.firstText!.stringContent).toBe('Alpha one');
		expect(root.children.map((block) => block.firstText!.stringContent)).toEqual([
			'Alpha one',
			'Beta',
			'Gamma',
			'Epsilon'
		]);

		const mixedContentBlock = root.children[2];
		expect(mixedContentBlock.content.some((part) => part instanceof InlineBlock)).toBe(true);
		mixedContentBlock.deleteContentAtRange({
			start: [0, 2],
			end: [2, 2]
		});
		stopHistoryCapture(edytor);
		assertSequenceProperty(edytor);
		expect(mixedContentBlock.content.some((part) => part instanceof InlineBlock)).toBe(false);
		expect(mixedContentBlock.firstText!.stringContent).toBe('Galta');

		const nestedBlock = root.children[3].nestBlock();
		stopHistoryCapture(edytor);
		assertSequenceProperty(edytor);
		expect(nestedBlock?.path).toEqual([2, 0]);
		expect(root.children).toHaveLength(3);
		expect(root.children[2].children).toHaveLength(1);

		const unnestedBlock = nestedBlock?.unNestBlock();
		stopHistoryCapture(edytor);
		assertSequenceProperty(edytor);
		expect(unnestedBlock?.path).toEqual([3]);
		expect(root.children).toHaveLength(4);

		const movedBlock = root.children[3].moveBlock({ path: [0] });
		stopHistoryCapture(edytor);
		assertSequenceProperty(edytor);
		expect(movedBlock?.path).toEqual([0]);
		expect(root.children.map((block) => block.firstText!.stringContent)).toEqual([
			'Epsilon',
			'Alpha one',
			'Beta',
			'Galta'
		]);

		const movedText = getText(root.children[0], 'mark toggle');
		movedText.markText({ mark: 'bold', start: 0, end: 3, toggle: true });
		stopHistoryCapture(edytor);
		assertSequenceProperty(edytor);
		expectTextValue(movedText, [{ text: 'Eps', marks: { bold: true } }, { text: 'ilon' }]);

		const undoResult = edytor.undoManager.undo();
		assertSequenceProperty(edytor);
		expect(undoResult).not.toBeNull();
		expectTextValue(getText(root.children[0], 'undo mark'), [{ text: 'Epsilon' }]);

		const redoResult = edytor.undoManager.redo();
		assertSequenceProperty(edytor);
		expect(redoResult).not.toBeNull();
		expectTextValue(getText(root.children[0], 'redo mark'), [
			{ text: 'Eps', marks: { bold: true } },
			{ text: 'ilon' }
		]);

		expectValue(edytor.value, {
			children: [
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Eps', marks: { bold: true } }, { text: 'ilon' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Alpha one' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Beta' }]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Galta' }]
				}
			]
		});
	});
});
