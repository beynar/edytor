/** @jsxImportSource ../../../jsx */
import { expect, vi } from 'vitest';

import { Block } from '$lib/block/block.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { Text } from '$lib/text/text.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock, JSONInlineBlock, JSONText } from '$lib/utils/json.js';
import { createTestEdytor, expectBlockInvariantSnapshot, removeIds } from '../../../test.utils.js';
import { emptyFixture } from '../../helpers/model.js';
import { defineFixtures, defineModelTransformFixture } from '../../types.js';

const serializeChildren = (children: JSONBlock[]) =>
	removeIds(JSON.parse(JSON.stringify(children)) as JSONBlock[]);

const snapshotChildren = (block: Block) => serializeChildren(block.edytor.value.children ?? []);

const expectSecondPassStable = (block: Block) => {
	const firstPass = JSON.stringify(snapshotChildren(block));
	block.normalizeContent();
	block.normalizeChildren();
	expect(JSON.stringify(snapshotChildren(block))).toBe(firstPass);
	expectBlockInvariantSnapshot(block.edytor);
};

/** Replace a block's content with JSON parts (R4: parts are specs, not wrappers). */
const replaceContent = (block: Block, content: (JSONText[] | JSONInlineBlock)[]) => {
	block.model!.deleteText(0, block.model!.length);
	block.insertParts(0, content);
};

const normalizationPlugin = (kind: 'content' | 'children'): Plugin => {
	return (edytor) => {
		const paragraph = richTextPlugin(edytor).blocks?.paragraph;
		const paragraphSnippet =
			typeof paragraph === 'object' && paragraph !== null ? paragraph.snippet : paragraph;

		return {
			blocks: {
				paragraph: {
					snippet: paragraphSnippet!,
					normalizeContent:
						kind === 'content'
							? ({ block }) => {
									const lastText = block.lastText!;
									if (lastText.stringContent.endsWith('!')) {
										return;
									}

									return () => {
										lastText.insertText({
											value: '!',
											start: lastText.length,
											end: lastText.length
										});
									};
								}
							: undefined,
					normalizeChildren:
						kind === 'children'
							? ({ block }) => {
									if (block.children.length > 0) {
										return;
									}

									return () => {
										block.addChildBlock({
											index: 0,
											block: {
												type: 'paragraph',
												content: [{ text: 'child' }]
											}
										});
									};
								}
							: undefined
				}
			}
		};
	};
};

