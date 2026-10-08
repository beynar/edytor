<!--
	The comments plugin (Playwright: `tests/editor-dom/comments.spec.ts`):
	one editor with the toolbar, its threads in a memory client as `ada`.
	`window.__COMMENTS__` holds `bob`, a sibling client of the same threads
	(another user), and the changes `onComment` heard.

	Query: `client=http` (the default `createCommentsClient` over
	`/test-comments-api/doc`, which the spec routes), `readonly=true`.
-->
<script lang="ts">
	import { page } from '$app/state';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { createDocument } from '$lib/crdt/index.js';
	import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import { createCommentsPlugin } from '$lib/plugins/comments/commentsPlugin.js';
	import {
		createCommentsClient,
		createMemoryCommentsClient
	} from '$lib/collaboration/comments/client.js';
	import type { CommentChange } from '$lib/crdt/protocols/comments.js';

	const document = createDocument({
		value: {
			children: [
				{
					id: 'a',
					type: 'paragraph',
					content: [{ text: 'The quick brown fox jumps over the dog.' }]
				},
				{ id: 'b', type: 'paragraph', content: [{ text: 'A second paragraph of text.' }] },
				{ id: 'c', type: 'paragraph', content: [{ text: 'The last line.' }] }
			]
		}
	});
	const memory = createMemoryCommentsClient({ user: 'ada' });
	const client =
		page.url.searchParams.get('client') === 'http'
			? createCommentsClient({
					server: `${page.url.origin}/test-comments-api`,
					room: 'doc',
					params: { token: 'secret' }
				})
			: memory;
	const heard: Array<{ type: CommentChange['type']; own: boolean }> = [];
	const comments = createCommentsPlugin({
		client,
		user: { id: 'ada', name: 'Ada Lovelace' },
		users: (id) => (id === 'bob' ? { name: 'Bob' } : undefined),
		onComment: (change, { own }) => heard.push({ type: change.type, own })
	});
	let edytor = $state<EdytorContext>();
	const hooks = window as unknown as { __COMMENTS__: unknown; __EDYTOR__: unknown };
	hooks.__COMMENTS__ = { bob: memory.as('bob'), heard };
	// The view, for the truth check every row ends with.
	$effect(() => void (hooks.__EDYTOR__ = edytor));
</script>

<main>
	<Edytor
		{document}
		bind:edytor
		plugins={[comments, toolbarPlugin]}
		readonly={page.url.searchParams.get('readonly') === 'true'}
		aria-label="Page"
	/>
</main>

<style>
	main {
		max-width: 560px;
		margin: 160px 0 0 48px;
		font: 16px/1.5 sans-serif;
	}
</style>
