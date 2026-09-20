import type { Edytor } from '$lib/edytor.svelte.js';
import type { EditorCommand } from '$lib/plugins.js';
import { richTextOperations } from './richTextOperations.js';

export const createRichTextCommands = (edytor: Edytor): EditorCommand[] => {
	const operations = richTextOperations(edytor);
	const isEnabled = () => operations.canConvertCurrentBlock();

	return [
		{
			id: 'block.paragraph',
			label: 'Paragraph',
			group: 'Blocks',
			isEnabled,
			run: () => operations.convertCurrentBlock({ type: 'paragraph' })
		},
		{
			id: 'block.heading1',
			label: 'Heading 1',
			group: 'Blocks',
			keywords: ['h1', 'title'],
			isEnabled,
			run: () =>
				operations.convertCurrentBlock({
					type: 'heading',
					data: { level: 'h1' }
				})
		},
		{
			id: 'block.heading2',
			label: 'Heading 2',
			group: 'Blocks',
			keywords: ['h2', 'subtitle'],
			isEnabled,
			run: () =>
				operations.convertCurrentBlock({
					type: 'heading',
					data: { level: 'h2' }
				})
		},
		{
			id: 'block.heading3',
			label: 'Heading 3',
			group: 'Blocks',
			keywords: ['h3'],
			isEnabled,
			run: () =>
				operations.convertCurrentBlock({
					type: 'heading',
					data: { level: 'h3' }
				})
		},
		{
			id: 'block.quote',
			label: 'Quote',
			group: 'Blocks',
			isEnabled,
			run: () => operations.convertCurrentBlock({ type: 'quote' })
		},
		{
			id: 'block.bulleted-list-item',
			label: 'Bulleted list',
			group: 'Blocks',
			keywords: ['bullet', 'ul'],
			isEnabled,
			run: () => operations.convertCurrentBlock({ type: 'bulleted-list-item' })
		},
		{
			id: 'block.numbered-list-item',
			label: 'Numbered list',
			group: 'Blocks',
			keywords: ['number', 'ol'],
			isEnabled,
			run: () => operations.convertCurrentBlock({ type: 'numbered-list-item' })
		},
		{
			id: 'block.todo-item',
			label: 'Todo',
			group: 'Blocks',
			keywords: ['task', 'check'],
			isEnabled,
			run: () =>
				operations.convertCurrentBlock({
					type: 'todo-item',
					data: { checked: false }
				})
		},
		{
			id: 'block.toggle',
			label: 'Toggle',
			group: 'Blocks',
			isEnabled,
			run: () => operations.convertCurrentBlock({ type: 'toggle' })
		},
		{
			id: 'block.callout',
			label: 'Callout',
			group: 'Blocks',
			isEnabled,
			run: () =>
				operations.convertCurrentBlock({
					type: 'callout',
					data: { icon: '!' }
				})
		},
		{
			id: 'block.divider',
			label: 'Divider',
			group: 'Blocks',
			keywords: ['hr', 'separator'],
			isEnabled,
			run: () =>
				operations.convertCurrentBlock({
					type: 'divider',
					void: true
				})
		}
	];
};
