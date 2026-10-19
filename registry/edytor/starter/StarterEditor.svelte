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
	import 'edytor/themes/notion.css';
	// The theme's variables on your shadcn tokens: the blocks follow `.dark` with the menus.
	import '../chrome/tokens.css';
	import { onMount, tick, untrack } from 'svelte';
	import { Edytor } from 'edytor';
	import { starterPlugins } from './starterPlugins.js';
	import ImageIcon from '@lucide/svelte/icons/image';
	import SmileIcon from '@lucide/svelte/icons/smile';
	import PencilIcon from '@lucide/svelte/icons/pencil-line';
	import { Button } from '$registry/ui/button/index.js';
	import { words } from '../chrome/words.svelte.js';
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
		comments,
		user,
		locale = 'en-US',
		edytor = $bindable(),
		rootClass,
		review = true,
		allowNesting = true,
		readonly = false,
		value,
		snapshot,
		'aria-label': ariaLabel,
		...rest
	}: StarterEditorProps = $props();

	// Read once, as `<Edytor>` reads its plugins.
	const list = untrack(() =>
		starterPlugins({ plugins, extraPlugins, upload, people, pages, comments, user })
	);

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
			// Hiding keeps the value: the hidden properties show it, and Show brings it back.
			if (!page.shownProperties) page.shownProperties = { [id]: shown };
			else page.shownProperties[id] = shown;
		});
	/** The caret at the start of the first block. */
	const enter = () => {
		if (!edytor) return;
		const first = edytor.root?.children[0];
		if (first) edytor.selection.setCaret({ block: first, offset: 0 });
		edytor.focus();
	};

	// Review: suggesting mode, and the pending shared suggestions a writer decides.
	const suggestOnly = $derived(live && edytor!.document.access === 'suggest');
	const suggesting = $derived(live && (suggestOnly || edytor!.suggestions.suggesting));
	const pending = $derived(live && edytor!.suggestions.list.some((s) => s.shared && s.canDecide));
	$effect(() => {
		if (suggestOnly && edytor && !edytor.suggestions.suggesting)
			edytor.suggestions.suggesting = true;
	});

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
	const hiddenProperties = $derived(
		schema.filter((property) => !shownProperties.includes(property))
	);
	const propertiesPayload: Omit<StarterPropertiesPayload, 'cell'> = $derived({
		labelId,
		shown: shownProperties,
		hidden: hiddenProperties,
		addable: editable && editableProperties ? hiddenProperties : [],
		values: data.properties ?? {},
		set: setProperty,
		show: (id: string) => showProperty(id, true),
		hide: (id: string) => showProperty(id, false),
		readonly: !editable,
		editable: editable && editableProperties,
		people
	});
</script>

<div class={['edytor-notion', 'edytor-starter', rootClass]} data-edytor-starter bind:this={root}>
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
						<IconPicker {upload} current={undefined} onpick={setIcon}>
							{#snippet trigger(props)}
								<Button
									{...props}
									variant="ghost"
									size="sm"
									class="text-muted-foreground font-normal"
									data-edytor-starter-add-icon
								>
									<SmileIcon />
									{words.starter.addIcon}
								</Button>
							{/snippet}
						</IconPicker>
					{/if}
					{#if cover === true && !data.cover?.url}
						<Button
							variant="ghost"
							size="sm"
							class="text-muted-foreground font-normal"
							data-edytor-starter-add-cover
							onclick={() => setCover({ url: defaultCover, position: 50 })}
						>
							<ImageIcon />
							{words.starter.addCover}
						</Button>
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
						{locale}
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
		{#if review && editable}
			<div class="starter-review" role="toolbar" aria-label={words.suggestions.suggestion}>
				<Button
					variant={suggesting ? 'secondary' : 'ghost'}
					size="sm"
					aria-pressed={suggesting}
					disabled={suggestOnly}
					data-edytor-starter-suggesting
					onmousedown={(event) => event.preventDefault()}
					onclick={() => (edytor!.suggestions.suggesting = !suggesting)}
				>
					<PencilIcon />
					{suggesting ? words.suggestions.suggesting : words.suggestions.editing}
				</Button>
				{#if pending}
					<Button
						variant="ghost"
						size="sm"
						data-edytor-starter-accept-all
						onmousedown={(event) => event.preventDefault()}
						onclick={() => edytor!.suggestions.acceptAll()}>{words.suggestions.acceptAll}</Button
					>
					<Button
						variant="ghost"
						size="sm"
						data-edytor-starter-reject-all
						onmousedown={(event) => event.preventDefault()}
						onclick={() => edytor!.suggestions.rejectAll()}>{words.suggestions.rejectAll}</Button
					>
				{/if}
			</div>
		{/if}
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
		position: relative;
		min-width: 0;
		background: var(--background);
		color: var(--foreground);
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
	.starter-review {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		justify-content: flex-end;
		gap: 2px;
		margin: 0 0 4px;
	}
	.starter-controls {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		margin: 0 0 4px -6px;
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
