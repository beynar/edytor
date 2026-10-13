<script lang="ts">
	import type { StarterPropertiesPayload } from '../types.js';
	import { words } from '../chrome/words.svelte.js';
	import { popover } from './popover.js';

	/**
	 * The page's properties under the title: one row per shown property (its
	 * name, its cell, Hide where it may), then Add a property where the
	 * schema has hidden ones.
	 */
	let { shown, addable, hide, show, editable, cell, labelId }: StarterPropertiesPayload = $props();
	let adding = $state(false);
	let addButton = $state<HTMLButtonElement>();
</script>

{#if shown.length || addable.length}
	<div
		class="starter-properties"
		role="group"
		aria-label={words.starter.properties}
		data-edytor-starter-properties
	>
		{#each shown as property (property.id)}
			<div class="starter-property" data-edytor-starter-property={property.id}>
				<div class="starter-property-name" id={labelId(property.id)}>
					{#if property.icon}<span aria-hidden="true">{property.icon}</span>{/if}
					{property.name ?? property.id}
				</div>
				<div class="starter-property-value">{@render cell(property)}</div>
				{#if editable && property.removable !== false}
					<button
						type="button"
						class="starter-property-hide"
						aria-label={words.starter.hideProperty(property.name ?? property.id)}
						data-edytor-starter-hide-property
						onclick={() => hide(property.id)}>×</button
					>
				{/if}
			</div>
		{/each}
		{#if addable.length}
			<div class="starter-property-add">
				<button
					type="button"
					class="starter-button"
					bind:this={addButton}
					aria-haspopup="dialog"
					aria-expanded={adding}
					data-edytor-starter-add-property
					onclick={() => (adding = !adding)}>+ {words.starter.addProperty}</button
				>
				{#if adding}
					<div
						class="starter-popover"
						role="dialog"
						aria-label={words.starter.addProperty}
						{@attach popover(() => {
							adding = false;
							addButton?.focus();
						})}
					>
						<ul class="starter-property-choices">
							{#each addable as property (property.id)}
								<li>
									<button
										type="button"
										onclick={() => {
											show(property.id);
											adding = false;
											addButton?.focus();
										}}
										>{#if property.icon}<span aria-hidden="true">{property.icon}</span>{/if}
										{property.name ?? property.id}</button
									>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.starter-properties {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 4px 0 16px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--notion-border);
		font-size: 14px;
	}
	.starter-property {
		display: grid;
		grid-template-columns: minmax(100px, 160px) minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		border-radius: 4px;
	}
	.starter-property-name {
		display: flex;
		gap: 6px;
		align-items: center;
		overflow: hidden;
		padding: 4px 6px;
		color: var(--notion-text-secondary);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.starter-property-hide {
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--notion-text-secondary);
		font: inherit;
		cursor: pointer;
	}
	.starter-property-hide:hover {
		background: var(--notion-hover);
	}
	.starter-property-hide:focus-visible {
		outline: 2px solid var(--notion-blue);
	}
	@media (hover: hover) {
		.starter-property:not(:hover, :focus-within) .starter-property-hide {
			opacity: 0;
		}
	}
	.starter-property-add {
		position: relative;
		margin-top: 2px;
	}
	.starter-property-add > :global(.starter-button.starter-button) {
		border: 0;
		color: var(--notion-text-secondary);
	}
	.starter-property-choices {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.starter-property-choices button {
		display: flex;
		gap: 6px;
		width: 100%;
		padding: 6px 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}
	.starter-property-choices button:hover,
	.starter-property-choices button:focus-visible {
		background: var(--notion-hover);
		outline: 0;
	}
	@media (max-width: 520px) {
		.starter-property {
			grid-template-columns: minmax(84px, 38%) minmax(0, 1fr) auto;
			gap: 4px;
		}
	}
</style>
