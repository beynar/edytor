/**
 * Every chrome snippet is typed by an exported payload (the `test:typecheck`
 * and `test:dom:typecheck` lanes compile this file; the unit lane runs it):
 * `Snippet<[Payload]>` with one object argument, a whole surface's payload
 * its controller; a controller's rows the shape every menu shares
 * (`MenuItemPayload`). Without a snippet a surface renders nothing.
 * A snippet typed against its payload compiles; a wrong field, or another
 * surface's payload, does not (`@ts-expect-error`). Expected types come from
 * the pattern the site's `customization/menus` page states.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { Snippet } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import type {
	BlockHandleSnippetPayload,
	BlockMenuController,
	BlockMenuOptions,
	CodeHeader,
	CodePluginOptions,
	EquationEditor,
	EquationPluginOptions,
	LanguageMenu,
	LanguageMenuItem,
	LanguageRow,
	TableAddPayload,
	TableChrome,
	TableGripPayload,
	TableMenuItem,
	TableMenuRow,
	TablePluginOptions,
	BookmarkPluginOptions,
	CommentCardPayload,
	CommentsPluginOptions,
	CommentsController,
	EmbedPluginOptions,
	ImageControls,
	ImageEmptyController,
	ImagePluginOptions,
	MarqueeBoxPayload,
	MarqueePluginOptions,
	MediaEmptyController,
	MediaPluginOptions,
	MentionItem,
	MentionPluginOptions,
	MenuItemPayload,
	OptionAttributes,
	PageLinkItem,
	PageLinkPluginOptions,
	SlashMenuController,
	SlashMenuOptions,
	SuggestionBarPayload,
	SuggestionsOptions,
	ToolbarController,
	ToolbarOptions,
	Trigger,
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
		expectTypeOf<Payload<CommentsPluginOptions['header']>>().toEqualTypeOf<CommentsController>();
		expectTypeOf<Payload<SuggestionsOptions['bar']>>().toEqualTypeOf<SuggestionBarPayload>();
		expectTypeOf<Payload<TablePluginOptions['menu']>>().toEqualTypeOf<TableChrome>();
		expectTypeOf<Payload<CodePluginOptions['header']>>().toEqualTypeOf<CodeHeader>();
		expectTypeOf<Payload<CodePluginOptions['menu']>>().toEqualTypeOf<LanguageMenu>();
		expectTypeOf<Payload<EquationPluginOptions['panel']>>().toEqualTypeOf<EquationEditor>();
	});

	it('a table’s grip and `+` receive their own payloads, with no words (the markup’s)', () => {
		expectTypeOf<Payload<TablePluginOptions['grip']>>().toEqualTypeOf<TableGripPayload>();
		expectTypeOf<Payload<TablePluginOptions['add']>>().toEqualTypeOf<TableAddPayload>();
		expectTypeOf<TableGripPayload['grip']>().toEqualTypeOf<Attachment<HTMLElement>>();
		expectTypeOf<TableGripPayload['kind']>().toEqualTypeOf<'row' | 'column'>();
		expectTypeOf<TableGripPayload>().not.toHaveProperty('labels');
		expectTypeOf<TableGripPayload['chrome']>().toEqualTypeOf<TableChrome>();
		expectTypeOf<TableAddPayload['add']>().toEqualTypeOf<() => void>();
		expectTypeOf<TableAddPayload>().not.toHaveProperty('label');
	});

	it('the marquee’s box receives its rectangle and what it selects', () => {
		expectTypeOf<Payload<MarqueePluginOptions['box']>>().toEqualTypeOf<MarqueeBoxPayload>();
		expectTypeOf<MarqueeBoxPayload['rect']>().toEqualTypeOf<DOMRectReadOnly>();
		expectTypeOf<MarqueeBoxPayload['count']>().toEqualTypeOf<number>();
		expectTypeOf<MarqueeBoxPayload['ids']>().toEqualTypeOf<readonly string[]>();
		expectTypeOf<MarqueeBoxPayload['adding']>().toEqualTypeOf<boolean>();
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
		expectTypeOf<BlockHandleSnippetPayload>().not.toHaveProperty('labels');
		expectTypeOf<BlockHandleSnippetPayload['beside']>().toEqualTypeOf<boolean>();
		expectTypeOf<BlockHandleSnippetPayload['haspopup']>().toEqualTypeOf<{
			add: 'listbox' | 'menu' | 'dialog' | undefined;
			grip: 'listbox' | 'menu' | 'dialog' | undefined;
		}>();
		expectTypeOf<BlockHandleSnippetPayload['add']>().toEqualTypeOf<
			(alt?: boolean, anchor?: HTMLElement | null) => void
		>();
	});

	it('a controller carries its readonly state and a close, never the chrome’s words', () => {
		expectTypeOf<BlockMenuController>().not.toHaveProperty('labels');
		expectTypeOf<BlockMenuController['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<SlashMenuController>().not.toHaveProperty('labels');
		expectTypeOf<SlashMenuController['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<SlashMenuController['close']>().toBeFunction();
		expectTypeOf<ToolbarController>().not.toHaveProperty('labels');
		expectTypeOf<UrlPasteController>().not.toHaveProperty('labels');
		expectTypeOf<UrlPasteController['close']>().toBeFunction();
		expectTypeOf<ImageControls>().not.toHaveProperty('labels');
		expectTypeOf<ImageControls['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<ImageEmptyController['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<MediaEmptyController['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<SuggestionBarPayload>().not.toHaveProperty('labels');
		expectTypeOf<TableChrome>().not.toHaveProperty('labels');
		expectTypeOf<TableChrome['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<TableChrome['close']>().toBeFunction();
		expectTypeOf<CodeHeader>().not.toHaveProperty('labels');
		expectTypeOf<CodeHeader['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<CodeHeader['editable']>().toEqualTypeOf<boolean>();
		expectTypeOf<CodeHeader['copied']>().toEqualTypeOf<boolean>();
		expectTypeOf<CodeHeader['languages']>().toEqualTypeOf<readonly LanguageRow[]>();
		expectTypeOf<CodeHeader['setLanguage']>().toEqualTypeOf<(id: string) => void>();
		expectTypeOf<LanguageMenu>().not.toHaveProperty('labels');
		expectTypeOf<LanguageMenu['readonly']>().toEqualTypeOf<boolean>();
		expectTypeOf<LanguageMenu['close']>().toBeFunction();
		expectTypeOf<EquationEditor>().not.toHaveProperty('labels');
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
		expectTypeOf<TableMenuItem>().toExtend<MenuItemPayload<TableMenuRow>>();
		expectTypeOf<LanguageMenuItem>().toExtend<MenuItemPayload<LanguageRow>>();
		expectTypeOf<TableChrome['items']>().toEqualTypeOf<TableMenuItem[]>();
		expectTypeOf<LanguageMenu['items']>().toEqualTypeOf<LanguageMenuItem[]>();
	});

	it('a whole surface is one snippet: no row snippet beside it', () => {
		// @ts-expect-error the slash menu takes its `menu`, no `item`
		void ({ item: undefined } satisfies SlashMenuOptions);
		// @ts-expect-error a mention menu takes its `menu`, no `item`
		void ({ items: () => [], item: undefined } satisfies MentionPluginOptions);
	});
});

describe('a snippet typed against another payload, or reading a wrong field, does not compile', () => {
	it('wrong fields', () => {
		const rows = (table: TableMenuItem, language: LanguageMenuItem) => {
			// @ts-expect-error a table row has no `command` (its `item` is the row)
			void table.command;
			// @ts-expect-error a language row has no `key` (its `item.id`)
			void language.key;
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
		const options = (slash: Snippet<[SlashMenuController]>) => {
			// @ts-expect-error the block menu's `menu` takes a BlockMenuController
			const blockMenu: BlockMenuOptions = { menu: slash };
			// @ts-expect-error the toolbar's `toolbar` takes a ToolbarController
			const toolbar: ToolbarOptions = { toolbar: slash };
			// @ts-expect-error a mention menu takes its TriggerMenuController<MentionItem>
			const mention: Partial<MentionPluginOptions> = { menu: slash };
			// @ts-expect-error a table's `menu` takes its TableChrome
			const table: TablePluginOptions = { menu: slash };
			// @ts-expect-error a code block's `menu` takes its LanguageMenu
			const code: CodePluginOptions = { menu: slash };
			// @ts-expect-error the marquee's `box` takes its MarqueeBoxPayload
			const marquee: MarqueePluginOptions = { box: slash };
			return [blockMenu, toolbar, mention, table, code, marquee];
		};
		expectTypeOf(options).toBeFunction();
	});
});
