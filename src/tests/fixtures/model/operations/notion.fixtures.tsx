/** @jsxImportSource ../../../jsx */
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { runBeforeInput } from '../../../test.utils.js';
import { defineFixtures, defineModelOperationFixture } from '../../types.js';

const notionPlugins = [richTextPlugin, mentionPlugin, markdownShortcutsPlugin];
const noopSnippet = (() => null) as never;

const structuralBranchPlugin: Plugin = () => ({
	blocks: {
		'void-block': {
			snippet: noopSnippet,
			void: true
		},
		'island-block': {
			snippet: noopSnippet,
			island: true
		}
	}
});

export const fixtures = defineFixtures([
	defineModelOperationFixture({
		description:
			'runs a registered command to convert the current block while preserving content and children',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>
					Hello|
					<paragraph>Nested</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.runCommand('block.heading2'),
		output: (
			<root>
				<heading level="h2">
					Hello
					<paragraph>Nested</paragraph>
				</heading>
			</root>
		),
		assert: ({ result }) => {
			if (result !== true) {
				throw new Error('Expected the heading command to run');
			}
		}
	}),
	defineModelOperationFixture({
		description:
			'runs the divider command as an explicit void conversion that clears subtree content',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>
					Hello|
					<paragraph>Nested</paragraph>
				</paragraph>
			</root>
		),
		run: ({ edytor }) => edytor.runCommand('block.divider'),
		// A divider holds no caret: a fresh paragraph after it takes it (Notion).
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<divider></divider>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'rejects command conversion from a void block',
		plugins: [...notionPlugins, structuralBranchPlugin],
		input: (
			<root>
				<void-block>Locked|</void-block>
			</root>
		),
		run: ({ edytor }) => edytor.runCommand('block.heading2'),
		output: (
			<root>
				<void-block>Locked</void-block>
			</root>
		),
		assert: ({ result }) => {
			if (result !== false) {
				throw new Error('Expected the heading command to be disabled for void blocks');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'rejects command conversion from an island block',
		plugins: [...notionPlugins, structuralBranchPlugin],
		input: (
			<root>
				<island-block>Island|</island-block>
			</root>
		),
		run: ({ edytor }) => edytor.runCommand('block.heading2'),
		output: (
			<root>
				<island-block>Island</island-block>
			</root>
		),
		assert: ({ result }) => {
			if (result !== false) {
				throw new Error('Expected the heading command to be disabled for island blocks');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'rejects command conversion inside an island block',
		plugins: [...notionPlugins, structuralBranchPlugin],
		input: (
			<root>
				<island-block>
					Island
					<paragraph>Child|</paragraph>
				</island-block>
			</root>
		),
		run: ({ edytor }) => edytor.runCommand('block.heading2'),
		output: (
			<root>
				<island-block>
					Island
					<paragraph>Child</paragraph>
				</island-block>
			</root>
		),
		assert: ({ result }) => {
			if (result !== false) {
				throw new Error('Expected the heading command to be disabled inside islands');
			}
		}
	}),
	defineModelOperationFixture({
		description: 'converts markdown heading shortcut at the start of a block',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>#|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<heading level="h1"></heading>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts markdown second-level heading shortcut at the start of a block',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>##|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<heading level="h2"></heading>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts markdown third-level heading shortcut at the start of a block',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>###|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<heading level="h3"></heading>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts markdown dash shortcut to a bulleted list item',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>-|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<bulleted-list-item></bulleted-list-item>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts markdown star shortcut to a bulleted list item',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>*|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<bulleted-list-item></bulleted-list-item>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts markdown ordered-list shortcut to a numbered list item',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>1.|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<numbered-list-item></numbered-list-item>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts markdown compact todo shortcut to a todo item',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>[]|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<todo-item checked={false}></todo-item>
			</root>
		)
	}),
	defineModelOperationFixture({
		// Notion: `"` + space is a quote (`>` + space is a toggle).
		description: 'converts markdown quote shortcut to a quote block',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>{'"'}|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<quote></quote>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts the markdown toggle shortcut to a toggle',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>{'>'}|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		output: (
			<root>
				<toggle></toggle>
			</root>
		)
	}),
	// Notion: a prefix typed at the start of a block with text converts it,
	// keeping the text (the caret stays at the start).
	defineModelOperationFixture({
		description: 'converts a dash prefix typed before existing text, keeping the text',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>-|hello</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<bulleted-list-item>hello</bulleted-list-item>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts a heading prefix typed before existing text, keeping the text',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>#|hello</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<heading level="h1">hello</heading>
			</root>
		)
	}),
	defineModelOperationFixture({
		description:
			'a replacing kind (divider) never converts a block that holds more than its prefix',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>--|hello</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: '-' }),
		output: (
			<root>
				<paragraph>---hello</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'does not trigger markdown shortcuts away from the start of a block',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>Hello #|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		output: (
			<root>
				<paragraph>Hello # </paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'does not trigger markdown shortcuts for a non-collapsed selection',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>|#|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		output: (
			<root>
				<paragraph> </paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'does not trigger markdown shortcuts in readonly editors',
		plugins: notionPlugins,
		readonly: true,
		input: (
			<root>
				<paragraph>#|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		output: (
			<root>
				<paragraph>#</paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'does not trigger markdown shortcuts in code lines',
		plugins: [richTextPlugin, mentionPlugin, codePlugin, markdownShortcutsPlugin],
		input: <root></root>,
		value: {
			children: [
				{
					type: 'code',
					children: [{ type: 'codeLine', content: [{ text: '#|' }] }]
				}
			]
		},
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [{ type: 'codeLine', data: {}, content: [{ text: '# ' }] }]
					}
				]
			}
		} as never
	}),
	defineModelOperationFixture({
		description: 'does not trigger markdown shortcuts on island blocks',
		plugins: [...notionPlugins, structuralBranchPlugin],
		input: (
			<root>
				<island-block>#|</island-block>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		output: (
			<root>
				<island-block># </island-block>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'does not trigger markdown shortcuts inside island blocks',
		plugins: [...notionPlugins, structuralBranchPlugin],
		input: (
			<root>
				<island-block>
					Island
					<paragraph>{'>'}|</paragraph>
				</island-block>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		output: (
			<root>
				<island-block>
					Island
					<paragraph>{'> '}</paragraph>
				</island-block>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts markdown todo shortcut to a todo item',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>[ ]|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: ' ' }),
		output: (
			<root>
				<todo-item checked={false}></todo-item>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts triple dash to a divider without waiting for a space',
		plugins: notionPlugins,
		input: (
			<root>
				<paragraph>--|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: '-' }),
		expectSelection: { startBlockPath: [1], yStart: 0, yEnd: 0, isCollapsed: true },
		output: (
			<root>
				<divider></divider>
				<paragraph></paragraph>
			</root>
		)
	}),
	defineModelOperationFixture({
		description: 'converts triple backtick to a code block when the code plugin is installed',
		plugins: [richTextPlugin, mentionPlugin, codePlugin, markdownShortcutsPlugin],
		input: (
			<root>
				<paragraph>``|</paragraph>
			</root>
		),
		run: ({ edytor }) => runBeforeInput(edytor, { inputType: 'insertText', data: '`' }),
		output: {
			value: {
				children: [
					{
						type: 'code',
						data: {},
						children: [{ type: 'codeLine', data: {} }]
					}
				]
			}
		} as never
	})
]);
