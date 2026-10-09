/**
 * Every chrome snippet is typed by an exported payload (the `test:typecheck`
 * and `test:dom:typecheck` lanes compile this file; the unit lane runs it):
 * `Snippet<[Payload]>` with one object argument, a whole surface's payload
 * its controller, a row's the shape every menu shares (`MenuItemPayload`).
 * A snippet typed against its payload compiles; a wrong field, or another
 * surface's payload, does not (`@ts-expect-error`). Expected types come from
 * the pattern the site's `customization/menus` page states.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { Snippet } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type {
	BlockHandleSnippetPayload,
	BlockHandlesLabels,
	BlockMenuController,
	BlockMenuOptions,
	CodeHeader,
	CodeLabels,
	CodePluginOptions,
	EquationEditor,
	EquationLabels,
	EquationPluginOptions,
	LanguageMenu,
	LanguageMenuItem,
	LanguageRow,
	TableAddPayload,
	TableChrome,
	TableGripPayload,
	TableLabels,
	TableMenuItem,
	TableMenuRow,
	TablePluginOptions,
	BookmarkPluginOptions,
	CommentCardPayload,
	CommentsPluginOptions,
	EditorCommand,
	EmbedPluginOptions,
	HistoryPanelProps,
	HistoryVersion,
	HistoryVersionItem,
	ImageControls,
	ImageEmptyController,
	ImagePluginOptions,
	MediaEmptyController,
	MediaPluginOptions,
	MentionItem,
	MentionPluginOptions,
	MenuItemPayload,
	OptionAttributes,
	PageLinkItem,
	PageLinkPluginOptions,
	SlashMenuController,
	SlashMenuItem,
	SlashMenuOptions,
	SuggestionBarPayload,
	SuggestionsOptions,
	ToolbarController,
	ToolbarOptions,
	Trigger,
	TriggerItemPayload,
	TriggerMenuController,
	UrlPasteController
} from '$lib/index.js';

/** The one argument a snippet option takes. */
type Payload<S> = NonNullable<S> extends Snippet<[infer A]> ? A : never;

