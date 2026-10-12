<script lang="ts">
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { createSlashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
	import { createBlockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
	import { createToolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import { createBlockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
	import { createMentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { createEmbedPlugin } from '$lib/plugins/media/EmbedPlugin.svelte';
	import { createImagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import { createImageToolbarPlugin } from '$lib/plugins/image/toolbar.svelte.js';
	import { createMediaEmptyPlugin } from '$lib/plugins/media/MediaEmpty.svelte';
	import { createSuggestionsPlugin } from '$lib/plugins/suggestions/suggestionsPlugin.js';
	import { createTablePlugin } from '$lib/plugins/table/TablePlugin.svelte';
	import { createCodePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { createEquationPlugin } from '$lib/plugins/equation/EquationPlugin.svelte';
	import type { JSONDoc } from '$lib/utils/json.js';
	import type {
		BlockHandleSnippetPayload,
		BlockMenuController,
		CodeHeader,
		EquationEditor,
		ImageToolbar,
		LanguageMenu,
		MediaEmptyController,
		MentionItem,
		SlashMenuController,
		SuggestionBarPayload,
		TableAddPayload,
		TableChrome,
		TableGripPayload,
		ToolbarController,
		TriggerMenuController,
		UrlPasteController
	} from '$lib/index.js';

	/**
	 * Every chrome surface drawn by its own snippet, each keeping the built-in
	 * keyboard and ARIA through the controllers' attachments (`popup`, `keys`,
	 * `option(index)`, `linkField`, `bar`, `altField`, `field`, a table
	 * grip's `grip`, a code header's `button`) and payloads (a block handle's
	 * `expanded`, `controls`, `labels`). Used by the jsdom contract rows
	 * (`custom-ui.test.ts`) and the browser rows (`/test/custom`,
	 * `custom-chrome.spec.ts`).
	 */
	let { edytor = $bindable(), value }: { edytor?: EdytorContext; value: JSONDoc } = $props();

	const people: MentionItem[] = [
		{ id: 'ada', label: 'Ada Lovelace' },
		{ id: 'alan', label: 'Alan Turing' },
		{ id: 'grace', label: 'Grace Hopper' }
	];
	const plugins = [
		createBlockHandlesPlugin({ handle }),
		createSlashMenuPlugin({ menu: slashMenu }),
		createToolbarPlugin({ toolbar: bar, card: linkCard }),
		createBlockMenuPlugin({ menu: blockMenu }),
		createMentionPlugin({
			items: (query) =>
				people.filter((person) => person.label.toLowerCase().includes(query.toLowerCase())),
			menu: mentionMenu
		}),
		createEmbedPlugin({ menu: pasteMenu }),
		createImagePlugin(),
		createImageToolbarPlugin({ toolbar: imageToolbar }),
		// One snippet for every empty image and media block, by its kind.
		createMediaEmptyPlugin({ empty: anyEmpty }),
		createSuggestionsPlugin({ bar: suggestionBar }),
		createTablePlugin({ grip: tableGrip, menu: tableMenu, add: tableAdd }),
		createCodePlugin({ header: codeHeader, menu: languageMenu }),
		createEquationPlugin({ katex: false, panel: equationPanel })
	];
	const keep = (event: MouseEvent) => event.preventDefault();
</script>

{#snippet handle({
	block,
	label,
	grip,
	add,
	readonly,
	expanded,
	controls
}: BlockHandleSnippetPayload)}
	{#if !readonly}
		<button
			type="button"
			class="custom-handle"
			data-testid="custom-add"
			data-block-id={block.id}
			aria-label={`Add a block below ${label}`}
			aria-expanded={expanded.add ? 'true' : undefined}
			aria-controls={controls.add}
			onmousedown={keep}
			onclick={(event) => add(event.altKey, event.currentTarget)}>+</button
		>
		<button
			type="button"
			class="custom-handle"
			data-testid="custom-grip"
			data-block-id={block.id}
			use:grip
			aria-label={`${label} block`}
			aria-expanded={expanded.grip ? 'true' : undefined}
			aria-controls={controls.grip}>⠿</button
		>
	{/if}
{/snippet}

{#snippet tableGrip(payload: TableGripPayload)}
	<button
		type="button"
		class="custom-table-grip"
		data-testid="custom-table-grip"
		data-kind={payload.kind}
		data-index={payload.index}
		aria-label={payload.kind === 'row' ? 'Row options' : 'Column options'}
		{@attach payload.grip}>{payload.kind === 'row' ? '⋮' : '⋯'}</button
	>
{/snippet}

{#snippet tableMenu(chrome: TableChrome)}
	<div
		class="custom-table-menu"
		data-testid="custom-table-menu"
		aria-label={chrome.menu?.kind === 'column' ? 'Column options' : 'Row options'}
		{@attach chrome.popup}
		{@attach chrome.keys}
	>
		{#each chrome.items as item (item.item.id)}
			<button
				type="button"
				{...item.option}
				data-testid="custom-table-row"
				data-row={item.item.id}
				onmousemove={item.select}
				onclick={item.run}>{item.item.id}</button
			>
		{/each}
	</div>
{/snippet}

{#snippet tableAdd(payload: TableAddPayload)}
	<button
		type="button"
		class="custom-table-add"
		data-testid="custom-table-add"
		data-kind={payload.kind}
		aria-label={payload.kind === 'row' ? 'Add a row' : 'Add a column'}
		onclick={payload.add}>+</button
	>
{/snippet}

{#snippet codeHeader(header: CodeHeader)}
	<div data-testid="custom-code-header">
		{#if header.editable}
			<button
				type="button"
				data-testid="custom-code-language"
				aria-label="Code language: {header.label}"
				{@attach header.button}>{header.label}</button
			>
		{:else}
			<span data-testid="custom-code-language">{header.label}</span>
		{/if}
		<button
			type="button"
			data-testid="custom-code-copy"
			onmousedown={keep}
			onclick={() => void header.copy()}>{header.copied ? 'Copied' : 'Copy'}</button
		>
	</div>
{/snippet}

{#snippet languageMenu(menu: LanguageMenu)}
	<div class="custom-language-menu" data-testid="custom-language-menu">
		<input
			data-testid="custom-language-field"
			aria-label="Code language"
			placeholder="Search"
			value={menu.query}
			oninput={(event) => menu.search(event.currentTarget.value)}
			{@attach menu.keys}
		/>
		<ul aria-label="Code language" {@attach menu.popup}>
			{#each menu.items as item (item.item.id)}
				<li
					{...item.option}
					data-testid="custom-language-row"
					data-language={item.item.id}
					data-current={item.current}
					onmousemove={item.select}
					onclick={item.run}
				>
					{item.item.label}
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

{#snippet equationPanel(editor: EquationEditor)}
	<div
		class="custom-equation-panel"
		data-testid="custom-equation-panel"
		role="dialog"
		aria-label="Equation"
	>
		<input
			data-testid="custom-equation-field"
			aria-label="Equation"
			value={editor.expression}
			oninput={(event) => editor.set(event.currentTarget.value)}
			{@attach editor.field}
		/>
		<button type="button" onmousedown={keep} onclick={() => editor.close()}>Done</button>
	</div>
{/snippet}

{#snippet slashMenu(menu: SlashMenuController)}
	<div class="custom-slash" data-testid="custom-slash-menu">
		{#if menu.addition}
			<input
				data-testid="custom-slash-field"
				aria-label="Filter block commands"
				role="combobox"
				aria-expanded="true"
				aria-controls={menu.listId}
				value={menu.query}
				oninput={(event) => menu.search(event.currentTarget.value)}
				{@attach menu.keys}
			/>
		{/if}
		<ul aria-label="Block commands" {@attach menu.popup}>
			{#each menu.commands as command, index (command.id)}
				<li
					{...menu.option(index)}
					data-testid="custom-slash-row"
					onmousemove={() => (menu.index = index)}
					onclick={() => void menu.run(command)}
				>
					{command.label}
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

{#snippet blockMenu(menu: BlockMenuController)}
	<div class="custom-block-menu" data-testid="custom-block-menu" data-edytor-block-menu>
		<input
			data-testid="custom-block-menu-field"
			aria-label="Search actions"
			value={menu.query}
			oninput={(event) => menu.search(event.currentTarget.value)}
			{@attach menu.keys}
		/>
		<div {@attach menu.popup}>
			{#each menu.rows as row, index (`${'field' in row ? 'color' : 'value' in row ? 'kind' : 'action'}:${row.id}`)}
				<button
					type="button"
					{...menu.option(index)}
					data-testid="custom-block-menu-row"
					onclick={() => {
						menu.index = index;
						menu.run(row);
					}}>{row.label}</button
				>
			{/each}
		</div>
		{#if menu.flyout}
			<div data-testid="custom-block-menu-flyout" {@attach menu.flyoutMenu}>
				{#each menu.flyoutRows as row, index (row.id)}
					<button
						type="button"
						{...menu.option(index, true)}
						onclick={() => {
							menu.flyoutIndex = index;
							menu.run(row);
						}}>{row.label}</button
					>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet bar(toolbar: ToolbarController)}
	<div>
		<div data-testid="custom-toolbar" {@attach toolbar.popup} {@attach toolbar.keys}>
			{#each toolbar.marks as mark (mark.mark)}
				<button
					type="button"
					data-testid={`custom-toolbar-${mark.mark}`}
					aria-label={mark.label}
					aria-pressed={toolbar.isActive(mark.mark)}
					onclick={() => toolbar.toggleMark(mark.mark)}>{mark.icon}</button
				>
			{/each}
			<button
				type="button"
				data-testid="custom-toolbar-link"
				onclick={() => toolbar.togglePanel('link')}>Link</button
			>
		</div>
		{#if toolbar.panel === 'link'}
			<label for={toolbar.linkFieldId}>Link URL</label>
			<input
				data-testid="custom-toolbar-link-field"
				value={toolbar.linkUrl}
				oninput={(event) => toolbar.setLinkUrl(event.currentTarget.value)}
				{@attach toolbar.linkField}
			/>
		{/if}
	</div>
{/snippet}

{#snippet linkCard(toolbar: ToolbarController)}
	<div data-testid="custom-link-card" role="toolbar" aria-label="Link">
		<span>{toolbar.hoveredHref}</span>
		<button type="button" onclick={() => toolbar.removeHovered()}>Remove</button>
	</div>
{/snippet}

{#snippet mentionMenu(menu: TriggerMenuController<MentionItem>)}
	<ul data-testid="custom-mention-menu" {@attach menu.popup}>
		{#each menu.items as person, index (person.id)}
			<li {...menu.option(index)} onclick={() => void menu.pick(person)}>{person.label}</li>
		{/each}
	</ul>
{/snippet}

{#snippet pasteMenu(menu: UrlPasteController)}
	<ul data-testid="custom-paste-menu" {@attach menu.popup}>
		{#each menu.open?.options ?? [] as option, index (option.id)}
			<li {...menu.option(index)} data-option={option.id} onclick={() => menu.pick(option)}>
				{option.id}
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet imageToolbar(controls: ImageToolbar)}
	<div data-testid="custom-image-toolbar" {@attach controls.bar}>
		<button type="button" data-testid="custom-image-left" onclick={() => controls.align('left')}
			>Align left</button
		>
		<button type="button" data-testid="custom-image-alt" onclick={controls.toggleAlt}
			>Alt text</button
		>
		{#if controls.editing === controls.box?.id}
			<input
				data-testid="custom-image-alt-field"
				value={controls.alt}
				oninput={(event) => controls.setAlt(event.currentTarget.value)}
				{@attach controls.altField}
			/>
		{/if}
	</div>
{/snippet}

{#snippet anyEmpty(empty: MediaEmptyController)}
	{#if empty.kind === 'image'}{@render imageEmpty(empty)}{:else}{@render mediaEmpty(empty)}{/if}
{/snippet}

{#snippet imageEmpty(empty: MediaEmptyController)}
	<div data-testid="custom-image-empty" data-readonly={empty.readonly}>
		{#if !empty.readonly}
			<input
				data-testid="custom-image-empty-field"
				aria-label="Image link"
				bind:value={empty.draft}
				{@attach empty.field}
			/>
			{#if empty.failed}<small data-testid="custom-image-empty-error">{empty.failed}</small>{/if}
		{/if}
	</div>
{/snippet}

{#snippet mediaEmpty(empty: MediaEmptyController)}
	<div data-testid="custom-media-empty" data-kind={empty.kind}>
		<input
			data-testid="custom-media-empty-field"
			aria-label="Paste the link…"
			bind:value={empty.draft}
			{@attach empty.field}
		/>
		{#if empty.failed}<small data-testid="custom-media-empty-error">{empty.failed}</small>{/if}
	</div>
{/snippet}

{#snippet suggestionBar({ suggestion, accept }: SuggestionBarPayload)}
	<div data-testid="custom-suggestion-bar">
		<span>{suggestion.label ?? 'Suggestion'}</span>
		<button type="button" data-testid="custom-suggestion-accept" onclick={accept}>Accept</button>
	</div>
{/snippet}

<Edytor bind:edytor {plugins} {value} aria-label="Custom chrome" />

<style>
	.custom-handle {
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		background: transparent;
		color: #73726e;
		cursor: pointer;
	}
	.custom-table-grip {
		width: 22px;
		height: 22px;
		padding: 0;
		border: 1px solid #73726e;
		border-radius: 4px;
		background: #fff;
		color: #2c2c2b;
		cursor: grab;
	}
	.custom-table-add {
		width: 100%;
		height: 100%;
		min-width: 14px;
		min-height: 14px;
		padding: 0;
		border: 0;
		background: #f1f1ef;
		color: #2c2c2b;
	}
	.custom-table-menu,
	.custom-language-menu,
	.custom-equation-panel {
		padding: 4px;
		background: #fff;
		color: #2c2c2b;
		box-shadow: 0 0 0 1px #d3d1cb;
	}
	.custom-table-menu [data-selected='true'],
	.custom-language-menu [data-selected='true'] {
		background: #e3e2e0;
	}
</style>
