<script lang="ts">
	import type { Snippet } from 'svelte';
	import { parseDate, type DateValue } from '@internationalized/date';
	import XIcon from '@lucide/svelte/icons/x';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { Badge } from '$registry/ui/badge/index.js';
	import { Button } from '$registry/ui/button/index.js';
	import { Calendar } from '$registry/ui/calendar/index.js';
	import { Checkbox } from '$registry/ui/checkbox/index.js';
	import * as Command from '$registry/ui/command/index.js';
	import { Input } from '$registry/ui/input/index.js';
	import * as Popover from '$registry/ui/popover/index.js';
	import * as Select from '$registry/ui/select/index.js';
	import { cn } from '$registry/utils.js';
	import type {
		StarterPerson,
		StarterProperty,
		StarterPropertyCellPayload,
		StarterPropertyOption,
		StarterPropertyValue
	} from '../types.js';
	import { words } from '../../chrome/words.svelte.js';
	import { formatDate, isoDate } from './dates.js';

	/**
	 * One property's value: a field of its type where it is editable (shadcn's
	 * Input, Select, Checkbox, a Combobox for lists and people, a Date Picker),
	 * the value alone where it is readonly. `snippet` (the app's
	 * `propertyCells[type]`) replaces it.
	 */
	let {
		property,
		value,
		set,
		readonly,
		people,
		labelId,
		locale,
		snippet
	}: {
		property: StarterProperty;
		value: StarterPropertyValue | undefined;
		set: (value: StarterPropertyValue | undefined) => void;
		readonly: boolean;
		people: readonly StarterPerson[];
		labelId: string;
		locale: string;
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
	/** A list's choices: a person's id and name, or an option's value and label. */
	const choices = $derived(
		property.type === 'person'
			? people.map((who) => ({ value: who.id, label: who.label, color: undefined }))
			: options.map((option) => ({
					value: option.value,
					label: option.label ?? option.value,
					color: option.color
				}))
	);
	const tint = (color?: string) =>
		color
			? `color: var(--edytor-color-${color}); background: var(--edytor-background-${color})`
			: undefined;

	let picking = $state(false);
	let dating = $state(false);
	const date = $derived(isoDate(text) ? parseDate(text) : undefined);
	const pickDate = (next: DateValue | undefined) => {
		set(next ? next.toString() : undefined);
		dating = false;
	};
	const toggle = (choice: string) =>
		set(list.includes(choice) ? list.filter((other) => other !== choice) : [...list, choice]);
</script>

{#snippet pill(label: string, color: string | undefined, remove?: () => void)}
	<Badge
		variant="secondary"
		class={cn('starter-pill', remove && 'pr-0.5')}
		style={tint(color)}
		data-color={color}
		>{label}{#if remove}<button
				type="button"
				class="hover:bg-foreground/10 rounded-full p-0.5 opacity-60 hover:opacity-100 focus-visible:opacity-100"
				aria-label={words.starter.removeValue(label)}
				onclick={remove}><XIcon class="size-3" /></button
			>{/if}</Badge
	>
{/snippet}

<div
	class="starter-cell"
	data-edytor-starter-cell={property.type}
	data-readonly={readonly ? '' : undefined}
>
	{#if snippet}
		{@render snippet({ property, value, set, readonly, people, labelId, locale })}
	{:else if property.type === 'checkbox'}
		{#if readonly}
			<span role="img" aria-label={value ? words.starter.yes : words.starter.no}
				>{value ? '☑' : '☐'}</span
			>
		{:else}
			<Checkbox
				class="mx-1.5"
				aria-labelledby={labelId}
				checked={value === true}
				onCheckedChange={(checked) => set(checked || undefined)}
			/>
		{/if}
	{:else if property.type === 'select'}
		{#if readonly}
			{#if text}{@render pill(optionOf(text).label ?? text, optionOf(text).color)}{:else}<span
					class="starter-empty">{placeholder}</span
				>{/if}
		{:else}
			<Select.Root
				type="single"
				value={text}
				onValueChange={(next) => set(next || undefined)}
				items={choices}
			>
				<Select.Trigger
					size="sm"
					class="hover:bg-accent h-7 border-0 bg-transparent px-1.5 shadow-none dark:bg-transparent"
					aria-labelledby={labelId}
				>
					{#if text}{@render pill(optionOf(text).label ?? text, optionOf(text).color)}{:else}<span
							class="text-muted-foreground">{placeholder}</span
						>{/if}
				</Select.Trigger>
				<Select.Content portalProps={{ disabled: true }}>
					{#each choices as choice (choice.value)}
						<Select.Item value={choice.value} label={choice.label}
							>{@render pill(choice.label, choice.color)}</Select.Item
						>
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
	{:else if property.type === 'multi-select' || property.type === 'person'}
		<span class="starter-pills" role="list" aria-labelledby={labelId}>
			{#each list as item (item)}
				{@const label =
					property.type === 'person' ? personOf(item).label : (optionOf(item).label ?? item)}
				<span role="listitem">
					{@render pill(
						label,
						property.type === 'person' ? undefined : optionOf(item).color,
						readonly ? undefined : () => set(list.filter((other) => other !== item))
					)}
				</span>
			{/each}
			{#if readonly && !list.length}<span class="starter-empty">{placeholder}</span>{/if}
		</span>
		{#if !readonly && choices.length}
			<Popover.Root bind:open={picking}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="xs"
							class="text-muted-foreground font-normal"
							aria-labelledby={labelId}
							data-edytor-starter-pick>{list.length ? '+' : words.starter.pick}</Button
						>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content
					class="w-60 p-0"
					align="start"
					portalProps={{ disabled: true }}
					data-edytor-starter-choices={property.id}
				>
					<Command.Root>
						<Command.Input placeholder={words.starter.search} />
						<Command.List>
							<Command.Empty>{words.starter.noOptions}</Command.Empty>
							<Command.Group>
								{#each choices as choice (choice.value)}
									<Command.Item
										value={choice.label}
										data-checked={list.includes(choice.value)}
										data-value-id={choice.value}
										onSelect={() => toggle(choice.value)}
										>{@render pill(choice.label, choice.color)}</Command.Item
									>
								{/each}
							</Command.Group>
						</Command.List>
					</Command.Root>
				</Popover.Content>
			</Popover.Root>
		{/if}
	{:else if property.type === 'date'}
		{#if readonly}
			{#if date}<time datetime={text}>{formatDate(text, locale)}</time>{:else}<span
					class="starter-empty">{placeholder}</span
				>{/if}
		{:else}
			<Popover.Root bind:open={dating}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class={cn('h-7 px-1.5 font-normal', !date && 'text-muted-foreground')}
							aria-labelledby={labelId}
							data-edytor-starter-date
						>
							<CalendarIcon />
							{#if date}<time datetime={text}>{formatDate(text, locale)}</time>{:else}{words.starter
									.pickDate}{/if}
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content
					class="w-auto p-0"
					align="start"
					portalProps={{ disabled: true }}
					data-edytor-starter-calendar={property.id}
				>
					<Calendar
						type="single"
						value={date}
						{locale}
						captionLayout="dropdown"
						onValueChange={pickDate}
					/>
					{#if date}
						<div class="border-t p-2">
							<Button
								variant="ghost"
								size="sm"
								class="w-full"
								data-edytor-starter-clear-date
								onclick={() => pickDate(undefined)}>{words.starter.clear}</Button
							>
						</div>
					{/if}
				</Popover.Content>
			</Popover.Root>
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
		<Input
			class="hover:bg-accent h-7 min-w-0 flex-1 border-0 bg-transparent px-1.5 shadow-none dark:bg-transparent"
			type={property.type === 'number' ? 'number' : property.type === 'url' ? 'url' : 'text'}
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
			<Button
				{href}
				target="_blank"
				rel="noopener noreferrer"
				variant="ghost"
				size="icon-xs"
				aria-label={name}><ExternalLinkIcon /></Button
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
		font-size: 14px;
	}
	.starter-pills {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.starter-pills:empty {
		display: none;
	}
	.starter-empty {
		color: var(--muted-foreground);
	}
	.starter-cell a {
		color: inherit;
		text-decoration: underline;
		text-decoration-color: var(--border);
		overflow-wrap: anywhere;
	}
	.starter-cell[data-readonly] {
		padding-inline: 6px;
	}
</style>