describe('each chrome snippet takes its exported payload', () => {
	it('a whole surface receives its controller', () => {
		expectTypeOf<Payload<BlockMenuOptions['menu']>>().toEqualTypeOf<BlockMenuController>();
		expectTypeOf<Payload<SlashMenuOptions['menu']>>().toEqualTypeOf<SlashMenuController>();
		expectTypeOf<Payload<ToolbarOptions['toolbar']>>().toEqualTypeOf<ToolbarController>();
		expectTypeOf<Payload<ToolbarOptions['card']>>().toEqualTypeOf<ToolbarController>();
		expectTypeOf<Payload<Trigger<MentionItem>['menu']>>().toEqualTypeOf<
			TriggerMenuController<MentionItem>
		>();
		expectTypeOf<Payload<MentionPluginOptions['menu']>>().toEqualTypeOf<
			TriggerMenuController<MentionItem>
		>();
		expectTypeOf<Payload<PageLinkPluginOptions['menu']>>().toEqualTypeOf<
			TriggerMenuController<PageLinkItem>
		>();
		expectTypeOf<Payload<EmbedPluginOptions['menu']>>().toEqualTypeOf<UrlPasteController>();
		expectTypeOf<Payload<BookmarkPluginOptions['menu']>>().toEqualTypeOf<UrlPasteController>();
		expectTypeOf<Payload<ImagePluginOptions['toolbar']>>().toEqualTypeOf<ImageControls>();
		expectTypeOf<Payload<ImagePluginOptions['empty']>>().toEqualTypeOf<ImageEmptyController>();
		expectTypeOf<Payload<MediaPluginOptions['empty']>>().toEqualTypeOf<MediaEmptyController>();
		expectTypeOf<Payload<EmbedPluginOptions['empty']>>().toEqualTypeOf<MediaEmptyController>();
		expectTypeOf<Payload<BookmarkPluginOptions['empty']>>().toEqualTypeOf<MediaEmptyController>();
		expectTypeOf<Payload<CommentsPluginOptions['card']>>().toEqualTypeOf<CommentCardPayload>();
		expectTypeOf<Payload<SuggestionsOptions['bar']>>().toEqualTypeOf<SuggestionBarPayload>();
		expectTypeOf<Payload<HistoryPanelProps['item']>>().toEqualTypeOf<HistoryVersionItem>();
		expectTypeOf<Payload<TablePluginOptions['menu']>>().toEqualTypeOf<TableChrome>();
		expectTypeOf<Payload<CodePluginOptions['header']>>().toEqualTypeOf<CodeHeader>();
		expectTypeOf<Payload<CodePluginOptions['menu']>>().toEqualTypeOf<LanguageMenu>();
		expectTypeOf<Payload<EquationPluginOptions['panel']>>().toEqualTypeOf<EquationEditor>();
	});

	it('a table’s grip and `+` receive their own payloads, which carry the chrome’s words', () => {
		expectTypeOf<Payload<TablePluginOptions['grip']>>().toEqualTypeOf<TableGripPayload>();
		expectTypeOf<Payload<TablePluginOptions['add']>>().toEqualTypeOf<TableAddPayload>();
		expectTypeOf<TableGripPayload['grip']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<TableGripPayload['kind']>().toEqualTypeOf<'row' | 'column'>();
		expectTypeOf<TableGripPayload['labels']>().toEqualTypeOf<TableLabels>();
		expectTypeOf<TableGripPayload['chrome']>().toEqualTypeOf<TableChrome>();
		expectTypeOf<TableAddPayload['add']>().toEqualTypeOf<() => void>();
		expectTypeOf<TableAddPayload['labels']>().toEqualTypeOf<TableLabels>();
	});

	it('a block handle’s payload says what its `+` and grip opened, and takes the `+` as the anchor', () => {
		expectTypeOf<BlockHandleSnippetPayload['expanded']>().toEqualTypeOf<{
			add: boolean;
			grip: boolean;
		}>();
		expectTypeOf<BlockHandleSnippetPayload['controls']>().toEqualTypeOf<{
			add: string | undefined;
			grip: string | undefined;
		}>();
		expectTypeOf<BlockHandleSnippetPayload['labels']>().toEqualTypeOf<BlockHandlesLabels>();
		expectTypeOf<BlockHandleSnippetPayload['add']>().toEqualTypeOf<
			(alt?: boolean, anchor?: HTMLElement | null) => void
		>();
	});

	it('a controller carries its words, its readonly state and a close', () => {
		expectTypeOf<BlockMenuController>().toHaveProperty('labels');
		expectTypeOf<BlockMenuController['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<SlashMenuController>().toHaveProperty('labels');
		expectTypeOf<SlashMenuController['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<SlashMenuController['close']>().toBeFunction();
		expectTypeOf<ToolbarController>().toHaveProperty('labels');
		expectTypeOf<UrlPasteController>().toHaveProperty('labels');
		expectTypeOf<UrlPasteController['close']>().toBeFunction();
		expectTypeOf<ImageControls>().toHaveProperty('labels');
		expectTypeOf<ImageControls['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<ImageEmptyController['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<MediaEmptyController['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<SuggestionBarPayload>().toHaveProperty('labels');
		expectTypeOf<TableChrome['labels']>().toEqualTypeOf<TableLabels>();
		expectTypeOf<TableChrome['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<TableChrome['close']>().toBeFunction();
		expectTypeOf<CodeHeader['labels']>().toEqualTypeOf<CodeLabels>();
		expectTypeOf<CodeHeader['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<CodeHeader['editable']>().toEqualTypeOf<boolean>();
		expectTypeOf<CodeHeader['copied']>().toEqualTypeOf<boolean>();
		expectTypeOf<CodeHeader['languages']>().toEqualTypeOf<LanguageRow[]>();
		expectTypeOf<CodeHeader['setLanguage']>().toEqualTypeOf<(id: string) => void>();
		expectTypeOf<LanguageMenu['labels']>().toEqualTypeOf<CodeLabels>();
		expectTypeOf<LanguageMenu['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<LanguageMenu['close']>().toBeFunction();
		expectTypeOf<EquationEditor['labels']>().toEqualTypeOf<EquationLabels>();
		expectTypeOf<EquationEditor['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<EquationEditor['close']>().toBeFunction();
	});

	it('the attachments are typed, and a row’s attributes spread', () => {
		expectTypeOf<BlockMenuController['popup']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<BlockMenuController['keys']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<BlockMenuController['flyoutMenu']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<SlashMenuController['popup']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<SlashMenuController['keys']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<TriggerMenuController['popup']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<ToolbarController['popup']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<ToolbarController['keys']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<ToolbarController['linkField']>().toEqualTypeOf<Attachment<HTMLInputElement>>();
		expectTypeOf<UrlPasteController['popup']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<ImageControls['bar']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<ImageControls['altField']>().toEqualTypeOf<Attachment<HTMLInputElement>>();
		expectTypeOf<BlockMenuController['option']>().returns.toEqualTypeOf<OptionAttributes>();
		expectTypeOf<SlashMenuController['option']>().returns.toEqualTypeOf<OptionAttributes>();
		expectTypeOf<UrlPasteController['option']>().returns.toEqualTypeOf<OptionAttributes>();
		expectTypeOf<TableChrome['popup']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<TableChrome['keys']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<TableChrome['gripOf']>().returns.toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<TableChrome['option']>().returns.toEqualTypeOf<OptionAttributes>();
		expectTypeOf<CodeHeader['button']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<LanguageMenu['keys']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<LanguageMenu['popup']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<LanguageMenu['option']>().returns.toEqualTypeOf<OptionAttributes>();
		expectTypeOf<EquationEditor['field']>().toEqualTypeOf<
			Attachment<HTMLTextAreaElement | HTMLInputElement>
		>();
	});
});

describe('one row shape', () => {
	it('every row payload is a MenuItemPayload of what it stands for', () => {
		expectTypeOf<SlashMenuItem>().toExtend<MenuItemPayload<EditorCommand>>();
		expectTypeOf<TriggerItemPayload<MentionItem>>().toExtend<MenuItemPayload<MentionItem>>();
		expectTypeOf<HistoryVersionItem>().toExtend<MenuItemPayload<HistoryVersion>>();
		expectTypeOf<TableMenuItem>().toExtend<MenuItemPayload<TableMenuRow>>();
		expectTypeOf<LanguageMenuItem>().toExtend<MenuItemPayload<LanguageRow>>();
		expectTypeOf<TableChrome['items']>().toEqualTypeOf<TableMenuItem[]>();
		expectTypeOf<LanguageMenu['items']>().toEqualTypeOf<LanguageMenuItem[]>();
		expectTypeOf<Payload<SlashMenuOptions['item']>>().toEqualTypeOf<SlashMenuItem>();
		expectTypeOf<Payload<MentionPluginOptions['item']>>().toEqualTypeOf<
			TriggerItemPayload<MentionItem>
		>();
	});

	it('the names a row had before stay: a slash row’s `command`, a trigger row’s `pick`', () => {
		expectTypeOf<SlashMenuItem['command']>().toEqualTypeOf<EditorCommand>();
		expectTypeOf<SlashMenuItem['icon']>().toEqualTypeOf<string | undefined>();
		expectTypeOf<TriggerItemPayload['pick']>().toEqualTypeOf<TriggerItemPayload['run']>();
	});
});

describe('a snippet typed against another payload, or reading a wrong field, does not compile', () => {
	it('wrong fields', () => {
		const rows = (
			slash: SlashMenuItem,
			trigger: TriggerItemPayload,
			version: HistoryVersionItem
		) => {
			// @ts-expect-error a slash row has no `pick` (its `run` runs the command)
			void slash.pick;
			// @ts-expect-error a trigger row has no `command`
			void trigger.command;
			// @ts-expect-error a version row has no `key` (its `version.key`)
			void version.key;
		};
		const surfaces = (
			menu: BlockMenuController,
			bar: SuggestionBarPayload,
			grip: TableGripPayload,
			header: CodeHeader
		) => {
			// @ts-expect-error the block menu's rows are `rows`, not `commands`
			void menu.commands;
			// @ts-expect-error a suggestion bar has no `close`
			void bar.close;
			// @ts-expect-error a table grip's action is `toggle` (its attachment `grip`), not `open`
			void grip.open;
			// @ts-expect-error a code header's language is `language`, its list's rows are the menu's
			void header.rows;
		};
		expectTypeOf(rows).toBeFunction();
		expectTypeOf(surfaces).toBeFunction();
	});

	it('another surface’s payload', () => {
		const options = (slash: Snippet<[SlashMenuController]>, item: Snippet<[SlashMenuItem]>) => {
			// @ts-expect-error the block menu's `menu` takes a BlockMenuController
			const blockMenu: BlockMenuOptions = { menu: slash };
			// @ts-expect-error the toolbar's `toolbar` takes a ToolbarController
			const toolbar: ToolbarOptions = { toolbar: slash };
			// @ts-expect-error a mention row is a TriggerItemPayload<MentionItem>
			const mention: Partial<MentionPluginOptions> = { item };
			// @ts-expect-error a table's `menu` takes its TableChrome
			const table: TablePluginOptions = { menu: slash };
			// @ts-expect-error a code block's `menu` takes its LanguageMenu
			const code: CodePluginOptions = { menu: slash };
			return [blockMenu, toolbar, mention, table, code];
		};
		expectTypeOf(options).toBeFunction();
	});
});
