<script module lang="ts">
	/** The cover a user adds before choosing one: a soft gradient, as an SVG. */
	const defaultCover =
		'data:image/svg+xml,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e5f2fc"/><stop offset="1" stop-color="#f3ebf9"/></linearGradient></defs><rect width="1500" height="600" fill="url(#g)"/></svg>'
		);
</script>

<!--
	The starter editor: `<Edytor>` with every useful bundled plugin, the
	ready-made chrome, and the page around the blocks (cover, icon, title,
	properties) stored in the document's data. Each part is a prop: `false`
	leaves it out, a snippet replaces its markup.
-->
<script lang="ts">
	import '../themes/notion.css';
	import { onMount, tick, untrack } from 'svelte';
	import { Edytor } from '../index.js';
	import { starterPlugins } from './starterPlugins.js';
	import { themeStyle } from './theme.js';
	import { words } from './chrome/words.svelte.js';
	import Cover from './page/Cover.svelte';
	import PageIcon from './page/PageIcon.svelte';
	import Title from './page/Title.svelte';
	import Properties from './page/Properties.svelte';
	import PropertyCell from './page/PropertyCell.svelte';
	import IconPicker from './page/IconPicker.svelte';
	import type {
		StarterCoverPayload,
		StarterEditorProps,
		StarterIconPayload,
		StarterPageData,
		StarterPropertiesPayload,
		StarterPropertyValue,
		StarterTitlePayload
	} from './types.js';

	let {
		plugins,
		extraPlugins,
		upload,
		people = [],
		pages,
		cover = true,
		icon = true,
		title = true,
		properties,
		editableProperties = true,
		propertyList,
		propertyCells,
		theme,
		edytor = $bindable(),
		rootClass,
		allowNesting = true,
		readonly = false,
		value,
		snapshot,
		'aria-label': ariaLabel,
		...rest
	}: StarterEditorProps = $props();

	// Read once, as `<Edytor>` reads its plugins.
	const list = untrack(() => starterPlugins({ plugins, extraPlugins, upload, people, pages }));

	/**
	 * The page's data: the seed (`snapshot`, else `value`) until the view is
	 * mounted and its document ready, so the server render and the
	 * hydration draw the same page; then the live, writable `edytor.data`.
	 */
	const seed: StarterPageData = untrack(
		() => (snapshot?.data ?? value?.data ?? {}) as StarterPageData
	);
	let mounted = $state(false);
	onMount(() => (mounted = true));
	const live = $derived(mounted && !!edytor?.synced);
	const data = $derived((live ? edytor!.data : seed) as StarterPageData);
	const editable = $derived(live && !readonly && !edytor!.readonly);
	/** One write of the page's data: the writes of one task are one undo step. */
	const write = (change: (data: StarterPageData) => void) => {
		if (editable && edytor) change(edytor.data as StarterPageData);
	};

	const setCover = (next: StarterPageData['cover']) => {
		write((page) => {
			if (next) page.cover = { url: next.url, position: next.position ?? 50 };
			else delete page.cover;
		});
		void refocus('[data-edytor-starter-change-cover]', '[data-edytor-starter-add-cover]');
	};
	let root = $state<HTMLElement>();
	/** After a part appears or goes, the focus moves to the first of `selectors` shown. */
	const refocus = async (...selectors: string[]) => {
		await tick();
		const active = root?.ownerDocument.activeElement;
		if (active && active !== root?.ownerDocument.body && root?.contains(active)) return;
		for (const selector of selectors) {
			const next = root?.querySelector<HTMLElement>(selector);
			if (next) return next.focus();
		}
	};
	const setIcon = (next: StarterPageData['icon']) => {
		write((page) => {
			if (next) page.icon = next;
			else delete page.icon;
		});
		void refocus('[data-edytor-starter-icon] button', '[data-edytor-starter-add-icon]');
	};
	const setTitle = (next: string) =>
		write((page) => {
			if ((page.title ?? '') !== next) page.title = next;
		});
	const setProperty = (id: string, next: StarterPropertyValue | undefined) =>
		write((page) => {
			const empty =
				next === undefined || next === null || next === '' || (Array.isArray(next) && !next.length);
			if (empty) {
				if (page.properties && id in page.properties) delete page.properties[id];
			} else if (!page.properties) page.properties = { [id]: next };
			else page.properties[id] = next;
		});
	const showProperty = (id: string, shown: boolean) =>
		write((page) => {
			if (!page.shownProperties) page.shownProperties = { [id]: shown };
			else page.shownProperties[id] = shown;
			if (!shown && page.properties && id in page.properties) delete page.properties[id];
		});
	/** The caret at the start of the first block. */
	const enter = () => {
		if (!edytor) return;
		const first = edytor.root?.children[0];
		if (first) edytor.selection.setCaret({ block: first, offset: 0 });
		edytor.focus();
	};

	const coverPayload: StarterCoverPayload = $derived({
		cover: data.cover,
		set: setCover,
		readonly: !editable,
		upload
	});
	const iconPayload: StarterIconPayload = $derived({
		icon: data.icon,
		set: setIcon,
		readonly: !editable,
		upload
	});
	const titlePayload: StarterTitlePayload = $derived({
		title: data.title ?? '',
		set: setTitle,
		enter,
		readonly: !editable
	});
	const schema = $derived(properties ?? []);
	const shownProperties = $derived(
		schema.filter((property) => data.shownProperties?.[property.id] ?? !property.hidden)
	);
	const uid = $props.id();
	const labelId = (id: string) => `${uid}-property-${id}`;
	const propertiesPayload: Omit<StarterPropertiesPayload, 'cell'> = $derived({
		labelId,
		shown: shownProperties,
		addable:
			editable && editableProperties
				? schema.filter((property) => !shownProperties.includes(property))
				: [],
		values: data.properties ?? {},
		set: setProperty,
		show: (id: string) => showProperty(id, true),
		hide: (id: string) => showProperty(id, false),
		readonly: !editable,
		editable: editable && editableProperties,
		people
	});

	let addingIcon = $state(false);
	let iconButton = $state<HTMLButtonElement>();
	const scheme = $derived(theme?.colorScheme ?? 'light');