export const fixtures = defineFixtures([
	defineModelTransformFixture({
		description:
			'normalizes malformed inline-only content to text sentinels and separated inline blocks',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const { edytor } = createTestEdytor(emptyFixture, {
				value: {
					children: [{ type: 'paragraph', content: [{ text: 'seed' }] }]
				}
			});
			const block = edytor.root!.children[0];
			replaceContent(block, [{ type: 'mention' }, { type: 'mention' }]);
			block.normalizeContent();

			expect(block.content[0]).toBeInstanceOf(Text);
			expect(block.content.at(-1)).toBeInstanceOf(Text);
			expect(block.content.filter((part) => part instanceof InlineBlock)).toHaveLength(2);
			expect(snapshotChildren(block)).toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [
						{ type: 'mention', data: {} },
						{ type: 'mention', data: {} }
					]
				}
			]);
			expectSecondPassStable(block);
		}
	}),
	defineModelTransformFixture({
		description: 'collapses adjacent text parts into a single text node',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const { edytor } = createTestEdytor(emptyFixture, {
				value: {
					children: [{ type: 'paragraph', content: [{ text: 'seed' }] }]
				}
			});
			const block = edytor.root!.children[0];
			replaceContent(block, [[{ text: 'Hello' }], [{ text: ' world', marks: { bold: true } }]]);
			block.normalizeContent();

			expect(snapshotChildren(block)).toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Hello' }, { text: ' world', marks: { bold: true } }]
				}
			]);
			expectSecondPassStable(block);
		}
	}),
	defineModelTransformFixture({
		description: 'an emptied root writes nothing: the view shows its virtual paragraph',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const { edytor } = createTestEdytor(
				<root>
					<paragraph>Hello</paragraph>
				</root>
			);

			edytor.root!.deleteChildren(0, edytor.root!.children.length);
			edytor.root!.normalizeChildren();

			// The document is empty (`doc.empty.virtual`); the view's root shows one
			// paragraph that is not written.
			expect(snapshotChildren(edytor.root!)).toEqual([]);
			expect(edytor.root!.children.map((block) => [block.id, block.type])).toEqual([
				[edytor.facade.virtual(), 'paragraph']
			]);
			expectSecondPassStable(edytor.root!);
		}
	}),
	defineModelTransformFixture({
		description: 'honors plugin-provided normalizeContent hooks',
		input: emptyFixture,
		plugins: [normalizationPlugin('content'), richTextPlugin, mentionPlugin],
		value: {
			children: [{ type: 'paragraph', content: [{ text: 'Hello' }] }]
		},
		run: ({ edytor }) => {
			edytor.root!.children[0].normalizeContent();
		},
		assert: ({ edytor }) => {
			const block = edytor.root!.children[0];
			expect(snapshotChildren(block)).toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Hello!' }]
				}
			]);
			expectSecondPassStable(block);
		}
	}),
	defineModelTransformFixture({
		description: 'honors plugin-provided normalizeChildren hooks',
		input: emptyFixture,
		plugins: [normalizationPlugin('children'), richTextPlugin, mentionPlugin],
		value: {
			children: [{ type: 'paragraph', content: [{ text: 'Hello' }] }]
		},
		run: ({ edytor }) => {
			edytor.root!.children[0].normalizeChildren();
		},
		assert: ({ edytor }) => {
			const block = edytor.root!.children[0];
			expect(snapshotChildren(block)).toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Hello' }],
					children: [
						{
							type: 'paragraph',
							data: {},
							content: [{ text: 'child' }]
						}
					]
				}
			]);
			expectSecondPassStable(block);
		}
	}),
	defineModelTransformFixture({
		description: 'remains stable after a second normalization pass across structural operations',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const scenarios = [
				() => {
					const { edytor } = createTestEdytor(
						<root>
							<paragraph>Hello| world</paragraph>
						</root>
					);
					const block = edytor.root!.children[0];
					block.setBlock({
						value: {
							type: 'paragraph',
							content: [{ type: 'mention' }, { text: ' world', marks: { bold: true } }]
						}
					});
					expectSecondPassStable(block);
				},
				() => {
					const { edytor } = createTestEdytor(
						<root>
							<paragraph>Hello| world</paragraph>
						</root>
					);
					const block = edytor.root!.children[0];
					const text = edytor.selection.state.startText!;
					block.addInlineBlock({
						index: edytor.selection.state.yStart,
						block: { type: 'mention' },
						text
					});
					block.removeInlineBlock({ index: 1 });
					expectSecondPassStable(block);
				},
				() => {
					const { edytor } = createTestEdytor(
						<root>
							<paragraph>
								Hel|lo <mention />
								world
							</paragraph>
						</root>
					);
					const block = edytor.root!.children[0];
					block.splitBlock({
						index: edytor.selection.state.yStart,
						text: edytor.selection.state.startText!
					});
					expectSecondPassStable(edytor.root!.children[0]);
					expectSecondPassStable(edytor.root!.children[1]);
				},
				() => {
					const { edytor } = createTestEdytor(
						<root>
							<paragraph>Hello</paragraph>
							<paragraph>
								<mention />
								|world
							</paragraph>
						</root>
					);
					edytor.root!.children[1].mergeBlockBackward();
					expectSecondPassStable(edytor.root!.children[0]);
				},
				() => {
					const { edytor } = createTestEdytor(
						<root>
							<paragraph>Hello|</paragraph>
						</root>
					);
					const block = edytor.root!.children[0];
					block.suggestText({
						value: [{ type: 'mention' }, { text: ' world', marks: { bold: true } }]
					});
					block.acceptSuggestedText();
					expectSecondPassStable(block);
				}
			];

			scenarios.forEach((runScenario) => runScenario());
		}
	}),
	defineModelTransformFixture({
		description:
			'bounds a non-converging normalizeContent hook (D25) — passes stop at the limit and the next command is not suppressed',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			// A hook that ALWAYS answers more work would request its block
			// forever — the dispatcher's per-command pass limit converts that
			// into a bounded pass count plus a warning.
			const normalizeContent = vi.fn(() => () => {});
			const loopPlugin: Plugin = (editor) => ({
				blocks: {
					paragraph: { ...(richTextPlugin(editor).blocks!.paragraph as object), normalizeContent }
				}
			});
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const { edytor } = createTestEdytor(emptyFixture, {
					plugins: [loopPlugin, richTextPlugin],
					value: { children: [{ type: 'paragraph', content: [{ text: 'seed' }] }] }
				});
				const block = edytor.root!.children[0];

				normalizeContent.mockClear();
				warnSpy.mockClear();
				block.normalizeContent();

				// 50 re-requests + the initial pass (the dispatcher's pass limit).
				expect(normalizeContent).toHaveBeenCalledTimes(51);
				expect(warnSpy).toHaveBeenCalled();
				// The limit is per command — the next one is not silently
				// suppressed by a leaked counter.
				normalizeContent.mockClear();
				block.normalizeContent();
				expect(normalizeContent).toHaveBeenCalledTimes(51);
				expectBlockInvariantSnapshot(edytor);
			} finally {
				warnSpy.mockRestore();
			}
		}
	}),
	defineModelTransformFixture({
		description:
			'bounds a non-converging normalizeChildren hook (D25) — passes stop at the limit and the next command is not suppressed',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			const normalizeChildren = vi.fn(() => () => {});
			const loopPlugin: Plugin = (editor) => ({
				blocks: {
					paragraph: { ...(richTextPlugin(editor).blocks!.paragraph as object), normalizeChildren }
				}
			});
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const { edytor } = createTestEdytor(emptyFixture, {
					plugins: [loopPlugin, richTextPlugin],
					value: { children: [{ type: 'paragraph', content: [{ text: 'seed' }] }] }
				});
				const block = edytor.root!.children[0];

				normalizeChildren.mockClear();
				warnSpy.mockClear();
				block.normalizeChildren();

				expect(normalizeChildren).toHaveBeenCalledTimes(51);
				expect(warnSpy).toHaveBeenCalled();
				normalizeChildren.mockClear();
				block.normalizeChildren();
				expect(normalizeChildren).toHaveBeenCalledTimes(51);
				expectBlockInvariantSnapshot(edytor);
			} finally {
				warnSpy.mockRestore();
			}
		}
	})
]);
