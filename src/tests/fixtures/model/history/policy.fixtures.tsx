/** @jsxImportSource ../../../jsx */
import { expect } from 'vitest';

import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '../../../atMention.svelte';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';
import { canonicalValue, runBeforeInput, runHotkey } from '../../../test.utils.js';

const getHistoryState = (edytor: {
	undoManager: { undoStack: unknown[]; redoStack: unknown[] };
}) => ({
	undo: edytor.undoManager.undoStack.length,
	redo: edytor.undoManager.redoStack.length
});

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description: 'coalesces contiguous plain typing into a single undo step',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runBeforeInput(edytor, { inputType: 'insertText', data: 'a' });
			await runBeforeInput(edytor, { inputType: 'insertText', data: 'b' });
			const afterTyping = getHistoryState(edytor);
			await runHotkey(edytor, 'mod+z');
			const afterUndo = {
				value: canonicalValue(edytor.value),
				selection: {
					start: edytor.selection.state.yStart,
					end: edytor.selection.state.yEnd,
					isCollapsed: edytor.selection.state.isCollapsed
				}
			};
			await runHotkey(edytor, 'mod+shift+z');
			return {
				afterTyping,
				afterUndo
			};
		},
		output: (
			<root>
				<paragraph>Helloab</paragraph>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 7, yEnd: 7, isCollapsed: true },
		assert: ({ result }) => {
			expect(result).toMatchObject({
				afterTyping: { undo: 1, redo: 0 },
				afterUndo: {
					value: {
						type: 'root',
						children: [{ type: 'paragraph', data: {}, content: [{ text: 'Hello' }] }]
					},
					selection: { start: 5, end: 5, isCollapsed: true }
				}
			});
		}
	}),
	defineModelOperationFixture({
		description:
			'coalesces contiguous marked typing with the same pending marks into one undo step',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			const startText = edytor.selection.state.startText;
			if (!startText) {
				throw new Error('Missing startText for marked typing history test');
			}

			startText.markText({
				mark: 'bold',
				toggle: true,
				start: edytor.selection.state.yStart,
				end: edytor.selection.state.yStart
			});
			await runBeforeInput(edytor, { inputType: 'insertText', data: 'a' });
			await runBeforeInput(edytor, { inputType: 'insertText', data: 'b' });
			return getHistoryState(edytor);
		},
		output: (
			<root>
				<paragraph>
					Hello<bold>ab</bold>
				</paragraph>
			</root>
		),
		assert: ({ result }) => {
			expect(result).toEqual({ undo: 1, redo: 0 });
		}
	}),
	defineModelOperationFixture({
		description: 'separates typing from a structural split into distinct undo steps',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runBeforeInput(edytor, { inputType: 'insertText', data: '!' });
			await runBeforeInput(edytor, { inputType: 'insertParagraph' });
			const afterSplit = getHistoryState(edytor);
			await runHotkey(edytor, 'mod+z');
			const afterUndo = {
				value: canonicalValue(edytor.value),
				selection: {
					startBlockPath: edytor.selection.state.startBlock?.path ?? null,
					yStart: edytor.selection.state.yStart
				}
			};
			return { afterSplit, afterUndo };
		},
		assert: ({ result }) => {
			expect(result).toMatchObject({
				afterSplit: { undo: 2, redo: 0 },
				afterUndo: {
					value: {
						type: 'root',
						children: [{ type: 'paragraph', data: {}, content: [{ text: 'Hello!' }] }]
					},
					selection: { startBlockPath: [0], yStart: 6 }
				}
			});
		}
	}),
	defineModelOperationFixture({
		description: 'treats paste as its own undo step and clears redo after a new edit',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runBeforeInput(edytor, { inputType: 'insertText', data: '!' });
			await runBeforeInput(edytor, { inputType: 'insertFromPaste', text: ' world' });
			const afterPaste = getHistoryState(edytor);
			await runHotkey(edytor, 'mod+z');
			const afterUndo = getHistoryState(edytor);
			await runBeforeInput(edytor, { inputType: 'insertText', data: '?' });
			return {
				afterPaste,
				afterUndo,
				afterNewEdit: getHistoryState(edytor)
			};
		},
		assert: ({ result }) => {
			expect(result).toEqual({
				afterPaste: { undo: 2, redo: 0 },
				afterUndo: { undo: 1, redo: 1 },
				afterNewEdit: { undo: 2, redo: 0 }
			});
		}
	}),
	defineModelOperationFixture({
		description: 'treats mark toggles as a single undo step with selection restoration',
		input: (
			<root>
				<paragraph>Al|pha</paragraph>
				<paragraph>Bet|a</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runHotkey(edytor, 'mod+b');
			const afterToggle = getHistoryState(edytor);
			await runHotkey(edytor, 'mod+z');
			const afterUndo = {
				value: canonicalValue(edytor.value),
				selection: {
					startBlockPath: edytor.selection.state.startBlock?.path ?? null,
					endBlockPath: edytor.selection.state.endBlock?.path ?? null,
					yStart: edytor.selection.state.yStart,
					yEnd: edytor.selection.state.yEnd,
					isCollapsed: edytor.selection.state.isCollapsed
				}
			};
			await runHotkey(edytor, 'mod+shift+z');
			return { afterToggle, afterUndo };
		},
		assert: ({ result }) => {
			expect(result).toMatchObject({
				afterToggle: { undo: 1, redo: 0 },
				afterUndo: {
					value: {
						type: 'root',
						children: [
							{ type: 'paragraph', data: {}, content: [{ text: 'Alpha' }] },
							{ type: 'paragraph', data: {}, content: [{ text: 'Beta' }] }
						]
					},
					selection: {
						startBlockPath: [0],
						endBlockPath: [1],
						yStart: 2,
						yEnd: 3,
						isCollapsed: false
					}
				}
			});
		}
	}),
	defineModelOperationFixture({
		description: 'treats selected-block deletion as a single undo step',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Se|cond</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runHotkey(edytor, 'mod+a');
			await runHotkey(edytor, 'mod+a');
			await runHotkey(edytor, 'backspace');
			const afterDelete = getHistoryState(edytor);
			await runHotkey(edytor, 'mod+z');
			return {
				afterDelete,
				afterUndo: {
					value: canonicalValue(edytor.value),
					selectedBlockPaths: Array.from(edytor.selection.selectedBlocks).map((block) => block.path)
				}
			};
		},
		assert: ({ result }) => {
			expect(result).toMatchObject({
				afterDelete: { undo: 1, redo: 0 },
				afterUndo: {
					value: {
						type: 'root',
						children: [
							{ type: 'paragraph', data: {}, content: [{ text: 'First' }] },
							{ type: 'paragraph', data: {}, content: [{ text: 'Second' }] },
							{ type: 'paragraph', data: {}, content: [{ text: 'Third' }] }
						]
					},
					selectedBlockPaths: [[1]]
				}
			});
		}
	}),
	defineModelOperationFixture({
		description: 'does not create history entries for block-selection changes alone',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			await runHotkey(edytor, 'mod+a');
			await runHotkey(edytor, 'mod+a');
			await runHotkey(edytor, 'escape');
			return getHistoryState(edytor);
		},
		assert: ({ result }) => {
			expect(result).toEqual({ undo: 0, redo: 0 });
		}
	})
]);
