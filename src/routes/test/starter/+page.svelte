<script lang="ts">
	// The starter editor's browser rows (tests/starter.spec.ts): every part on,
	// a schema of each property type, local uploads. `?readonly=1` mounts it
	// readonly, `?theme=dark` under shadcn's `.dark` class, `?comments=1` with
	// threads in memory.
	import { page } from '$app/state';
	import { StarterEditor, type StarterProperty } from '$registry/edytor/starter/index.js';
	import {
		createMemoryCommentsClient,
		type EdytorInstance,
		type JSONDoc,
		type Uploader
	} from '$lib/index.js';

	const params = page.url.searchParams;
	const readonly = params.get('readonly') === '1';
	const dark = params.get('theme') === 'dark';
	const comments =
		params.get('comments') === '1' ? createMemoryCommentsClient({ user: 'ada' }) : undefined;
	const people = [
		{ id: 'ada', label: 'Ada Lovelace' },
		{ id: 'alan', label: 'Alan Turing' }
	];
	const properties: StarterProperty[] = [
		{
			id: 'status',
			name: 'Status',
			type: 'select',
			options: [
				{ value: 'todo', label: 'To do', color: 'gray' },
				{ value: 'doing', label: 'Doing', color: 'blue' },
				{ value: 'done', label: 'Done', color: 'green' }
			]
		},
		{
			id: 'tags',
			name: 'Tags',
			type: 'multi-select',
			options: [{ value: 'docs' }, { value: 'design' }, { value: 'eng' }]
		},
		{ id: 'due', name: 'Due', type: 'date' },
		{ id: 'owner', name: 'Owner', type: 'person' },
		{ id: 'estimate', name: 'Estimate', type: 'number' },
		{ id: 'done', name: 'Shipped', type: 'checkbox' },
		{ id: 'link', name: 'Link', type: 'url' },
		{ id: 'notes', name: 'Notes', type: 'text', hidden: true }
	];
	const upload: Uploader = async (file) => URL.createObjectURL(file);
	const value: JSONDoc = {
		data: { title: 'Starter page', properties: { status: 'doing', due: '2026-10-13' } },
		children: [
			{ id: 'p1', type: 'paragraph', content: [{ text: 'First block' }] },
			{ id: 'p2', type: 'paragraph', content: [{ text: 'Second block' }] }
		]
	};
	let edytor = $state<EdytorInstance>();
	// The rows read the view.
	$effect(() => {
		(window as unknown as { __edytor?: EdytorInstance }).__edytor = edytor;
	});
</script>

<div class={dark ? 'dark' : undefined} data-test-scheme={dark ? 'dark' : 'light'}>
	<StarterEditor
		{value}
		{readonly}
		{people}
		{properties}
		{upload}
		{comments}
		user="ada"
		bind:edytor
	/>
</div>
