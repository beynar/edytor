<!--
	The demo's chrome: the Notion-style markup of every menu, popup, handle,
	panel and card, as the snippets the plugins take (the package ships the
	controllers and draws none of it). The demo route, the `/test/*` routes
	and the DOM tests pass these (`plugins.ts`); the docs' examples are the
	short versions. Each snippet renders a component of this folder, which
	holds its markup and its styles (a module's own snippets carry no styles).
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
		TableChrome as TableChromeController,
		TableGripPayload,
		ToolbarController,
		TriggerMenuController,
		UrlPasteController
	} from '$lib/index.js';
	import BlockHandle from './BlockHandle.svelte';
	import BlockMenu from './BlockMenu.svelte';
	import CalloutIcons from './CalloutIcons.svelte';
	import CodeHeader from './CodeHeader.svelte';
	import CommentCard from './CommentCard.svelte';
	import CommentsHeader from './CommentsHeader.svelte';
	import EquationPanel from './EquationPanel.svelte';
	import FindBar from './FindBar.svelte';
	import ImageEmpty from './ImageEmpty.svelte';
	import ImageToolbar from './ImageToolbar.svelte';
	import LanguageMenu from './LanguageMenu.svelte';
	import LinkCard from './LinkCard.svelte';
	import MarqueeBox from './MarqueeBox.svelte';
	import MediaEmpty from './MediaEmpty.svelte';
	import MentionMenu from './MentionMenu.svelte';
	import PageLinkMenu from './PageLinkMenu.svelte';
	import SlashMenu from './SlashMenu.svelte';
	import SuggestionBar from './SuggestionBar.svelte';
	import TableChrome from './TableChrome.svelte';
	import Toolbar from './Toolbar.svelte';
	import TriggerMenu from './TriggerMenu.svelte';
	import UrlPasteMenu from './UrlPasteMenu.svelte';

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
	<MentionMenu {controller} />
{/snippet}

{#snippet pageLinkMenu(controller: TriggerMenuController<PageLinkItem>)}
	<PageLinkMenu {controller} />
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

{#snippet tableGrip(grip: TableGripPayload)}
	<TableChrome {grip} />
{/snippet}

{#snippet tableMenu(menu: TableChromeController)}
	<TableChrome {menu} />
{/snippet}

{#snippet tableAdd(add: TableAddPayload)}
	<TableChrome {add} />
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
	<CommentsHeader {comments} />
{/snippet}

{#snippet findBar(find: FindController)}
	<FindBar {find} />
{/snippet}

{#snippet suggestionBar(bar: SuggestionBarPayload)}
	<SuggestionBar {bar} />
{/snippet}

{#snippet marqueeBox(box: MarqueeBoxPayload)}
	<MarqueeBox {box} />
{/snippet}
