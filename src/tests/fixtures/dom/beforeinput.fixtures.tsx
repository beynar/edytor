/** @jsxImportSource ../../jsx */
import { waitFor } from '@testing-library/svelte';
import { expect } from 'vitest';

import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONBlock } from '$lib/utils/json.js';
import { defineDomFixture, defineFixtures } from '../types.js';
import {
	clickText,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	dispatchPaste
} from '../../dom/test.utils.js';

const dispatchNonCancelableDomBeforeInput = async (
	target: HTMLElement,
	{ inputType, data }: { inputType: string; data: string }
) => {
	const event = new Event('beforeinput', {
		bubbles: true,
		cancelable: false
	}) as InputEvent;

	Object.defineProperties(event, {
		inputType: {
			value: inputType,
			configurable: true
		},
		data: {
			value: data,
			configurable: true
		}
	});

	target.dispatchEvent(event);
	await flushDomUpdates();
};

const stripIds = <T,>(value: T): T =>
	JSON.parse(
		JSON.stringify(value, (key, current) => {
			return key === 'id' ? undefined : current;
		})
	) as T;

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'replaces a block-spanning range on insertText',
		input: (
			<root>
				<paragraph>Hello |there</paragraph>
				<paragraph>gene|ral</paragraph>
			</root>
		),
		run: ({ editor }) =>
			dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: 'X'
			}),
		output: (
			<root>
				<paragraph>Hello Xral</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 7,
			yEnd: 7,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected block-spanning insertText to prevent native input');
			}
		}
	}),
	defineDomFixture({
		description:
			'routes @ insertion through the mention plugin and leaves the caret in trailing text',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ editor }) =>
			dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '@'
			}),
		output: (
			<root>
				<paragraph>
					Hello
					<mention />
				</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'preserves hotkey pending bold across mention insertion',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			await dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
			await dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '@'
			});
			await waitFor(() => {
				expect(edytor.selection.state.startText?.index).toBe(2);
				expect(edytor.selection.state.yStart).toBe(0);
			});

			return dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: 'x'
			});
		},
		output: (
			<root>
				<paragraph>
					Hello
					<mention />
					<bold>x</bold>
				</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'routes non-cancelable hotkey pending @ through mention insertion',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			await dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });
			await dispatchNonCancelableDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '@'
			});
			await waitFor(() => {
				expect(edytor.selection.state.startText?.index).toBe(2);
				expect(edytor.selection.state.yStart).toBe(0);
			});

			return dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: 'x'
			});
		},
		output: (
			<root>
				<paragraph>
					Hello
					<mention />
					<bold>x</bold>
				</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'routes native history undo and redo beforeinput through editor history',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ editor, edytor }) => {
			await dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '!'
			});

			const undoResult = await dispatchDomBeforeInput(editor, {
				inputType: 'historyUndo'
			});
			const afterUndo = stripIds(edytor.value);

			const redoResult = await dispatchDomBeforeInput(editor, {
				inputType: 'historyRedo'
			});

			return {
				undoPrevented: undoResult.defaultPrevented,
				redoPrevented: redoResult.defaultPrevented,
				afterUndo
			};
		},
		output: (
			<root>
				<paragraph>Hello!</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		},
		assert: ({ result }) => {
			expect(result).toMatchObject({
				undoPrevented: true,
				redoPrevented: true,
				afterUndo: {
					type: 'root',
					children: [{ type: 'paragraph', data: {}, content: [{ text: 'Hello' }] }]
				}
			});
		}
	}),
	defineDomFixture({
		description: 'uses the auto-dot insert path without leaving the caret outside the text',
		input: (
			<root>
				<paragraph>Hello.|</paragraph>
			</root>
		),
		run: ({ editor }) =>
			dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '. '
			}),
		output: (
			<root>
				<paragraph>Hello. </paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 7,
			yEnd: 7,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'splits a paragraph in the middle on insertParagraph',
		input: (
			<root>
				<paragraph>Hello |world</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' }),
		output: (
			<root>
				<paragraph>Hello </paragraph>
				<paragraph>world</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'inserts a paragraph before when enter is pressed at the start of a block',
		input: (
			<root>
				<paragraph>|Hello</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' }),
		output: (
			<root>
				<paragraph></paragraph>
				<paragraph>Hello</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'inserts a paragraph after when enter is pressed at the end of a block',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' }),
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph></paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description:
			'lifts block content above nested children when enter is pressed at the end of the parent content',
		input: (
			<root>
				<paragraph>
					Hello|
					<paragraph>Nested child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' }),
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>
					<paragraph>Nested child</paragraph>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true,
			focusedBlockPaths: [[1]]
		}
	}),
	defineDomFixture({
		description: 'inserts line breaks inside paragraph text through the mounted editor',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'insertLineBreak' }),
		output: (
			<root>
				<paragraph>{'Hello\n'}</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'pastes plain text over a block-spanning range',
		input: (
			<root>
				<paragraph>Hello |there</paragraph>
				<paragraph>gene|ral</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchPaste(editor, 'everyone '),
		output: (
			<root>
				<paragraph>Hello everyone ral</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 15,
			yEnd: 15,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'backspaces a nested last child into its parent level',
		input: (
			<root>
				<ordered-list>
					<list-item>
						First
						<list-item>|Second</list-item>
					</list-item>
				</ordered-list>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' }),
		output: (
			<root>
				<ordered-list>
					<list-item>First</list-item>
					<list-item>Second</list-item>
				</ordered-list>
			</root>
		),
		expectSelection: {
			startBlockPath: [0, 1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'backspaces inside plain text and keeps the caret in the edited text node',
		input: (
			<root>
				<paragraph>He|llo</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' }),
		output: (
			<root>
				<paragraph>Hllo</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'backspaces the first document block as a no-op at offset zero',
		input: (
			<root>
				<paragraph>|Hello</paragraph>
				<paragraph>world</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' }),
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>world</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description:
			'removes the previous inline mention when backspacing at the start of the trailing text',
		input: (
			<root>
				<paragraph>
					Hello
					<mention />
					|world
				</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' }),
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'merges backward at the start of a block',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>|world</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' }),
		output: (
			<root>
				<paragraph>Firstworld</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes forward across the next inline mention at the end of a text part',
		input: (
			<root>
				<paragraph>
					Hello|
					<mention />
					world
				</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' }),
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'merges forward when delete is pressed at the end of the current block',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteContentForward' }),
		output: (
			<root>
				<paragraph>FirstSecond</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'replaces a same-block range on paste',
		input: (
			<root>
				<paragraph>Hello |there| world</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchPaste(editor, 'everyone'),
		output: (
			<root>
				<paragraph>Hello everyone world</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 14,
			yEnd: 14,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'routes code-line insertLineBreak through the plugin enter path',
		input: <root></root>,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			type: 'root',
			children: [
				{
					type: 'code',
					children: [
						{
							type: 'codeLine',
							content: [{ text: 'const a = 1;' }]
						}
					]
				}
			]
		},
		autoSelectFixture: false,
		run: async ({ edytor, editor }) => {
			await clickText(edytor, [0, 0, 0], 5);
			return dispatchDomBeforeInput(editor, { inputType: 'insertLineBreak' });
		},
		expectSelection: {
			startBlockPath: [0, 1],
			endBlockPath: [0, 1],
			startTextPath: [0, 1, 0],
			endTextPath: [0, 1, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		},
		assert: async ({ edytor }) => {
			const children = stripIds(edytor.value.children as JSONBlock[]);
			expect(children).toEqual([
				{
					type: 'code',
					data: {},
					children: [
						{
							type: 'codeLine',
							data: {},
							content: [{ text: 'const' }]
						},
						// D-13 / G5: the tail takes the code kind's declared default
						// child (was 'paragraph': richText's first-truthy hook won).
						{
							type: 'codeLine',
							data: {},
							content: [{ text: ' a = 1;' }]
						}
					]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'keeps readonly editors unchanged for beforeinput mutations',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		readonly: true,
		run: ({ editor }) =>
			dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: 'X'
			}),
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			if ((result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected readonly beforeinput to fall through without preventDefault');
			}
		}
	}),
	defineDomFixture({
		description: 'inserts into an empty paragraph without mutating the following paragraph',
		input: (
			<root>
				<paragraph>|</paragraph>
				<paragraph>note</paragraph>
			</root>
		),
		run: ({ editor }) =>
			dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: 'a'
			}),
		output: (
			<root>
				<paragraph>a</paragraph>
				<paragraph>note</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true,
			focusedBlockPaths: [[0]]
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected empty-paragraph insertText to prevent native insertion');
			}
		}
	}),
	defineDomFixture({
		description:
			'replaces a selection after manually setting a mounted caret through click helpers',
		input: (
			<root>
				<paragraph>Hello world</paragraph>
			</root>
		),
		autoSelectFixture: false,
		run: async ({ edytor, editor }) => {
			await clickText(edytor, [0, 0], 5);
			return dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '!'
			});
		},
		output: (
			<root>
				<paragraph>Hello! world</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes the previous word on deleteWordBackward',
		input: (
			<root>
				<paragraph>Hello world|</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteWordBackward' }),
		output: (
			<root>
				<paragraph>Hello </paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes the previous word and its trailing whitespace on deleteWordBackward',
		input: (
			<root>
				<paragraph>Hello world |</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteWordBackward' }),
		output: (
			<root>
				<paragraph>Hello </paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes the next word on deleteWordForward',
		input: (
			<root>
				<paragraph>|Hello world</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteWordForward' }),
		output: (
			<root>
				<paragraph> world</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes to line start on deleteSoftLineBackward',
		input: (
			<root>
				<paragraph>Hello|world</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteSoftLineBackward' }),
		output: (
			<root>
				<paragraph>world</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes to line end on deleteSoftLineForward',
		input: (
			<root>
				<paragraph>Hello|world</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteSoftLineForward' }),
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes a non-collapsed range on deleteWordBackward (content delete path)',
		input: (
			<root>
				<paragraph>Hello |wor|ld</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteWordBackward' }),
		output: (
			<root>
				<paragraph>Hello ld</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes the entire line on deleteEntireSoftLine',
		input: (
			<root>
				<paragraph>Hello|world</paragraph>
			</root>
		),
		run: ({ editor }) => dispatchDomBeforeInput(editor, { inputType: 'deleteEntireSoftLine' }),
		output: (
			<root>
				<paragraph></paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		}
	})
]);
