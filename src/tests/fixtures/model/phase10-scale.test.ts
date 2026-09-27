import { describe, expect, it } from 'vitest';

import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import type { JSONBlock, JSONDoc, JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import { createTestEdytor, expectBlockInvariantSnapshot } from '../../test.utils.js';
import { emptyFixture } from '../helpers/model.js';

type TestEdytor = ReturnType<typeof createTestEdytor>['edytor'];

const getRoot = (edytor: TestEdytor) => {
	if (!edytor.root) {
		throw new Error('Expected Phase 10 scale test editor to have a root block');
	}

	return edytor.root;
};

const createFlatDoc = (count: number): JSONDoc => ({
	children: Array.from({ length: count }, (_, index) => ({
		type: 'paragraph',
		content: [{ text: `Block ${index}` }]
	}))
});

const createNestedBlock = (depth: number): JSONBlock => {
	const root: JSONBlock = {
		type: 'paragraph',
		content: [{ text: 'Level 0' }]
	};
	let current = root;

	for (let level = 1; level < depth; level++) {
		const child: JSONBlock = {
			type: 'paragraph',
			content: [{ text: `Level ${level}` }]
		};
		current.children = [child];
		current = child;
	}

	return root;
};

const createMarkedContent = (count: number): JSONText[] =>
	Array.from({ length: count }, (_, index) => ({
		text: `m${index}`,
		marks: {
			[`phase10Mark${index}`]: true,
			group: index % 2 === 0 ? 'even' : 'odd'
		}
	}));

const createInlineContent = (count: number): JSONInlineBlock[] =>
	Array.from({ length: count }, (_, index) => ({
		type: 'mention',
		data: { id: `phase10-inline-${index}` }
	}));

const assertRoundTrip = (doc: JSONDoc) => {
	const { edytor } = createTestEdytor(emptyFixture, { value: doc });
	expectBlockInvariantSnapshot(edytor);
	const serialized = JSON.parse(JSON.stringify(edytor.value)) as JSONBlock;
	const { edytor: rehydrated } = createTestEdytor(emptyFixture, {
		value: { children: serialized.children ?? [] }
	});
	expectBlockInvariantSnapshot(rehydrated);
	return edytor;
};

describe('phase 10 scale checks', () => {
	for (const count of [1000, 5000]) {
		it(`hydrates and serializes ${count.toLocaleString('en-US')} flat blocks deterministically`, () => {
			const edytor = assertRoundTrip(createFlatDoc(count));
			const root = getRoot(edytor);

			expect(root.children).toHaveLength(count);
			expect(root.children[0].firstText!.stringContent).toBe('Block 0');
			expect(root.children[Math.floor(count / 2)].firstText!.stringContent).toBe(
				`Block ${Math.floor(count / 2)}`
			);
			expect(root.children[count - 1].firstText!.stringContent).toBe(`Block ${count - 1}`);
			expect(edytor.value.children).toHaveLength(count);
		});
	}

	it('hydrates and serializes a 100-level nested tree deterministically', () => {
		const depth = 100;
		const edytor = assertRoundTrip({
			children: [createNestedBlock(depth)]
		});
		let block = getRoot(edytor).children[0];

		for (let level = 0; level < depth; level++) {
			expect(block.firstText!.stringContent).toBe(`Level ${level}`);
			if (level < depth - 1) {
				expect(block.children).toHaveLength(1);
				block = block.children[0];
			}
		}

		expect(block.path).toHaveLength(depth);
	});

	it('keeps many marked segments inside one model text wrapper', () => {
		const markCount = 128;
		const edytor = assertRoundTrip({
			children: [
				{
					type: 'paragraph',
					content: createMarkedContent(markCount)
				}
			]
		});
		const block = getRoot(edytor).children[0];
		const text = block.content[0];

		expect(block.content).toHaveLength(1);
		expect(text).toBeInstanceOf(Text);
		if (!(text instanceof Text)) {
			throw new Error('Expected marked content to hydrate into one Text wrapper');
		}
		expect(text.value).toHaveLength(markCount);
		expect(text.value[0].marks).toMatchObject({ phase10Mark0: true, group: 'even' });
		expect(text.value[markCount - 1].marks).toMatchObject({
			[`phase10Mark${markCount - 1}`]: true,
			group: 'odd'
		});
	});

	it('keeps many inline blocks in one block while preserving separator invariants', () => {
		const inlineCount = 250;
		const edytor = assertRoundTrip({
			children: [
				{
					type: 'paragraph',
					content: createInlineContent(inlineCount)
				}
			]
		});
		const block = getRoot(edytor).children[0];
		const inlineBlocks = block.content.filter(
			(part): part is InlineBlock => part instanceof InlineBlock
		);
		const texts = block.content.filter((part): part is Text => part instanceof Text);

		expect(block.content[0]).toBeInstanceOf(Text);
		expect(block.content.at(-1)).toBeInstanceOf(Text);
		expect(inlineBlocks).toHaveLength(inlineCount);
		expect(texts).toHaveLength(inlineCount + 1);
		expect(block.content).toHaveLength(inlineCount * 2 + 1);
		expect(inlineBlocks[0].data).toEqual({ id: 'phase10-inline-0' });
		expect(inlineBlocks[inlineCount - 1].data).toEqual({
			id: `phase10-inline-${inlineCount - 1}`
		});
	});
});
