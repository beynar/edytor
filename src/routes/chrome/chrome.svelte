<!--
	The demo's chrome: the Notion-style markup of every menu, popup, handle,
	panel and card, as the snippets the plugins take (the package ships the
	controllers and draws none of it). The demo route, the `/test/*` routes
	and the DOM tests pass these (`plugins.ts`); the docs' examples are the
	short versions.
-->
<script module lang="ts">
	import type {
		BlockHandleSnippetPayload,
		BlockMenuController,
		CalloutIconPicker,
		CodeHeader as CodeHeaderController,
		CommentCardPayload,
		CommentsController,
		EquationEditor,
		FindController,
		ImageControls,
		ImageEmptyController,
		LanguageMenu as LanguageMenuController,
		MarqueeBoxPayload,
		MediaEmptyController,
		MentionItem,
		PageLinkItem,
		SlashMenuController,
		SuggestionBarPayload,
		TableAddPayload,
		TableChrome,
		TableGripPayload,
		ToolbarController,
		TriggerMenuController,
		UrlPasteController
	} from '$lib/index.js';
	import { iconOf } from './icons.js';
	import { keepFocus } from './keepFocus.js';
	import BlockHandle from './BlockHandle.svelte';
	import BlockMenu from './BlockMenu.svelte';
	import CalloutIcons from './CalloutIcons.svelte';
	import CodeHeader from './CodeHeader.svelte';
	import CommentCard from './CommentCard.svelte';
	import EquationPanel from './EquationPanel.svelte';
	import FindBar from './FindBar.svelte';
	import ImageEmpty from './ImageEmpty.svelte';
	import ImageToolbar from './ImageToolbar.svelte';
	import LanguageMenu from './LanguageMenu.svelte';
	import LinkCard from './LinkCard.svelte';
	import MediaEmpty from './MediaEmpty.svelte';
	import SlashMenu from './SlashMenu.svelte';
	import SuggestionBar from './SuggestionBar.svelte';
	import Toolbar from './Toolbar.svelte';
	import TriggerMenu from './TriggerMenu.svelte';
	import UrlPasteMenu from './UrlPasteMenu.svelte';

	/** An avatar's URL when it is one an `img` may load (http, https, a data image), else nothing. */
	const avatarOf = (src: unknown) =>
		typeof src === 'string' && /^(https?:|data:image\/)/i.test(src.trim()) ? src : undefined;

	/** A table menu row's icon, by its id. */
	const TABLE_ICONS: Record<string, string> = {
		'insert-above': 'action.up',
		'insert-below': 'action.down',
		'move-up': 'action.up',
		'move-down': 'action.down',
		'insert-left': 'table.left',
		'insert-right': 'table.right',
		'move-left': 'table.left',
		'move-right': 'table.right',
		'delete-row': 'action.delete',
		'delete-column': 'action.delete'
	};

	export {
		slashMenu,
		triggerMenu,
		mentionMenu,
		pageLinkMenu,
		blockMenu,
		toolbar,
		linkCard,
		urlPasteMenu,
		codeHeader,
		languageMenu,
		calloutIcons,
		tableGrip,
		tableMenu,
		tableAdd,
		equationPanel,
		imageToolbar,
		imageEmpty,
		mediaEmpty,
		blockHandle,
		commentCard,
		commentsHeader,
		findBar,
		suggestionBar,
		marqueeBox
	};
</script>

