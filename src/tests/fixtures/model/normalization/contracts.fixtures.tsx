/** @jsxImportSource ../../../jsx */
import { expect, vi } from 'vitest';

import { Block } from '$lib/block/block.svelte.js';
import { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { Text } from '$lib/text/text.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
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

const replaceContent = (block: Block, content: Array<Text | InlineBlock>) => {
	block.deleteParts(0, block.content.length);
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
									const lastText = block.lastText;
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
			const first = new InlineBlock({ parent: block, block: { type: 'mention' } });
			const second = new InlineBlock({ parent: block, block: { type: 'mention' } });

			replaceContent(block, [first, second]);
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
			const first = new Text({ parent: block, content: [{ text: 'Hello' }] });
			const second = new Text({
				parent: block,
				content: [{ text: ' world', marks: { bold: true } }]
			});

			replaceContent(block, [first, second]);
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
		description: 'normalizes children so the root never becomes childless',
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

			expect(snapshotChildren(edytor.root!)).toEqual([
				{
					type: 'paragraph',
					data: {}
				}
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
			'bounds a non-converging normalizeContent hook (D25) — recursion stops at the shared cap and the depth counter unwinds',
		input: emptyFixture,
		run: () => null,
		assert: () => {
			// A hook that ALWAYS defers more work would recurse forever —
			// the per-block depth cap converts that into a bounded pass
			// count plus a warning.
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

				// MAX_NORMALIZATION_DEPTH (50) re-entries + the initial pass.
				expect(normalizeContent).toHaveBeenCalledTimes(51);
				expect(warnSpy).toHaveBeenCalled();
				// The `finally` unwinds the shared depth — the next pass is not
				// silently suppressed by a leaked counter.
				expect(block._normalizationDepth).toBe(0);
				expectBlockInvariantSnapshot(edytor);
			} finally {
				warnSpy.mockRestore();
			}
		}
	}),
	defineModelTransformFixture({
		description:
			'bounds a non-converging normalizeChildren hook (D25) — content→children share one depth counter',
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
				expect(block._normalizationDepth).toBe(0);
				expectBlockInvariantSnapshot(edytor);
			} finally {
				warnSpy.mockRestore();
			}
		}
	})
]);
