/** @jsxImportSource ../../jsx */
/**
 * Headless chrome (site `customization/menus`): the package draws no menu,
 * popup, handle, panel or card. A plugin listed without its snippet mounts
 * nothing in the overlay for that surface, and its controller still works:
 * the `/` menu's keys run its commands, the handles' plugin registers its
 * blocks. Expected results come from that rule, never from a run.
 */
import { describe, expect, it } from 'vitest';
import {
	createBlockHandlesPlugin,
	createBlockMenuPlugin,
	createCodePlugin,
	createFindPlugin,
	createImagePlugin,
	createRichTextPlugin,
	createSlashMenuPlugin,
	createSuggestionsPlugin,
	createTablePlugin,
	createToolbarPlugin
} from '$lib/index.js';
import {
	canonicalTree,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';
import type { JSONBlock } from '$lib/utils/json.js';

const HOSTS = [
	'[data-edytor-slash-menu-host]',
	'[data-edytor-toolbar-host]',
	'[data-edytor-link-card-host]',
	'[data-edytor-block-menu-host]',
	'[data-edytor-block-handle-host]',
	'[data-edytor-find-host]',
	'[data-edytor-suggestion-bar]',
	'[data-edytor-code-language-panel]',
	'[data-edytor-callout-icons]',
	'[data-edytor-equation-panel]'
];
const shown = () => HOSTS.filter((selector) => document.querySelector(selector));

const render = (value?: { children: JSONBlock[] }) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			value,
			blockHandles: false,
			plugins: [
				createBlockHandlesPlugin(),
				createSlashMenuPlugin(),
				createToolbarPlugin(),
				createBlockMenuPlugin(),
				createFindPlugin(),
				createSuggestionsPlugin(),
				createCodePlugin(),
				createTablePlugin(),
				createImagePlugin(),
				createRichTextPlugin()
			]
		}
	);

describe('headless chrome: no snippet, no markup', () => {
	it('the plugins listed without their snippets mount no chrome', async () => {
		const { editor } = await render({
			children: [
				{ id: 'a', type: 'paragraph', content: [{ text: 'a' }] },
				{
					id: 'c',
					type: 'code',
					content: [{ text: '' }],
					children: [{ id: 'l', type: 'codeLine', content: [{ text: 'x' }] }]
				}
			]
		});
		await flushDomUpdates();
		expect(shown()).toEqual([]);
		// The code block's header is empty: its markup is the app's.
		expect(editor.querySelector('[data-edytor-code-header]')?.childElementCount).toBe(0);
	});

	it('the controllers still work: `/divider` and Enter run the command, and nothing shows', async () => {
		const { edytor, editor } = await render();
		for (const data of '/divider')
			await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
		expect(shown()).toEqual([]);
		await dispatchDomKeyDown(document, { key: 'Enter', code: 'Enter' });
		expect(canonicalTree(edytor)).toEqual([{ type: 'divider' }, { type: 'paragraph' }]);
		expect(shown()).toEqual([]);
	});
});
