/** @vitest-environment jsdom */
/** @jsxImportSource ./jsx */
import { describe, expect, test } from 'vitest';

import { createTestEdytor } from './test.utils.js';

describe('attachment lifecycle maps', () => {
	test('stale text attachment cleanup does not detach the current text node', () => {
		const { edytor } = createTestEdytor(
			<root>
				<paragraph>Hello</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText;
		const staleNode = document.createElement('span');
		const currentNode = document.createElement('span');

		const staleAttachment = text.attach(staleNode);
		const currentAttachment = text.attach(currentNode);

		staleAttachment.destroy();

		expect(text.node).toBe(currentNode);
		expect(edytor.idToText.get(text.id)).toBe(text);
		expect(edytor.nodeToText.get(currentNode)).toBe(text);
		expect(edytor.nodeToText.has(staleNode)).toBe(false);

		currentAttachment.destroy();

		// A live segment resolves by its id without an element (R4: handles read the index).
		expect(text.node).toBeUndefined();
		expect(edytor.idToText.get(text.id)).toBe(text);
		expect(edytor.nodeToText.has(currentNode)).toBe(false);
	});

	test('stale block attachment cleanup does not detach the current block node', () => {
		const { edytor } = createTestEdytor(
			<root>
				<paragraph>Hello</paragraph>
			</root>
		);
		const block = edytor.root!.children[0]!;
		const staleNode = document.createElement('div');
		const currentNode = document.createElement('div');

		const staleAttachment = block.attach(staleNode);
		const currentAttachment = block.attach(currentNode);

		staleAttachment.destroy();

		expect(block.node).toBe(currentNode);
		expect(edytor.idToBlock.get(block.id)).toBe(block);

		currentAttachment.destroy();

		// A live block's handle resolves without an element: a moved block's
		// element is re-created where it moved (R2); the commit that removes it prunes it (R4).
		expect(block.node).toBeUndefined();
		expect(edytor.idToBlock.get(block.id)).toBe(block);
	});
});
