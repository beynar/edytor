<!--
	Every chrome surface drawn by its own snippet, keeping the built-in keys
	and ARIA through the controllers' attachments (Playwright:
	`tests/editor-dom/custom-chrome.spec.ts`; the jsdom rows render the same
	fixture, `src/tests/fixtures/dom/custom-ui.test.ts`). `?doc=table` and
	`?doc=code` open a table or a code block between two paragraphs.
-->
<script lang="ts">
	import { page } from '$app/state';
	import type { EdytorContext } from '$lib/components/Edytor.svelte';
	import type { JSONBlock } from '$lib/utils/json.js';
	import CustomChrome from '../../../tests/dom/CustomChrome.svelte';

	let edytor = $state<EdytorContext>();
	const hooks = window as unknown as { __EDYTOR__: unknown };
	// The view, for the truth check every row ends with.
	$effect(() => void (hooks.__EDYTOR__ = edytor));

	const paragraph = (id: string, text: string): JSONBlock => ({
		id,
		type: 'paragraph',
		content: [{ text }]
	});
	const cell = (id: string, column: string): JSONBlock => ({
		id,
		type: 'tableCell',
		data: { column },
		content: [{ text: id }]
	});
	const docs: Record<string, JSONBlock[]> = {
		table: [
			paragraph('one', 'before the table'),
			{
				id: 'T',
				type: 'table',
				data: { columns: [{ id: 'c1' }, { id: 'c2' }] },
				children: [
					{ id: 'R1', type: 'tableRow', children: [cell('a', 'c1'), cell('b', 'c2')] },
					{ id: 'R2', type: 'tableRow', children: [cell('c', 'c1'), cell('d', 'c2')] },
					{ id: 'R3', type: 'tableRow', children: [cell('e', 'c1'), cell('f', 'c2')] }
				]
			},
			paragraph('two', 'after the table')
		],
		code: [
			paragraph('one', 'before the code'),
			{
				id: 'code',
				type: 'code',
				data: { language: 'sql' },
				children: [{ id: 'l0', type: 'codeLine', content: [{ text: 'select 1' }] }]
			},
			paragraph('two', 'after the code')
		]
	};
	const children = docs[page.url.searchParams.get('doc') ?? ''] ?? [
		paragraph('one', 'hello world'),
		paragraph('two', 'second line'),
		paragraph('three', 'third line')
	];
</script>

<main>
	<CustomChrome bind:edytor value={{ children }} />
</main>

<style>
	main {
		max-width: 720px;
		margin: 48px auto;
		padding: 0 64px;
	}
</style>
