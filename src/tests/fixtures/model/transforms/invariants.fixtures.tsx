import { expect } from 'vitest';

import type { JSONBlock, JSONDoc, JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import type { Block } from '$lib/block/block.svelte.js';
import { Text } from '$lib/text/text.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { createTestEdytor, expectBlockInvariantSnapshot } from '../../../test.utils.js';
import { emptyFixture } from '../../helpers/model.js';
import { defineFixtures, defineModelTransformFixture } from '../../types.js';

class SeededRng {
	constructor(private state: number) {}

	next() {
		this.state = (this.state * 1664525 + 1013904223) >>> 0;
		return this.state / 0x100000000;
	}

	int(max: number) {
		return Math.floor(this.next() * max);
	}

	bool() {
		return this.next() > 0.5;
	}
}

const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];

const randomWord = (rng: SeededRng) => words[rng.int(words.length)];

const randomTextNode = (rng: SeededRng): JSONText => {
	const node: JSONText = {
		text: `${randomWord(rng)} ${randomWord(rng)}`
	};

	if (rng.bool()) {
		node.marks = { bold: true };
	}

	return node;
};

const randomInlineBlock = (rng: SeededRng): JSONInlineBlock => ({
	type: 'mention',
	data: {
		id: `${rng.int(1000)}`
	}
});

const createRandomParagraph = (rng: SeededRng, depth = 0): JSONBlock => {
	const content: (JSONText | JSONInlineBlock)[] = [randomTextNode(rng)];

	if (rng.bool()) {
		content.push(randomInlineBlock(rng));
		content.push(randomTextNode(rng));
	}

	const block: JSONBlock = {
		type: 'paragraph',
		content
	};

	if (depth < 1 && rng.bool()) {
		block.children = [
			{
				type: 'paragraph',
				content: [randomTextNode(rng)]
			}
		];
	}

	return block;
};

const createRandomDoc = (seed: number): JSONDoc => {
	const rng = new SeededRng(seed);

	return {
		children: [createRandomParagraph(rng), createRandomParagraph(rng), createRandomParagraph(rng)]
	};
};

const collectBlocks = (block: Block): Block[] => {
	return [block, ...block.children.flatMap(collectBlocks)];
};

const pickText = (block: Block) => {
	return block.content.find((part): part is Text => part instanceof Text) ?? null;
};

const pickInlineBlock = (block: Block) => {
	return block.content.find((part): part is InlineBlock => part instanceof InlineBlock) ?? null;
};

const runRandomOperation = (
	edytor: ReturnType<typeof createTestEdytor>['edytor'],
	rng: SeededRng
) => {
	const blocks = collectBlocks(edytor.root!);
	const structuralBlocks = blocks.filter((block) => !block.isRoot);
	const block = structuralBlocks[rng.int(structuralBlocks.length)] ?? edytor.root!;

	switch (rng.int(10)) {
		case 0: {
			const text = pickText(block);
			if (!text) {
				return;
			}
			block.addInlineBlock({
				index: rng.int(text.length + 1),
				block: randomInlineBlock(rng),
				text
			});
			return;
		}
		case 1: {
			const inlineBlock = pickInlineBlock(block);
			if (!inlineBlock) {
				return;
			}
			block.removeInlineBlock({ index: inlineBlock.index });
			return;
		}
		case 2: {
			const text = pickText(block);
			if (!text) {
				return;
			}
			block.splitBlock({
				index: rng.int(text.length + 1),
				text
			});
			return;
		}
		case 3:
			block.mergeBlockBackward();
			return;
		case 4:
			block.mergeBlockForward();
			return;
		case 5:
			block.addChildBlock({
				block: createRandomParagraph(rng, 1),
				index: rng.bool() ? block.children.length : -1
			});
			return;
		case 6:
			block.removeBlock({ keepChildren: rng.bool() });
			return;
		case 7:
			block.moveBlock({ path: [edytor.root!.children.length] });
			return;
		case 8:
			if (rng.bool()) {
				block.nestBlock();
			} else {
				block.unNestBlock();
			}
			return;
		case 9:
			block.setBlock({
				value: rng.bool()
					? {
							type: block.type,
							data: { step: rng.int(100) }
						}
					: {
							type: block.type,
							content: [randomTextNode(rng), randomInlineBlock(rng), randomTextNode(rng)]
						}
			});
			return;
		default:
			return;
	}
};

const assertSerializable = (doc: JSONDoc) => {
	expect(() => JSON.stringify(doc)).not.toThrow();
	const { edytor } = createTestEdytor(emptyFixture, { value: doc });
	expectBlockInvariantSnapshot(edytor);
};

export const fixtures = defineFixtures([
	defineModelTransformFixture({
		description: 'preserves structural invariants across deterministic seeded operation sequences',
		input: emptyFixture,
		value: createRandomDoc(7),
		run: () => null,
		assert: () => {
			for (const seed of [7, 19, 31]) {
				const rng = new SeededRng(seed);
				const { edytor } = createTestEdytor(emptyFixture, { value: createRandomDoc(seed) });

				for (let step = 0; step < 12; step++) {
					runRandomOperation(edytor, rng);
					expectBlockInvariantSnapshot(edytor);
					assertSerializable({
						children: structuredClone(edytor.value.children ?? [])
					});
				}
			}
		}
	})
]);
