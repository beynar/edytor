import { tableBlock, type JSONDoc } from 'edytor';

/**
 * The demo room's starting document. The room (site/room) holds no seed of
 * its own: the first browser to join a day's empty room seeds it with this
 * `value`, and the server render shows it as the read-only `snapshot`
 * until the room answers. One constant for both, so they never drift.
 */
export const demoDocument: JSONDoc = {
	children: [
		{ id: 'hello', type: 'heading', data: { level: 'h1' }, content: [{ text: 'Edit this page with everyone' }] },
		{
			id: 'intro',
			type: 'paragraph',
			content: [
				{ text: 'This document is live. Open this page in another tab or send it to a friend: ' },
				{ text: 'every keystroke syncs', marks: { bold: true } },
				{ text: ' through a Cloudflare Durable Object, and it resets every day.' }
			]
		},
		{
			id: 'tip',
			type: 'callout',
			data: { icon: '💡' },
			content: [{ text: 'Try it' }],
			children: [
				{
					id: 'tip-body',
					type: 'paragraph',
					content: [
						{ text: 'Type ' },
						{ text: '/', marks: { code: true } },
						{ text: ' for blocks, select text to format it, and drag the six-dot handle to move or nest a block. Drag from the margin to select several blocks at once.' }
					]
				}
			]
		},
		{ id: 'todo-1', type: 'todo-item', data: { checked: true }, content: [{ text: 'Collaborative by default' }] },
		{ id: 'todo-2', type: 'todo-item', data: { checked: false }, content: [{ text: 'Works offline, syncs when you are back' }] },
		{ id: 'quote', type: 'quote', content: [{ text: 'Your words stay yours, even as the page changes.' }] },
		{
			id: 'columns',
			type: 'columns',
			children: [
				{
					id: 'column-left',
					type: 'column',
					children: [{ id: 'column-left-text', type: 'paragraph', content: [{ text: 'Drag a block to the edge of another to put them side by side.' }] }]
				},
				{
					id: 'column-right',
					type: 'column',
					children: [{ id: 'column-right-text', type: 'paragraph', content: [{ text: 'Drag the gap between two columns to resize them.' }] }]
				}
			]
		},
		{
			...tableBlock({
				cells: [
					['Block', 'What it holds'],
					['Table', 'Rows of cells: drag a grip to move a row or a column'],
					['Columns', 'Any blocks, side by side']
				],
				headerRow: true,
				widths: [140, 320]
			}),
			id: 'table'
		},
		{
			id: 'code',
			type: 'code',
			content: [{ text: '' }],
			children: [{ id: 'code-line', type: 'codeLine', content: [{ text: 'const editor = "yours to shape";' }] }]
		},
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};
