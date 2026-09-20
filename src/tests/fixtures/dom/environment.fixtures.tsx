/** @jsxImportSource ../../jsx */
import { defineDomFixture, defineFixtures } from '../types.js';
import { dispatchDomBeforeInput } from '../../dom/test.utils.js';

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'mounts the real editor and resolves the JSX cursor into native selection state',
		input: (
			<root>
				<paragraph>he|llo</paragraph>
			</root>
		),
		run: async () => undefined,
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true,
			focusedBlockPaths: [[0]]
		},
		assert: async ({ editor }) => {
			if (editor.getAttribute('contenteditable') !== 'true') {
				throw new Error('Expected mounted editor root to be contenteditable');
			}

			if (!editor.querySelector('[data-edytor-block="true"]')) {
				throw new Error('Expected mounted editor to render at least one block element');
			}

			if (!editor.querySelector('[data-edytor-text="true"]')) {
				throw new Error('Expected mounted editor to render at least one text element');
			}
		}
	}),
	defineDomFixture({
		description: 'dispatches beforeinput through the mounted DOM listener into the editor model',
		input: (
			<root>
				<paragraph>hel|lo</paragraph>
			</root>
		),
		run: ({ editor }) =>
			dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: 'X'
			}),
		output: (
			<root>
				<paragraph>helXlo</paragraph>
			</root>
		),
		expectSelection: {
			startTextPath: [0, 0],
			endTextPath: [0, 0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected mounted beforeinput to prevent native insertion');
			}
		}
	})
]);