</script>

<div
	class={['edytor-notion', 'edytor-starter', rootClass]}
	data-edytor-starter
	data-scheme={scheme}
	bind:this={root}
	style={themeStyle(theme)}
>
	{#if typeof cover === 'function'}
		{@render cover(coverPayload)}
	{:else if cover && data.cover?.url}
		<Cover {...coverPayload} />
	{/if}
	<div class="starter-page" data-has-cover={cover && data.cover?.url ? '' : undefined}>
		<div class="starter-header" role="group" aria-label={words.starter.page}>
			{#if typeof icon === 'function'}
				{@render icon(iconPayload)}
			{:else if icon && data.icon}
				<PageIcon {...iconPayload} />
			{/if}
			{#if editable && ((icon === true && !data.icon) || (cover === true && !data.cover?.url))}
				<div class="starter-controls" data-edytor-starter-controls>
					{#if icon === true && !data.icon}
						<button
							type="button"
							bind:this={iconButton}
							aria-haspopup="dialog"
							aria-expanded={addingIcon}
							onclick={() => (addingIcon = !addingIcon)}
							data-edytor-starter-add-icon
						>
							<span aria-hidden="true">☺</span>
							{words.starter.addIcon}
						</button>
					{/if}
					{#if cover === true && !data.cover?.url}
						<button
							type="button"
							data-edytor-starter-add-cover
							onclick={() => setCover({ url: defaultCover, position: 50 })}
						>
							<span aria-hidden="true">▣</span>
							{words.starter.addCover}
						</button>
					{/if}
					{#if addingIcon}
						<IconPicker
							{upload}
							current={undefined}
							onpick={(next) => {
								setIcon(next);
								addingIcon = false;
							}}
							onclose={() => {
								addingIcon = false;
								iconButton?.focus();
							}}
						/>
					{/if}
				</div>
			{/if}
			{#if typeof title === 'function'}
				{@render title(titlePayload)}
			{:else if title}
				<Title
					{...titlePayload}
					undo={() => edytor?.historyUndo()}
					redo={() => edytor?.historyRedo()}
				/>
			{/if}
			{#if properties}
				{#snippet cell(property: (typeof schema)[number])}
					<PropertyCell
						{property}
						value={propertiesPayload.values[property.id]}
						set={(next) => setProperty(property.id, next)}
						readonly={!editable}
						{people}
						labelId={labelId(property.id)}
						snippet={propertyCells?.[property.type]}
					/>
				{/snippet}
				{#if propertyList}
					{@render propertyList({ ...propertiesPayload, cell })}
				{:else}
					<Properties {...propertiesPayload} {cell} />
				{/if}
			{/if}
		</div>
		<Edytor
			{...rest}
			{value}
			{snapshot}
			{readonly}
			{allowNesting}
			plugins={list}
			aria-label={ariaLabel ?? (data.title || words.starter.content)}
			bind:edytor
		/>
	</div>
</div>

<style>
	.edytor-starter {
		--notion-text: var(--edytor-starter-light-text, #2c2c2b);
		--notion-text-secondary: var(--edytor-starter-light-text-secondary, #73726e);
		--notion-placeholder: var(--edytor-starter-light-placeholder, rgba(44, 44, 43, 0.4));
		--notion-border: var(--edytor-starter-light-border, rgba(28, 19, 1, 0.11));
		--notion-hover: var(--edytor-starter-light-hover, rgba(33, 27, 23, 0.05));
		--notion-panel: var(--edytor-starter-light-panel, #f9f8f7);
		--notion-blue: var(--edytor-starter-light-accent, #2783de);
		--notion-text-selection: var(--edytor-starter-light-selection, rgba(35, 131, 226, 0.28));
		--notion-block-selection: var(--edytor-starter-light-block-selection, rgba(35, 131, 226, 0.14));
		--edytor-starter-background: var(--edytor-starter-light-background, #fff);
		position: relative;
		min-width: 0;
		background: var(--edytor-starter-background);
		color: var(--notion-text);
	}
	.edytor-starter[data-scheme='dark'] {
		--notion-text: var(--edytor-starter-dark-text, #d4d4d4);
		--notion-text-secondary: var(--edytor-starter-dark-text-secondary, #9b9b9b);
		--notion-placeholder: var(--edytor-starter-dark-placeholder, rgba(255, 255, 255, 0.3));
		--notion-border: var(--edytor-starter-dark-border, rgba(255, 255, 255, 0.13));
		--notion-hover: var(--edytor-starter-dark-hover, rgba(255, 255, 255, 0.06));
		--notion-panel: var(--edytor-starter-dark-panel, #252525);
		--notion-code-panel: var(--edytor-starter-dark-panel, #252525);
		--notion-blue: var(--edytor-starter-dark-accent, #529cca);
		--notion-text-selection: var(--edytor-starter-dark-selection, rgba(82, 156, 202, 0.4));
		--notion-block-selection: var(--edytor-starter-dark-block-selection, rgba(82, 156, 202, 0.2));
		--edytor-starter-background: var(--edytor-starter-dark-background, #191919);
		color-scheme: dark;
	}
	@media (prefers-color-scheme: dark) {
		.edytor-starter[data-scheme='auto'] {
			--notion-text: var(--edytor-starter-dark-text, #d4d4d4);
			--notion-text-secondary: var(--edytor-starter-dark-text-secondary, #9b9b9b);
			--notion-placeholder: var(--edytor-starter-dark-placeholder, rgba(255, 255, 255, 0.3));
			--notion-border: var(--edytor-starter-dark-border, rgba(255, 255, 255, 0.13));
			--notion-hover: var(--edytor-starter-dark-hover, rgba(255, 255, 255, 0.06));
			--notion-panel: var(--edytor-starter-dark-panel, #252525);
			--notion-code-panel: var(--edytor-starter-dark-panel, #252525);
			--notion-blue: var(--edytor-starter-dark-accent, #529cca);
			--notion-text-selection: var(--edytor-starter-dark-selection, rgba(82, 156, 202, 0.4));
			--notion-block-selection: var(--edytor-starter-dark-block-selection, rgba(82, 156, 202, 0.2));
			--edytor-starter-background: var(--edytor-starter-dark-background, #191919);
			color-scheme: dark;
		}
	}
	/* The page parts' popovers (the cover menu, the icon picker, a property's options). */
	.edytor-starter :global(.starter-popover) {
		position: absolute;
		z-index: 30;
		top: 100%;
		left: 0;
		box-sizing: border-box;
		width: min(320px, calc(100vw - 32px));
		padding: 8px;
		border-radius: var(--edytor-starter-popover-radius, 10px);
		background: var(--edytor-starter-popover-background, var(--edytor-starter-background));
		color: var(--notion-text);
		box-shadow:
			0 14px 28px -6px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06),
			0 0 0 1px var(--notion-border);
		font-size: 14px;
		font-weight: 400;
		text-align: start;
	}
	.edytor-starter :global(.starter-popover-row) {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	.edytor-starter :global(.starter-popover-row:empty) {
		display: none;
	}
	.edytor-starter :global(.starter-link) {
		display: flex;
		gap: 6px;
		margin-top: 8px;
	}
	.edytor-starter :global(.starter-link:first-child) {
		margin-top: 0;
	}
	.edytor-starter :global(.starter-input) {
		flex: 1;
		min-width: 0;
		box-sizing: border-box;
		padding: 4px 8px;
		border: 1px solid var(--notion-border);
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
	}
	.edytor-starter :global(.starter-button) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border: 1px solid var(--notion-border);
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	.edytor-starter :global(.starter-button:hover) {
		background: var(--notion-hover);
	}
	.edytor-starter :global(.starter-button:disabled) {
		opacity: 0.5;
		cursor: default;
	}
	.edytor-starter :global(:is(.starter-button, .starter-input):focus-visible),
	.edytor-starter :global(.starter-button:has(input:focus-visible)) {
		outline: 2px solid var(--notion-blue);
		outline-offset: 1px;
	}
	.edytor-starter :global(.starter-file input) {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
	}
	.edytor-starter :global(.starter-visually-hidden) {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.starter-page {
		box-sizing: border-box;
		width: 100%;
		max-width: calc(
			var(--edytor-starter-max-width, 708px) + 2 * var(--edytor-starter-gutter, 96px)
		);
		margin: 0 auto;
		padding: 0 var(--edytor-starter-gutter, 96px) 30vh;
	}
	.starter-header {
		position: relative;
		padding-top: 80px;
	}
	.starter-page[data-has-cover] .starter-header {
		padding-top: 24px;
	}
	.starter-controls {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		margin: 0 0 4px -6px;
	}
	.starter-controls button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		border: 0;
		border-radius: var(--edytor-starter-radius, 6px);
		background: transparent;
		color: var(--notion-text-secondary);
		font: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	.starter-controls button:hover {
		background: var(--notion-hover);
	}
	.starter-controls button:focus-visible {
		outline: 2px solid var(--notion-blue);
		outline-offset: 1px;
	}
	/* Like Notion, the controls show while the page header is hovered or focused. */
	@media (hover: hover) {
		.starter-controls {
			opacity: 0;
			transition: opacity 120ms;
		}
		.starter-header:hover .starter-controls,
		.starter-controls:focus-within {
			opacity: 1;
		}
	}
	@media (max-width: 720px) {
		.starter-page {
			padding-inline: var(--edytor-starter-gutter-narrow, 16px);
		}
		.starter-header {
			padding-top: 40px;
		}
	}
</style>
