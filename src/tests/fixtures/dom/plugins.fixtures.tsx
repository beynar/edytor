/** @jsxImportSource ../../jsx */
import { expect } from 'vitest';

import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONBlock } from '$lib/utils/json.js';
import { removeIds } from '../../test.utils.js';
import { defineDomFixture, defineFixtures } from '../types.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	setNativeSelection
} from '../../dom/test.utils.js';

const emptyFixture = <root></root>;

const serializeChildren = (children: JSONBlock[]) =>
	removeIds(JSON.parse(JSON.stringify(children)) as JSONBlock[]);

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'extends link marks when typing inside the trailing anchor edge',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin],
		value: {
			children: [
				{
					type: 'paragraph',
					content: [
						{
							text: 'Link',
							marks: { link: { href: 'https://example.com', target: '_blank' } }
						},
						{ text: ' tail' }
					]
				}
			]
		},
		autoSelectFixture: false,
		run: async ({ editor, edytor }) => {
			const text = edytor.root?.children[0]?.firstText;
			await setNativeSelection(edytor, text, 4);
			if (!text) {
				throw new Error('Missing text for link-boundary plugin fixture');
			}
			await edytor.selection.setAtTextOffset(text, 4);
			return dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '!'
			});
		},
		assert: async ({ edytor, result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected link-boundary typing to prevent native input');
			}

			const children = serializeChildren(edytor.root?.value.children ?? []);
			expect(children).toEqual([
				{
					type: 'paragraph',
					data: {},
					content: [
						{
							text: 'Link!',
							marks: { link: { href: 'https://example.com', target: '_blank' } }
						},
						{ text: ' tail' }
					]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'applies code auto-pairs through the mounted beforeinput path',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [
						{
							type: 'codeLine',
							content: [{ text: 'const value = |' }]
						}
					]
				}
			]
		},
		run: ({ editor }) =>
			dispatchDomBeforeInput(editor, {
				inputType: 'insertText',
				data: '{'
			}),
		expectSelection: {
			startBlockPath: [0, 0],
			yStart: 15,
			yEnd: 15,
			isCollapsed: true
		},
		assert: async ({ edytor }) => {
			const children = serializeChildren(edytor.root?.value.children ?? []);
			expect(children).toEqual([
				{
					type: 'code',
					data: {},
					children: [
						{
							type: 'codeLine',
							data: {},
							content: [{ text: 'const value = {}' }]
						}
					]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'disables block conversion commands inside code islands',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [
						{
							type: 'codeLine',
							content: [{ text: 'const value = |1;' }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'tail' }]
				}
			]
		},
		run: ({ edytor }) => edytor.runCommand('block.heading2'),
		assert: async ({ edytor, result }) => {
			expect(result).toBe(false);

			const children = serializeChildren(edytor.root?.value.children ?? []);
			expect(children).toEqual([
				{
					type: 'code',
					data: {},
					children: [
						{
							type: 'codeLine',
							data: {},
							content: [{ text: 'const value = 1;' }]
						}
					]
				},
				{
					type: 'paragraph',
					data: {},
					content: [{ text: 'tail' }]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'accepts code suggestions on tab and clears the suggestion state',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [
						{
							type: 'codeLine',
							content: [{ text: 'const value = 1;|' }]
						}
					]
				}
			]
		},
		run: async ({ edytor }) => {
			const startBlock = edytor.selection.state.startBlock;
			if (!startBlock) {
				throw new Error('Missing startBlock for mounted code suggestion test');
			}

			startBlock.suggestions = [[{ text: ' // done' }]];
			await dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' });
			return startBlock;
		},
		expectSelection: {
			startBlockPath: [0, 0],
			yStart: 24,
			yEnd: 24,
			isCollapsed: true
		},
		assert: async ({ edytor, result }) => {
			const startBlock = result as { suggestions: unknown };
			if (startBlock.suggestions !== null) {
				throw new Error('Expected code suggestions to be cleared after accepting them');
			}

			const children = serializeChildren(edytor.root?.value.children ?? []);
			expect(children).toEqual([
				{
					type: 'code',
					data: {},
					children: [
						{
							type: 'codeLine',
							data: {},
							content: [{ text: 'const value = 1; // done' }]
						}
					]
				}
			]);
		}
	}),
	defineDomFixture({
		description: 'routes shift+enter in code lines through the plugin hotkey path',
		input: emptyFixture,
		plugins: [richTextPlugin, mentionPlugin, codePlugin],
		value: {
			children: [
				{
					type: 'code',
					children: [
						{
							type: 'codeLine',
							content: [{ text: 'const value = 1;|' }]
						}
					]
				}
			]
		},
		run: () =>
			dispatchDomKeyDown(document, {
				key: 'Enter',
				code: 'Enter',
				shiftKey: true
			}),
		expectSelection: {
			startBlockPath: [0, 1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		},
		assert: async ({ edytor }) => {
			const children = serializeChildren(edytor.root?.value.children ?? []);
			expect(children).toEqual([
				{
					type: 'code',
					data: {},
					children: [
						{
							type: 'codeLine',
							data: {},
							content: [{ text: 'const value = 1;' }]
						},
						{
							type: 'paragraph',
							data: {}
						}
					]
				}
			]);
		}
	})
]);
