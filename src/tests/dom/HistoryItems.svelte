<script lang="ts">
	import HistoryPanel from '$lib/collaboration/history/HistoryPanel.svelte';
	import type { HistoryClient, HistoryVersionItem } from '$lib/index.js';
	import type { EdytorDocument } from '$lib/crdt/document.js';

	/** The version history panel with its rows drawn by an `item` snippet (`history-panel-item.test.ts`). */
	let { client, document }: { client: HistoryClient; document: EdytorDocument } = $props();
</script>

{#snippet item({ version, label, selected, option, run }: HistoryVersionItem)}
	<button
		type="button"
		{...option}
		data-testid="custom-version"
		data-key={version.key}
		data-current={selected}
		onclick={run}>{label} · {version.editors.length}</button
	>
{/snippet}

<HistoryPanel {client} {document} {item} defaultPlugins={false} />
