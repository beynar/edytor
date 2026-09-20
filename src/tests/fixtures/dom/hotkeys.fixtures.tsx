/** @jsxImportSource ../../jsx */
import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { defineDomFixture, defineFixtures } from '../types.js';
import { dispatchDomKeyDown } from '../../dom/test.utils.js';

export const fixtures = defineFixtures([
	defineDomFixture({
		description: 'cycles mod+a from text selection to block selection to document selection',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
			</root>
		),
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			return dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
		},
		expectSelection: {
			selectedBlockPaths: [[0], [1]]
		}
	}),
	defineDomFixture({
		description: 'nests the current block on tab and preserves the caret offset',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Se|cond</paragraph>
			</root>
		),
		run: () => dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' }),
		output: (
			<root>
				<paragraph>
					First
					<paragraph>Second</paragraph>
				</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0, 0],
			endBlockPath: [0, 0],
			yStart: 2,
			yEnd: 2,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected tab nesting to prevent native keyboard behavior');
			}
		}
	}),
	defineDomFixture({
		description:
			'grows block selection with shift+arrowdown and collapses it back to a caret on escape',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
				<paragraph>World</paragraph>
				<paragraph>Tail</paragraph>
			</root>
		),
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true });
			return dispatchDomKeyDown(document, { key: 'Escape', code: 'Escape' });
		},
		expectSelection: {
			selectedBlockPaths: [],
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		}
	}),
	defineDomFixture({
		description: 'deletes selected blocks with backspace and focuses the previous block',
		input: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Se|cond</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			return dispatchDomKeyDown(document, { key: 'Backspace', code: 'Backspace' });
		},
		output: (
			<root>
				<paragraph>First</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true,
			selectedBlockPaths: []
		}
	}),
	defineDomFixture({
		description: 'moves a selected block down with the arrow-move plugin',
		input: (
			<root>
				<paragraph>First|</paragraph>
				<paragraph>Second</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		plugins: [richTextPlugin, mentionPlugin, arrowMovePlugin],
		run: async () => {
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			await dispatchDomKeyDown(document, { key: 'a', code: 'KeyA', metaKey: true });
			return dispatchDomKeyDown(document, {
				key: 'ArrowDown',
				code: 'ArrowDown',
				metaKey: true
			});
		},
		output: (
			<root>
				<paragraph>Second</paragraph>
				<paragraph>First</paragraph>
				<paragraph>Third</paragraph>
			</root>
		),
		expectSelection: {
			selectedBlockPaths: [[1]]
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected arrow-move hotkey to prevent native navigation');
			}
		}
	}),
	defineDomFixture({
		description: 'splits the current block at the end on mod+enter',
		input: (
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		),
		run: () =>
			dispatchDomKeyDown(document, {
				key: 'Enter',
				code: 'Enter',
				metaKey: true
			}),
		output: (
			<root>
				<paragraph>Hello</paragraph>
				<paragraph></paragraph>
			</root>
		),
		expectSelection: {
			startBlockPath: [1],
			endBlockPath: [1],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		},
		assert: async ({ result }) => {
			if (!(result as { defaultPrevented?: boolean }).defaultPrevented) {
				throw new Error('Expected mod+enter to prevent native keyboard behavior');
			}
		}
	})
]);
