<script lang="ts">
	import { untrack } from 'svelte';
	import { VersionHistory, type HistoryClient } from '$lib/index.js';
	import type { EdytorDocument } from '$lib/crdt/document.js';

	/**
	 * A version list of the app's own markup over `VersionHistory`
	 * (`history-panel-item.test.ts`): each row spreads `history.option(index)`,
	 * the list takes `history.keys`.
	 */
	let { client, document }: { client: HistoryClient; document: EdytorDocument } = $props();
	const uid = $props.id();
	const history = untrack(() => new VersionHistory({ client, document, id: uid }));
</script>

<ul role="listbox" aria-label={history.labels.versions} onkeydown={history.keys}>
	{#each history.versions ?? [] as version, index (version.key)}
		<li role="presentation">
			<button
				type="button"
				{...history.option(index)}
				data-testid="custom-version"
				data-key={version.key}
				data-current={version.key === history.selected}
				onclick={() => void history.select(version.key)}
				>{history.titleOf(version)} · {version.editors.length}</button
			>
		</li>
	{/each}
</ul>
