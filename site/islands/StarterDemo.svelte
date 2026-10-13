<script lang="ts" module>
	// Client only: an editor measures the DOM.
	export const client = 'only';
</script>

<script lang="ts">
	/**
	 * The starter editor's live demo, fully local: no room, no socket,
	 * nothing saved (a reload resets it). Uploads are the file's object URL.
	 */
	import { StarterEditor, type StarterProperty } from 'edytor/starter';
	import type { JSONDoc, Uploader } from 'edytor';

	const people = [
		{ id: 'ada', label: 'Ada Lovelace' },
		{ id: 'grace', label: 'Grace Hopper' },
		{ id: 'alan', label: 'Alan Turing' }
	];
	const properties: StarterProperty[] = [
		{
			id: 'status',
			name: 'Status',
			icon: '◉',
			type: 'select',
			options: [
				{ value: 'draft', label: 'Draft', color: 'gray' },
				{ value: 'review', label: 'In review', color: 'yellow' },
				{ value: 'published', label: 'Published', color: 'green' }
			]
		},
		{ id: 'owner', name: 'Owner', icon: '☺', type: 'person' },
		{
			id: 'tags',
			name: 'Tags',
			icon: '#',
			type: 'multi-select',
			options: [
				{ value: 'guide', color: 'blue' },
				{ value: 'editor', color: 'purple' },
				{ value: 'svelte', color: 'orange' }
			]
		},
		{ id: 'due', name: 'Due', icon: '◷', type: 'date' },
		{ id: 'reviewed', name: 'Reviewed', icon: '☑', type: 'checkbox', hidden: true },
		{ id: 'source', name: 'Source', icon: '↗', type: 'url', hidden: true }
	];
	const cover =
		'data:image/svg+xml,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#fbebde"/><stop offset="0.5" stop-color="#f3ebf9"/><stop offset="1" stop-color="#e5f2fc"/></linearGradient></defs><rect width="1200" height="400" fill="url(#g)"/></svg>'
		);
	const value: JSONDoc = {
		data: {
			title: 'Launch notes',
			icon: { emoji: '🚀' },
			cover: { url: cover, position: 50 },
			properties: { status: 'review', owner: ['ada'], tags: ['guide', 'svelte'] }
		},
		children: [
			{
				id: 'intro',
				type: 'paragraph',
				content: [
					{ text: 'Everything on this page is the starter editor. Type ' },
					{ text: '/', marks: { code: true } },
					{ text: ' for blocks, ' },
					{ text: '@', marks: { code: true } },
					{ text: ' to mention someone, or select text to format it.' }
				]
			},
			{
				id: 'todo',
				type: 'todo',
				data: { checked: false },
				content: [{ text: 'Change the cover, the icon or a property above' }]
			},
			{ id: 'empty', type: 'paragraph' }
		]
	};
	const upload: Uploader = async (file, report) => {
		report.progress(1);
		return URL.createObjectURL(file);
	};
</script>

<div class="starter-demo not-prose">
	<StarterEditor {value} {people} {properties} {upload} aria-label="Starter editor demo" />
</div>

<style>
	.starter-demo {
		overflow: hidden;
		margin: 1rem 0 1.5rem;
		border: 1px solid rgb(0 0 0 / 0.08);
		border-radius: 12px;
		text-align: left;
		--edytor-starter-gutter: 56px;
	}
	.starter-demo :global(:where(h1, h2, h3, h4, p, ul, ol, hr, pre)) {
		margin: 0;
	}
	.starter-demo :global(.starter-page) {
		padding-bottom: 32px;
	}
</style>
