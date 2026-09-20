/** @jsxImportSource ../../jsx */
import { waitFor } from '@testing-library/svelte';
import { expect } from 'vitest';

import type { Edytor } from '$lib/edytor.svelte.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { flushDomUpdates } from '../../dom/test.utils.js';
import {
	expectSelection as expectModelSelection,
	removeIds,
	type SelectionExpectation
} from '../../test.utils.js';
import { defineDomFixture, defineFixtures } from '../types.js';

const toolbarPlugins = [richTextPlugin, mentionPlugin, toolbarPlugin];
const emptyFixture = <root></root>;
const oldUrl = 'https://old.example';
const newUrl = 'https://new.example';

const serializeChildren = (children: JSONBlock[]) =>
	removeIds(JSON.parse(JSON.stringify(children)) as JSONBlock[]);

const clickToolbarControl = async (element: HTMLElement) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

const setLinkInput = async (element: HTMLElement, value: string) => {
	if (!(element instanceof HTMLInputElement)) {
		throw new Error('Expected toolbar link input');
	}

	element.value = value;
	element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

const expectChildren = (children: JSONBlock[], expected: JSONBlock[]) => {
	expect(serializeChildren(children)).toEqual(expected);
};

const expectToolbarSelection = async (edytor: Edytor, expected: SelectionExpectation) => {
	await waitFor(() => {
		expectModelSelection(edytor, expected);
	});
};

const selectFirstTextRange = async (edytor: Edytor, endOffset: number) => {
	const text = edytor.root?.children[0]?.firstText;
	if (!text) {
		throw new Error('Expected first text for toolbar fixture selection');
	}

	edytor.selection.setRangeStateAtTextOffsets(text, 0, text, endOffset);
	await flushDomUpdates();
};

const linkedSelectionValue = {
	children: [
		{
			type: 'paragraph',
			content: [{ text: '|Link|', marks: { link: { href: oldUrl } } }, { text: ' tail' }]
		}
	]
};

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'keeps the toolbar hidden for collapsed text selections',
		plugins: toolbarPlugins,
		input: (
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		),
		run: () => flushDomUpdates(),
		assert: async ({ queryByTestId }) => {
			expect(queryByTestId('selection-toolbar')).toBeNull();
		}
	}),
	defineDomFixture({
		description: 'shows all toolbar controls for a non-collapsed text selection',
		plugins: toolbarPlugins,
		input: (
			<root>
				<paragraph>|Hello|</paragraph>
			</root>
		),
		run: () => flushDomUpdates(),
		assert: async ({ getByTestId }) => {
			expect(getByTestId('selection-toolbar')).toBeTruthy();
			expect(getByTestId('toolbar-bold')).toBeTruthy();
			expect(getByTestId('toolbar-italic')).toBeTruthy();
			expect(getByTestId('toolbar-underline')).toBeTruthy();
			expect(getByTestId('toolbar-strike')).toBeTruthy();
			expect(getByTestId('toolbar-code')).toBeTruthy();
			expect(getByTestId('toolbar-link-input')).toBeTruthy();
			expect(getByTestId('toolbar-link-apply')).toBeTruthy();
			expect(getByTestId('toolbar-link-remove')).toBeTruthy();
		}
	}),
	defineDomFixture({
		description: 'executes a mark button through the model operation and restores selection',
		plugins: toolbarPlugins,
		input: (
			<root>
				<paragraph>|Hello|</paragraph>
			</root>
		),
		run: ({ getByTestId }) => clickToolbarControl(getByTestId('toolbar-bold')),
		output: (
			<root>
				<paragraph>
					<bold>Hello</bold>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 5,
			isCollapsed: false
		}
	}),
	defineDomFixture({
		description: 'applies a link to selected text and restores selection',
		plugins: toolbarPlugins,
		input: (
			<root>
				<paragraph>|Hello| tail</paragraph>
			</root>
		),
		run: async ({ getByTestId }) => {
			await setLinkInput(getByTestId('toolbar-link-input'), newUrl);
			await clickToolbarControl(getByTestId('toolbar-link-apply'));
		},
		assert: async ({ edytor }) => {
			await expectToolbarSelection(edytor, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 0,
				yEnd: 5,
				isCollapsed: false
			});
			expectChildren(edytor.root?.value.children ?? [], [
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Hello', marks: { link: { href: newUrl } } }, { text: ' tail' }]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'preloads and edits an existing selected link',
		plugins: toolbarPlugins,
		input: emptyFixture,
		value: linkedSelectionValue,
		autoSelectFixture: false,
		run: async ({ edytor, getByTestId }) => {
			await selectFirstTextRange(edytor, 4);
			const input = getByTestId('toolbar-link-input');
			expect((input as HTMLInputElement).value).toBe(oldUrl);
			await setLinkInput(input, newUrl);
			await clickToolbarControl(getByTestId('toolbar-link-apply'));
		},
		assert: async ({ edytor }) => {
			await expectToolbarSelection(edytor, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 0,
				yEnd: 4,
				isCollapsed: false
			});
			expectChildren(edytor.root?.value.children ?? [], [
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Link', marks: { link: { href: newUrl } } }, { text: ' tail' }]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'removes a selected link without changing selection',
		plugins: toolbarPlugins,
		input: emptyFixture,
		value: linkedSelectionValue,
		autoSelectFixture: false,
		run: async ({ edytor, getByTestId }) => {
			await selectFirstTextRange(edytor, 4);
			await clickToolbarControl(getByTestId('toolbar-link-remove'));
		},
		assert: async ({ edytor }) => {
			await expectToolbarSelection(edytor, {
				startBlockPath: [0],
				endBlockPath: [0],
				yStart: 0,
				yEnd: 4,
				isCollapsed: false
			});
			expectChildren(edytor.root?.value.children ?? [], [
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Link tail' }]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'treats an empty link URL as remove for an existing link',
		plugins: toolbarPlugins,
		input: emptyFixture,
		value: linkedSelectionValue,
		autoSelectFixture: false,
		run: async ({ edytor, getByTestId }) => {
			await selectFirstTextRange(edytor, 4);
			await setLinkInput(getByTestId('toolbar-link-input'), '');
			await clickToolbarControl(getByTestId('toolbar-link-apply'));
		},
		assert: async ({ edytor }) => {
			expectChildren(edytor.root?.value.children ?? [], [
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Link tail' }]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'treats an empty link URL as a no-op for unlinked selected text',
		plugins: toolbarPlugins,
		input: (
			<root>
				<paragraph>|Plain| tail</paragraph>
			</root>
		),
		run: async ({ getByTestId }) => {
			await setLinkInput(getByTestId('toolbar-link-input'), '');
			await clickToolbarControl(getByTestId('toolbar-link-apply'));
		},
		assert: async ({ edytor }) => {
			expectChildren(edytor.root?.value.children ?? [], [
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'Plain tail' }]
				}
			]);
		}
	})
]);
