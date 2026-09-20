/** @jsxImportSource ../../../jsx */
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { emptyFixture } from '../../helpers/model.js';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';
import { runBeforeInput } from '../../../test.utils.js';

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description: 'inserts plain text at a collapsed caret',
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: 'p' }),
		expectSelection: {
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		},
		output: (
			<root>
				<paragraph>Helplo</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected insertText to prevent the native beforeinput');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'replaces a same-block range that spans multiple text parts',
		input: (
			<root>
				<paragraph>
					Hel|lo<mention></mention>wo|rld
				</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: 'X' }),
		expectSelection: { startTextPath: [0, 0], yStart: 4, yEnd: 4, isCollapsed: true },
		output: (
			<root>
				<paragraph>HelXrld</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'replaces a block-spanning selection and merges the remaining content',
		input: (
			<root>
				<paragraph>Hello |there</paragraph>
				<paragraph>gene|ral</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: 'X' }),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 7,
			yEnd: 7,
			isCollapsed: true
		},
		output: (
			<root>
				<paragraph>Hello Xral</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'handles cross-block replacement text through the model instead of native DOM',
		input: (
			<root>
				<paragraph>le|ad</paragraph>
				<paragraph>no|te</paragraph>
				<paragraph></paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertReplacementText', data: 'X' }),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 3,
			yEnd: 3,
			isCollapsed: true
		},
		output: (
			<root>
				<paragraph>leXte</paragraph>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'routes mention insertion through the plugin operation hook',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: '@' }),
		expectSelection: {
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		},
		output: (
			<root>
				<paragraph>
					Hello<mention></mention>
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'preserves pending bold across mention insertion',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: async ({ edytor }) => {
			edytor.selection.state.startText?.markText({ mark: 'bold', toggle: true });
			await runBeforeInput(edytor, { inputType: 'insertText', data: '@' });
			return runBeforeInput(edytor, { inputType: 'insertText', data: 'x' });
		},
		expectSelection: {
			startTextPath: [0, 2],
			endTextPath: [0, 2],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		},
		output: (
			<root>
				<paragraph>
					Hello<mention></mention>
					<bold>x</bold>
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'applies code-plugin auto-pairs through the same operation path',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: 'const value = |' }] }]
				}
			]
		},
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: '{' }),
		expectSelection: { startBlockPath: [0, 0], yStart: 15, yEnd: 15, isCollapsed: true },
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [{ type: 'codeLine', data: {}, content: [{ text: 'const value = {}' }] }]
					}
				]
			}
		} as never
	}),
	defineModelOperationFixture({
		description: 'uses the auto-dot path without leaving the caret outside the text bounds',
		input: (
			<root>
				<paragraph>Hello.|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: '. ' }),
		expectSelection: { startTextPath: [0, 0], yStart: 7, yEnd: 7, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hello. </paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'deletes backward inside a text node',
		input: (
			<root>
				<paragraph>Hello| world</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'deleteContentBackward' }),
		expectSelection: { startTextPath: [0, 0], yStart: 4, yEnd: 4, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hell world</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'removes the previous inline block when backspacing at the start of a text part',
		input: (
			<root>
				<paragraph>
					Hello<mention></mention>|world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'deleteContentBackward' }),
		expectSelection: { startTextPath: [0, 0], yStart: 5, yEnd: 5, isCollapsed: true },
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'merges backward at the start of a block',
		input: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>|world</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'deleteContentBackward' }),
		expectSelection: { startBlockPath: [0], yStart: 5, yEnd: 5, isCollapsed: true },
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'unnests the last nested child when backspacing at the start of the block',
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
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'deleteContentBackward' }),
		expectSelection: { startBlockPath: [0, 1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<ordered-list>
					<list-item>First</list-item>
					<list-item>Second</list-item>
				</ordered-list>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'guards the first non-empty block of the document',
		input: (
			<root>
				<paragraph>|Hello</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'deleteContentBackward' }),
		output: (
			<root>
				<paragraph>Hello</paragraph>
			</root>
		),
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected guarded backward delete to prevent the native event');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'removes the next inline block when deleting at the end of a text part',
		input: (
			<root>
				<paragraph>
					Hello|<mention></mention>world
				</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'deleteContentForward' }),
		expectSelection: { startTextPath: [0, 0], yStart: 5, yEnd: 5, isCollapsed: true },
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'merges forward at the end of a block',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>world</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'deleteContentForward' }),
		expectSelection: { startBlockPath: [0], yStart: 5, yEnd: 5, isCollapsed: true },
		output: (
			<root>
				<paragraph>Helloworld</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'splits a block in the middle',
		input: (
			<root>
				<paragraph>Hello |world</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertParagraph' }),
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hello </paragraph>
				<paragraph>world</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'inserts a new block before when the caret is at the start',
		input: (
			<root>
				<paragraph>|Hello</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertParagraph' }),
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<paragraph></paragraph>
				<paragraph>Hello</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'inserts a new block after when the caret is at the end',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertParagraph' }),
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description:
			'lifts parent content above nested children when enter is pressed at the end of a block',
		input: (
			<root>
				<paragraph>
					Hello|
					<paragraph>Nested child</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertParagraph' }),
		expectSelection: {
			startBlockPath: [1],
			endBlockPath: [1],
			startTextPath: [1, 0],
			endTextPath: [1, 0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		},
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph>
					<paragraph>Nested child</paragraph>
				</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'replaces a selection before inserting the new paragraph boundary',
		input: (
			<root>
				<paragraph>Hello |wide| world</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertParagraph' }),
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hello </paragraph>
				<paragraph> world</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'inserts a newline into the current text node',
		input: (
			<root>
				<paragraph>Hello|world</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertLineBreak' }),
		expectSelection: { startTextPath: [0, 0], yStart: 6, yEnd: 6, isCollapsed: true },
		output: (
			<root>
				<paragraph>{'Hello\nworld'}</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'pastes plain text into a collapsed caret',
		input: (
			<root>
				<paragraph>Hello| world</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			runBeforeInput(edytor, { inputType: 'insertFromPaste', text: ' brave new' }),
		expectSelection: { startTextPath: [0, 0], yStart: 15, yEnd: 15, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hello brave new world</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'pastes over a block-spanning selection',
		input: (
			<root>
				<paragraph>Hello |there</paragraph>
				<paragraph>gene|ral</paragraph>
			</root>
		),
		run: ({ edytor }) =>
			runBeforeInput(edytor, { inputType: 'insertFromPaste', text: 'everyone ' }),
		expectSelection: { startBlockPath: [0], yStart: 15, yEnd: 15, isCollapsed: true },
		output: (
			<root>
				<paragraph>Hello everyone ral</paragraph>
			</root>
		)
	})
]);
