<script lang="ts">
	// `/test/large` — the P8 large-page harness (see `+page.ts`). Timings
	// land on `window.__large`: `mounted` (the view's onMount) and `painted`
	// (two frames after it), both `performance.now()` values; `created` is
	// when the document was seeded and its index folded.
	import { onMount, tick, untrack } from 'svelte';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
	import { createDocument, type EdytorDocument } from '$lib/crdt/index.js';
	import { applyAwarenessUpdate, encodeAwarenessUpdate } from '$lib/crdt/protocol.js';
	import type { JSONBlock, JSONDoc } from '$lib/utils/json.js';
	import { Y } from '$lib/crdt/engine.js';
	import '$lib/themes/notion.css';

	let { data } = $props();
	// Read once: the page is built for one load.
	const { blocks, cv, peer: withPeer } = untrack(() => data);

	const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
	const blockAt = (i: number): JSONBlock => {
		const text = `Block ${i} ${words.slice(0, 20 + ((i * 7) % 50))}`;
		if (i % 25 === 0)
			return { id: `b${i}`, type: 'heading', data: { level: 'h2' }, content: [{ text }] };
		if (i % 10 === 3) return { id: `b${i}`, type: 'bulleted-list-item', content: [{ text }] };
		if (i % 10 === 7)
			return {
				id: `b${i}`,
				type: 'paragraph',
				content: [{ text: `${text} ` }, { text: 'bold part', marks: { bold: true } }]
			};
		return { id: `b${i}`, type: 'paragraph', content: [{ text }] };
	};
	const value: JSONDoc = {
		children: Array.from({ length: blocks }, (_, i) => blockAt(i))
	};
	const plugins = [codePlugin, columnsPlugin, richTextPlugin];

	const start = performance.now();
	const main = createDocument({ value, actor: { id: 'ada', name: 'Ada', color: '#2783de' } });
	// The document seeded and its index folded (one commit): what a lazy index could save.
	const created = performance.now();
	const peer: EdytorDocument | undefined = withPeer
		? createDocument({ value, actor: { id: 'bob', name: 'Bob', color: '#d44c47' } })
		: undefined;
	if (peer) {
		const [a, b] = [main, peer];
		const REMOTE = Symbol('bridge');
		a.doc.on('update', (u: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) Y.applyUpdate(b.doc as never, u, REMOTE);
		});
		b.doc.on('update', (u: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) Y.applyUpdate(a.doc as never, u, REMOTE);
		});
		for (const [from, to] of [
			[a, b],
			[b, a]
		] as const)
			from.awareness.on('update', ({ added, updated, removed }, origin) => {
				if (origin === REMOTE) return;
				const changed = [...added, ...updated, ...removed];
				applyAwarenessUpdate(to.awareness, encodeAwarenessUpdate(from.awareness, changed), REMOTE);
			});
	}

	let edytor = $state<EdytorContext>();
	let peerView = $state<EdytorContext>();

	onMount(async () => {
		await tick();
		const mounted = performance.now();
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				Object.assign(window, {
					__large: { start, created, mounted, painted: performance.now(), blocks },
					__edytor: edytor,
					__peer: peerView
				});
			})
		);
	});
</script>

<main
	class="edytor-notion"
	class:edytor-long-page={cv}
	style="max-width: 720px; margin: 0 auto; padding: 48px 96px;"
>
	<Edytor bind:edytor document={main} {plugins} blockHandles />
	{#if peer}
		<div data-large-peer style="display: none">
			<Edytor bind:edytor={peerView} document={peer} {plugins} />
		</div>
	{/if}
</main>
