/** @jsxImportSource ../../jsx */
import { expect } from 'vitest';

import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { defineDomFixture, defineFixtures } from '../types.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates
} from '../../dom/test.utils.js';

const slashMenuPlugins = [richTextPlugin, mentionPlugin, slashMenuPlugin];

const typeText = async (editor: HTMLElement, value: string) => {
	for (const character of value) {
		await dispatchDomBeforeInput(editor, {
			inputType: 'insertText',
			data: character
		});
	}
};

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'opens and filters registered commands from a slash query',
		plugins: slashMenuPlugins,
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: ({ editor }) => typeText(editor, '/quo'),
		assert: async ({ getByTestId, getAllByTestId }) => {
			expect(getByTestId('slash-menu-query').textContent).toBe('/quo');
			expect(getAllByTestId('slash-menu-item').map((item) => item.textContent)).toEqual(['Quote']);
		}
	}),
	defineDomFixture({
		description: 'runs the selected slash command with arrow navigation and enter',
		plugins: slashMenuPlugins,
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			await typeText(editor, '/');
			await dispatchDomKeyDown(document, { key: 'ArrowDown', code: 'ArrowDown' });
			await dispatchDomKeyDown(document, { key: 'ArrowDown', code: 'ArrowDown' });
			await dispatchDomKeyDown(document, { key: 'ArrowUp', code: 'ArrowUp' });
			return dispatchDomKeyDown(document, { key: 'Enter', code: 'Enter' });
		},
		output: (
			<root>
				<heading level="h1"></heading>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		assert: async ({ queryByTestId, result }) => {
			expect((result as { defaultPrevented?: boolean }).defaultPrevented).toBe(true);
			expect(queryByTestId('slash-menu')).toBeNull();
		}
	}),
	defineDomFixture({
		description: 'closes the slash menu on escape without removing typed text',
		plugins: slashMenuPlugins,
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			await typeText(editor, '/');
			return dispatchDomKeyDown(document, { key: 'Escape', code: 'Escape' });
		},
		output: (
			<root>
				<paragraph>/</paragraph>
			</root>
		),
		assert: async ({ queryByTestId, result }) => {
			expect((result as { defaultPrevented?: boolean }).defaultPrevented).toBe(true);
			expect(queryByTestId('slash-menu')).toBeNull();
		}
	}),
	defineDomFixture({
		description: 'closes on a query no command matches and leaves the arrows to the caret',
		plugins: slashMenuPlugins,
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			await typeText(editor, '/zzqq');
			return dispatchDomKeyDown(document, { key: 'ArrowDown', code: 'ArrowDown' });
		},
		output: (
			<root>
				<paragraph>/zzqq</paragraph>
			</root>
		),
		assert: async ({ queryByTestId, result }) => {
			expect(queryByTestId('slash-menu')).toBeNull();
			expect((result as { defaultPrevented?: boolean }).defaultPrevented).toBe(false);
		}
	}),
	defineDomFixture({
		description: 'a slash inside a URL does not hold the menu open for the rest of the line',
		plugins: slashMenuPlugins,
		input: (
			<root>
				<paragraph>first</paragraph>
				<paragraph>|</paragraph>
			</root>
		),
		run: async ({ editor }) => {
			// In parentheses: a bare URL typed before a space would become a link
			// (`link.autolink.typed`), which this row is not about.
			await typeText(editor, 'see (http://x.com/zzqq) and more');
			return dispatchDomKeyDown(document, { key: 'ArrowUp', code: 'ArrowUp' });
		},
		output: (
			<root>
				<paragraph>first</paragraph>
				<paragraph>see (http://x.com/zzqq) and more</paragraph>
			</root>
		),
		assert: async ({ queryByTestId, result }) => {
			expect(queryByTestId('slash-menu')).toBeNull();
			expect((result as { defaultPrevented?: boolean }).defaultPrevented).toBe(false);
		}
	}),
	defineDomFixture({
		description: 'runs a slash command from mouse selection',
		plugins: slashMenuPlugins,
		input: (
			<root>
				<paragraph>|</paragraph>
			</root>
		),
		run: async ({ editor, getByTestId }) => {
			await typeText(editor, '/quo');
			const item = getByTestId('slash-menu-item');
			item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
			item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			await flushDomUpdates();
		},
		output: (
			<root>
				<quote></quote>
			</root>
		),
		expectSelection: { startBlockPath: [0], yStart: 0, yEnd: 0, isCollapsed: true },
		assert: async ({ queryByTestId }) => {
			expect(queryByTestId('slash-menu')).toBeNull();
		}
	})
]);
