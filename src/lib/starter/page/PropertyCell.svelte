<script lang="ts">
	import type { Snippet } from 'svelte';
	import type {
		StarterPerson,
		StarterProperty,
		StarterPropertyCellPayload,
		StarterPropertyOption,
		StarterPropertyValue
	} from '../types.js';
	import { words } from '../chrome/words.svelte.js';

	/**
	 * One property's value: a field of its type where it is editable, the
	 * value alone where it is readonly. `snippet` (the app's
	 * `propertyCells[type]`) replaces it.
	 */
	let {
		property,
		value,
		set,
		readonly,
		people,
		labelId,
		snippet
	}: {
		property: StarterProperty;
		value: StarterPropertyValue | undefined;
		set: (value: StarterPropertyValue | undefined) => void;
		readonly: boolean;
		people: readonly StarterPerson[];
		labelId: string;
		snippet?: Snippet<[StarterPropertyCellPayload]>;
	} = $props();

	const options = $derived(property.options ?? []);
	const text = $derived(typeof value === 'string' ? value : value == null ? '' : String(value));
	const list = $derived(
		Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
	);
	const optionOf = (value: string): StarterPropertyOption =>
		options.find((option) => option.value === value) ?? { value };
	const personOf = (id: string): StarterPerson =>
		people.find((person) => person.id === id) ?? { id, label: id };
	const href = $derived(/^https?:\/\//i.test(text) ? text : undefined);
	const placeholder = $derived(property.placeholder ?? words.starter.empty);
	const name = $derived(property.name ?? property.id);
</script>

{#snippet pill(option: StarterPropertyOption, remove?: () => void)}
	<span
		class="starter-pill"
		style:--pill-text={option.color ? `var(--edytor-color-${option.color})` : undefined}
		style:--pill-background={option.color ? `var(--edytor-background-${option.color})` : undefined}
		>{option.label ?? option.value}{#if remove}<button
				type="button"
				aria-label={words.starter.removeValue(option.label ?? option.value)}
				onclick={remove}>×</button
			>{/if}</span
	>
{/snippet}

{#snippet adder(choices: { value: string; label: string }[], add: (value: string) => void)}
	{#if choices.length}
		<select
			class="starter-add-value"
			aria-labelledby={labelId}
			onchange={(event) => {
				const select = event.currentTarget;
				if (select.value) add(select.value);
				select.value = '';
			}}
		>
			<option value="">{list.length ? '+' : words.starter.pick}</option>
			{#each choices as choice (choice.value)}
				<option value={choice.value}>{choice.label}</option>
			{/each}
		</select>
	{/if}
{/snippet}

<div
	class="starter-cell"
	data-edytor-starter-cell={property.type}
	data-readonly={readonly ? '' : undefined}
>
	{#if snippet}
		{@render snippet({ property, value, set, readonly, people, labelId })}
	{:else if property.type === 'checkbox'}
		{#if readonly}
			<span role="img" aria-label={value ? words.starter.yes : words.starter.no}
				>{value ? '☑' : '☐'}</span
			>
		{:else}
			<input
				type="checkbox"
				aria-labelledby={labelId}
				checked={value === true}
				onchange={(event) => set(event.currentTarget.checked || undefined)}
			/>
		{/if}
	{:else if property.type === 'select'}
		{#if readonly}
			{#if text}{@render pill(optionOf(text))}{:else}<span class="starter-empty">{placeholder}</span
				>{/if}
		{:else}
			<select
				class="starter-select"
				aria-labelledby={labelId}
				value={text}
				style:--pill-text={optionOf(text).color
					? `var(--edytor-color-${optionOf(text).color})`
					: undefined}
				style:--pill-background={optionOf(text).color
					? `var(--edytor-background-${optionOf(text).color})`
					: undefined}
				onchange={(event) => set(event.currentTarget.value || undefined)}
			>
				<option value="">{placeholder}</option>
				{#each options as option (option.value)}
					<option value={option.value}>{option.label ?? option.value}</option>
				{/each}
			</select>
		{/if}
	{:else if property.type === 'multi-select' || property.type === 'person'}
		{@const person = property.type === 'person'}
		<span class="starter-pills" role="list" aria-labelledby={labelId}>
			{#each list as item (item)}
				<span role="listitem">
					{#if person}
						{@const who = personOf(item)}
						{@render pill(
							{ value: who.id, label: who.label },
							readonly ? undefined : () => set(list.filter((other) => other !== item))
						)}
					{:else}
						{@render pill(
							optionOf(item),
							readonly ? undefined : () => set(list.filter((other) => other !== item))
						)}
					{/if}
				</span>
			{/each}
			{#if readonly && !list.length}<span class="starter-empty">{placeholder}</span>{/if}
		</span>
		{#if !readonly}
			{@render adder(
				person
					? people
							.filter((who) => !list.includes(who.id))
							.map((who) => ({ value: who.id, label: who.label }))
					: options
							.filter((option) => !list.includes(option.value))
							.map((option) => ({ value: option.value, label: option.label ?? option.value })),
				(added) => set([...list, added])
			)}
		{/if}
	{:else if readonly}
		{#if !text}
			<span class="starter-empty">{placeholder}</span>
		{:else if property.type === 'url' && href}
			<a {href} target="_blank" rel="noopener noreferrer">{text}</a>
		{:else}
			<span>{text}</span>
		{/if}
	{:else}
		<input
			class="starter-field"
			type={property.type === 'number'
				? 'number'
				: property.type === 'date'
					? 'date'
					: property.type === 'url'
						? 'url'
						: 'text'}
			aria-labelledby={labelId}
			value={text}
			{placeholder}
			oninput={(event) => {
				const input = event.currentTarget.value;
				if (property.type === 'number')
					set(input === '' || !Number.isFinite(Number(input)) ? undefined : Number(input));
				else set(input || undefined);
			}}
		/>
		{#if property.type === 'url' && href}
			<a class="starter-open" {href} target="_blank" rel="noopener noreferrer" aria-label={name}
				>↗</a
			>
		{/if}
	{/if}
</div>

<style>
	.starter-cell {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		min-width: 0;
		min-height: 30px;
	}
	.starter-field,
	.starter-select,
	.starter-add-value {
		box-sizing: border-box;
		min-width: 0;
		max-width: 100%;
		padding: 4px 6px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 14px;
	}
	.starter-field {
		flex: 1;
	}
	.starter-field::placeholder {
		color: var(--notion-placeholder);
	}
	.starter-field:hover,
	.starter-add-value:hover {
		background: var(--notion-hover);
	}
	.starter-field:focus-visible,
	.starter-select:focus-visible,
	.starter-add-value:focus-visible,
	.starter-cell input[type='checkbox']:focus-visible {
		outline: 2px solid var(--notion-blue);
	}
	.starter-select {
		background: var(--pill-background, transparent);
		color: var(--pill-text, inherit);
		cursor: pointer;
	}
	.starter-add-value {
		width: auto;
		color: var(--notion-text-secondary);
		cursor: pointer;
	}
	.starter-pills {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.starter-pills:empty {
		display: none;
	}
	.starter-pill {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 0 6px;
		border-radius: 3px;
		background: var(--pill-background, var(--notion-hover));
		color: var(--pill-text, inherit);
		font-size: 14px;
		line-height: 20px;
		white-space: nowrap;
	}
	.starter-pill button {
		padding: 0 2px;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		opacity: 0.6;
		cursor: pointer;
	}
	.starter-pill button:hover,
	.starter-pill button:focus-visible {
		opacity: 1;
	}
	.starter-empty {
		color: var(--notion-placeholder);
		font-size: 14px;
	}
	.starter-cell input[type='checkbox'] {
		width: 16px;
		height: 16px;
		margin: 0 6px;
		accent-color: var(--notion-blue);
	}
	.starter-cell a {
		color: inherit;
		font-size: 14px;
		text-decoration: underline;
		text-decoration-color: var(--notion-border);
		overflow-wrap: anywhere;
	}
	.starter-cell[data-readonly] {
		padding-inline: 6px;
		font-size: 14px;
	}
</style>
