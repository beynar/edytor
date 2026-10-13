<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$registry/ui/button/index.js';
	import * as Collapsible from '$registry/ui/collapsible/index.js';
	import * as Command from '$registry/ui/command/index.js';
	import * as Popover from '$registry/ui/popover/index.js';
	import type { StarterPropertiesPayload, StarterProperty } from '../types.js';
	import { words } from '../../chrome/words.svelte.js';

	/**
	 * The page's properties under the title: one row per shown property (its
	 * name, its cell, Hide where it may), then the hidden ones under a
	 * collapsible ("2 hidden properties"), their values kept and shown, each
	 * with Show; then Add a property, a searchable list of the hidden ones.
	 */
	let { shown, hidden, addable, hide, show, editable, cell, labelId }: StarterPropertiesPayload =
		$props();
	let adding = $state(false);
	let open = $state(false);
</script>

{#snippet row(property: StarterProperty, visible: boolean)}
	<div
		class="starter-property"
		data-edytor-starter-property={property.id}
		data-hidden={visible ? undefined : ''}
	>
		<div class="starter-property-name" id={labelId(property.id)}>
			{#if property.icon}<span aria-hidden="true">{property.icon}</span>{/if}
			{property.name ?? property.id}
		</div>
		<div class="starter-property-value">{@render cell(property)}</div>
		{#if editable && visible && property.removable !== false}
			<Button
				variant="ghost"
				size="icon-xs"
				class="starter-property-hide text-muted-foreground"
				aria-label={words.starter.hideProperty(property.name ?? property.id)}
				data-edytor-starter-hide-property
				onclick={() => hide(property.id)}><EyeOffIcon /></Button
			>
		{:else if editable && !visible}
			<Button
				variant="ghost"
				size="icon-xs"
				class="text-muted-foreground"
				aria-label={words.starter.showProperty(property.name ?? property.id)}
				data-edytor-starter-show-property
				onclick={() => show(property.id)}><EyeIcon /></Button
			>
		{/if}
	</div>
{/snippet}

{#if shown.length || addable.length || hidden.length}
	<div
		class="starter-properties"
		role="group"
		aria-label={words.starter.properties}
		data-edytor-starter-properties
	>
		{#each shown as property (property.id)}
			{@render row(property, true)}
		{/each}
		{#if hidden.length}
			<Collapsible.Root bind:open data-edytor-starter-hidden-properties>
				<Collapsible.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="text-muted-foreground -ml-1 h-7 px-1.5 font-normal"
							data-edytor-starter-hidden-toggle
						>
							<ChevronRightIcon
								class={open ? 'rotate-90 transition-transform' : 'transition-transform'}
							/>
							{words.starter.hiddenProperties(hidden.length)}
						</Button>
					{/snippet}
				</Collapsible.Trigger>
				<Collapsible.Content class="flex flex-col gap-0.5">
					{#each hidden as property (property.id)}
						{@render row(property, false)}
					{/each}
				</Collapsible.Content>
			</Collapsible.Root>
		{/if}
		{#if addable.length}
			<Popover.Root bind:open={adding}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="text-muted-foreground -ml-1 h-7 w-fit px-1.5 font-normal"
							data-edytor-starter-add-property
						>
							<PlusIcon />
							{words.starter.addProperty}
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content
					class="w-60 p-0"
					align="start"
					portalProps={{ disabled: true }}
					aria-label={words.starter.addProperty}
					data-edytor-starter-add-menu
				>
					<Command.Root>
						<Command.Input placeholder={words.starter.search} />
						<Command.List>
							<Command.Empty>{words.starter.noOptions}</Command.Empty>
							<Command.Group>
								{#each addable as property (property.id)}
									<Command.Item
										value={property.name ?? property.id}
										data-property-id={property.id}
										onSelect={() => {
											show(property.id);
											adding = false;
										}}
									>
										{#if property.icon}<span aria-hidden="true">{property.icon}</span>{/if}
										{property.name ?? property.id}
									</Command.Item>
								{/each}
							</Command.Group>
						</Command.List>
					</Command.Root>
				</Popover.Content>
			</Popover.Root>
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
		border-bottom: 1px solid var(--border);
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
		color: var(--muted-foreground);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (hover: hover) {
		.starter-property:not(:hover, :focus-within) :global(.starter-property-hide) {
			opacity: 0;
		}
	}
	@media (max-width: 520px) {
		.starter-property {
			grid-template-columns: minmax(84px, 38%) minmax(0, 1fr) auto;
			gap: 4px;
		}
	}
</style>