{#snippet slashMenu(controller: SlashMenuController)}
	<SlashMenu {controller} />
{/snippet}

{#snippet triggerMenu(controller: TriggerMenuController<unknown>)}
	<TriggerMenu {controller} />
{/snippet}

{#snippet mentionMenu(controller: TriggerMenuController<MentionItem>)}
	<TriggerMenu {controller}>
		{#snippet row(item: MentionItem, index: number)}
			<button
				type="button"
				class="edytor-mention-row"
				{...controller.option(index)}
				data-testid="trigger-menu-item"
				onmousemove={() => (controller.selectedIndex = index)}
				onclick={() => void controller.pick(item)}
			>
				<span class="avatar" aria-hidden="true">
					{#if avatarOf(item.avatar)}
						<img src={avatarOf(item.avatar)} alt="" />
					{:else}
						{item.label.trim().charAt(0).toUpperCase()}
					{/if}
				</span>
				<span class="name">{item.label}</span>
				{#if item.description}<span class="description">{item.description}</span>{/if}
			</button>
		{/snippet}
	</TriggerMenu>
{/snippet}

{#snippet pageLinkMenu(controller: TriggerMenuController<PageLinkItem>)}
	<TriggerMenu {controller}>
		{#snippet row(item: PageLinkItem, index: number)}
			<button
				type="button"
				class="edytor-page-link-row"
				{...controller.option(index)}
				data-testid="trigger-menu-item"
				onmousemove={() => (controller.selectedIndex = index)}
				onclick={() => void controller.pick(item)}
			>
				<span class="icon" aria-hidden="true">{item.icon ?? '📄'}</span>
				<span class="title">{item.title}</span>
			</button>
		{/snippet}
	</TriggerMenu>
{/snippet}

{#snippet blockMenu(controller: BlockMenuController)}
	<BlockMenu {controller} />
{/snippet}

{#snippet toolbar(controller: ToolbarController)}
	<Toolbar {controller} />
{/snippet}

{#snippet linkCard(controller: ToolbarController)}
	<LinkCard {controller} />
{/snippet}

{#snippet urlPasteMenu(controller: UrlPasteController)}
	<UrlPasteMenu {controller} />
{/snippet}

{#snippet codeHeader(header: CodeHeaderController)}
	<CodeHeader {header} />
{/snippet}

{#snippet languageMenu(menu: LanguageMenuController)}
	<LanguageMenu {menu} />
{/snippet}

{#snippet calloutIcons(picker: CalloutIconPicker)}
	<CalloutIcons {picker} />
{/snippet}

{#snippet tableGrip({ kind, label, grip }: TableGripPayload)}
	<button
		type="button"
		class="table-grip"
		data-edytor-table-grip={kind}
		aria-label={label}
		{@attach grip}
	></button>
{/snippet}

{#snippet tableMenu(chrome: TableChrome)}
	<div class="table-menu" {@attach chrome.popup} {@attach chrome.keys}>
		{#each chrome.items as item (item.item.id)}
			<button
				type="button"
				class="table-menu-row"
				class:danger={item.danger}
				{...item.option}
				disabled={item.disabled}
				data-testid={`table-menu-${item.item.id}`}
				style:--table-menu-icon={iconOf(TABLE_ICONS[item.item.id] ?? '')}
				onmousemove={item.select}
				onclick={item.run}>{item.label}</button
			>
		{/each}
	</div>
{/snippet}

{#snippet tableAdd({ kind, label, add }: TableAddPayload)}
	<button
		type="button"
		class="table-add"
		data-edytor-table-add={kind}
		aria-label={label}
		title={label}
		onmousedown={keepFocus}
		onclick={add}
	></button>
{/snippet}

{#snippet equationPanel(editor: EquationEditor)}
	<EquationPanel {editor} />
{/snippet}

{#snippet imageToolbar(controls: ImageControls)}
	<ImageToolbar {controls} />
{/snippet}

{#snippet imageEmpty(panel: ImageEmptyController)}
	<ImageEmpty {panel} />
{/snippet}

{#snippet mediaEmpty(panel: MediaEmptyController)}
	<MediaEmpty {panel} />
{/snippet}

{#snippet blockHandle(handle: BlockHandleSnippetPayload)}
	<BlockHandle {handle} />
{/snippet}

{#snippet commentCard(card: CommentCardPayload)}
	<CommentCard {card} />
{/snippet}

{#snippet commentsHeader(comments: CommentsController)}
	{#if comments.resolved.length > 0}
		<button
			type="button"
			class="comments-toggle"
			data-edytor-comments-toggle
			aria-pressed={comments.showResolved}
			onclick={() => (comments.showResolved = !comments.showResolved)}
			>{comments.showResolved
				? comments.labels.hideResolved
				: comments.labels.showResolved(comments.resolved.length)}</button
		>
	{/if}
{/snippet}

{#snippet findBar(find: FindController)}
	<FindBar {find} />
{/snippet}

{#snippet suggestionBar(bar: SuggestionBarPayload)}
	<SuggestionBar {bar} />
{/snippet}

{#snippet marqueeBox({ adding }: MarqueeBoxPayload)}
	<div class="marquee" data-edytor-marquee data-adding={adding ? 'true' : undefined}></div>
{/snippet}

<style>
	.edytor-mention-row,
	.edytor-page-link-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.edytor-mention-row {
		min-height: 32px;
		padding: 4px 8px;
	}
	.edytor-mention-row[data-selected='true'],
	.edytor-page-link-row[data-selected='true'] {
		background: rgba(33, 27, 23, 0.06);
	}
	.avatar {
		display: grid;
		flex: none;
		place-items: center;
		width: 20px;
		height: 20px;
		overflow: hidden;
		border-radius: 50%;
		background: rgba(84, 72, 49, 0.12);
		font-size: 11px;
		font-weight: 600;
	}
	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.name,
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.description {
		margin-left: auto;
		overflow: hidden;
		color: #73726e;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* A table's grips, `+` bars and grip menu (Notion's). */
	.table-grip,
	.table-add {
		margin: 0;
		padding: 0;
		border: none;
	}
	.table-grip {
		width: 18px;
		height: 24px;
		border-radius: 4px;
		background: var(--edytor-table-grip-background, #fff);
		box-shadow:
			0 0 0 1px rgba(15, 15, 15, 0.1),
			0 2px 4px rgba(15, 15, 15, 0.1);
		color: rgba(55, 53, 47, 0.45);
		cursor: grab;
	}
	.table-grip[data-dragging='true'] {
		cursor: grabbing;
	}
	.table-grip[data-edytor-table-grip='column'] {
		width: 24px;
		height: 18px;
	}
	.table-grip::before {
		content: '⋮⋮';
		font-size: 10px;
		letter-spacing: -2px;
		line-height: 24px;
	}
	.table-grip[data-edytor-table-grip='column']::before {
		content: '⋯';
		font-size: 14px;
		letter-spacing: 0;
		line-height: 18px;
	}
	.table-add {
		display: block;
		width: 100%;
		height: 16px;
		border-radius: 3px;
		background: rgba(55, 53, 47, 0.04);
		color: rgba(55, 53, 47, 0.45);
		cursor: pointer;
		opacity: 0;
		transition: opacity 80ms ease;
	}
	.table-add[data-edytor-table-add='column'] {
		width: 16px;
		height: 100%;
	}
	.table-add::before {
		content: '+';
		font-size: 14px;
	}
	.table-add:hover,
	.table-add:focus-visible {
		opacity: 1;
		background: rgba(55, 53, 47, 0.08);
	}
	.table-menu {
		min-width: 180px;
		padding: 6px;
		border-radius: 10px;
		background: var(--edytor-menu-background, #fff);
		box-shadow:
			0 0 0 1px rgba(15, 15, 15, 0.05),
			0 3px 6px rgba(15, 15, 15, 0.1),
			0 9px 24px rgba(15, 15, 15, 0.2);
		pointer-events: auto;
	}
	.table-menu-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 4px 8px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: rgb(55, 53, 47);
		font: inherit;
		font-size: 14px;
		text-align: start;
		cursor: pointer;
	}
	.table-menu-row::before {
		content: '';
		flex: none;
		width: 20px;
		height: 20px;
		background: #383836;
		-webkit-mask: var(--table-menu-icon) center / 20px no-repeat;
		mask: var(--table-menu-icon) center / 20px no-repeat;
	}
	/* The menu holds the keys; its keyboard's row shows as hovered. */
	.table-menu:focus {
		outline: none;
	}
	.table-menu-row:hover:not(:disabled),
	.table-menu-row[data-selected='true']:not(:disabled),
	.table-menu-row:focus-visible {
		background: rgba(33, 27, 23, 0.06);
		outline: none;
	}
	.table-menu-row:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.table-menu-row.danger:hover:not(:disabled) {
		color: #cf5148;
	}
	.table-menu-row.danger:hover:not(:disabled)::before {
		background: #cf5148;
	}

	.marquee {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		background: var(--edytor-marquee-background, rgba(35, 131, 226, 0.14));
		border: var(--edytor-marquee-border, 1px solid rgba(35, 131, 226, 0.4));
		border-radius: var(--edytor-marquee-radius, 2px);
	}

	.comments-toggle {
		border: 0;
		border-radius: 6px;
		padding: 2px 8px;
		background: transparent;
		color: rgb(120 119 116);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.comments-toggle:hover {
		background: rgb(55 53 47 / 0.08);
	}
</style>
