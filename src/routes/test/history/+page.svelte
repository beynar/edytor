<!--
	The version history panel against a stubbed client (Playwright:
	`tests/editor-dom/history-panel.spec.ts`). A live editor on the left,
	the panel on the right; `window.__HISTORY__` records the client's calls.

	Query: `readonly=true` (no Restore), `deny=true` (restore and undo answer
	403), `client=http` (the default `createHistoryClient` over
	`/test-history-api/doc`, which the spec routes).
-->
<script lang="ts">
	import { page } from '$app/state';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { createDocument } from '$lib/crdt/index.js';
	import HistoryPanel from '$lib/collaboration/history/HistoryPanel.svelte';
	import {
		createHistoryClient,
		HistoryRequestError,
		type HistoryClient,
		type HistoryVersion
	} from '$lib/collaboration/history/client.js';
	import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';

	const p = (id: string, text: string, children?: JSONBlock[]): JSONBlock => ({
		type: 'paragraph',
		id,
		content: [{ text }],
		...(children ? { children } : {})
	});

	/** The live page: `a` as then, `b` rewritten, `n` added, `r` removed. */
	const live: JSONDoc = {
		children: [p('a', 'Intro'), p('b', 'New text'), p('n', 'Added paragraph'), p('z', 'Tail')]
	};
	const versions: HistoryVersion[] = [
		{
			key: 'history/doc/2026-10-06-pm',
			date: '2026-10-06',
			slot: 'pm',
			bytes: 300,
			blocks: 4,
			editors: ['ada', 'bob'],
			more: 2,
			at: Date.UTC(2026, 9, 6, 22),
			expiresAt: null
		},
		{
			key: 'history/doc/2026-10-06-am',
			date: '2026-10-06',
			slot: 'am',
			bytes: 280,
			blocks: 4,
			editors: [],
			more: 0,
			at: Date.UTC(2026, 9, 6, 10),
			expiresAt: null
		}
	];
	const stored: Record<string, JSONDoc> = {
		'history/doc/2026-10-06-pm': {
			children: [p('a', 'Intro'), p('b', 'Old text'), p('r', 'Removed paragraph'), p('z', 'Tail')]
		},
		'history/doc/2026-10-06-am': structuredClone(live)
	};

	const document = createDocument({ value: live });
	const calls: string[] = [];
	const deny = page.url.searchParams.get('deny') === 'true';
	const refuse = () => {
		throw new HistoryRequestError(403, 'history of doc: 403 read-only');
	};
	const stub: HistoryClient = {
		list: async () => {
			calls.push('list');
			return structuredClone(versions);
		},
		read: async (key) => {
			calls.push(`read ${key}`);
			return key in stored ? structuredClone(stored[key]!) : null;
		},
		restore: async (key) => {
			calls.push(`restore ${key}`);
			if (deny) refuse();
			return { status: 'applied', key, rewritten: 1, revived: 1, deleted: 1 };
		},
		undo: async () => {
			calls.push('undo');
			if (deny) refuse();
			return { status: 'applied' };
		}
	};
	const client =
		page.url.searchParams.get('client') === 'http'
			? createHistoryClient({
					server: `${page.url.origin}/test-history-api`,
					room: 'doc',
					params: { token: 'secret' }
				})
			: stub;
	let edytor = $state<EdytorContext>();
	const hooks = window as unknown as { __HISTORY__: unknown; __EDYTOR__: unknown };
	hooks.__HISTORY__ = { calls, document };
	// The live view, for the truth check every row ends with.
	$effect(() => void (hooks.__EDYTOR__ = edytor));
</script>

<main>
	<div data-testid="live">
		<Edytor {document} bind:edytor aria-label="Live page" />
	</div>
	<div data-testid="panel">
		<HistoryPanel
			{client}
			{document}
			readonly={page.url.searchParams.get('readonly') === 'true'}
			locale="en-US"
		/>
	</div>
</main>

<style>
	main {
		display: grid;
		grid-template-columns: 1fr 2fr;
		gap: 16px;
		height: 100vh;
		padding: 16px;
		box-sizing: border-box;
	}
	[data-testid='panel'] {
		min-height: 0;
		border: 1px solid #ddd;
	}
</style>
