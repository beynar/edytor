<script lang="ts">
	import Edytor from '$lib/components/Edytor.svelte';
	import { browser } from '$app/environment';
</script>

{#if browser}
	<Edytor>
		{#snippet renderMarks({mark}, children:any)}
			{#if mark?.bold}
				<b>
					{@render children()}
				</b>
			{:else if mark?.italic}
				<i>
					{@render children()}
				</i>
			{:else if mark?.highlight}
				<mark>
					{@render children()}
				</mark>
			{:else}
				{@render children()}
			{/if}
		{/snippet}

		{#snippet renderBlocks({ block, node }, content, children)}
			{#if block.type === 'paragraph'}
				<div use:node>
					<p>
						{@render content()}
					</p>
					<div style:padding-left="20px">
						{@render children()}
					</div>
				</div>
			{:else if block.type === 'blockquote'}
				<div use:node>
					<blockquote>
						{@render content()}
					</blockquote>
					{@render children()}
				</div>
			{:else}
				<div use:node>
					{@render content()}
					{@render children()}
				</div>
			{/if}
		{/snippet}
	</Edytor>
{/if}
