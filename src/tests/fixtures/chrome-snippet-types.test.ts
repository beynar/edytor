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
	BlockMenuController,
	BlockMenuOptions,
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
	});
});

describe('one row shape', () => {
	it('every row payload is a MenuItemPayload of what it stands for', () => {
		expectTypeOf<SlashMenuItem>().toExtend<MenuItemPayload<EditorCommand>>();
		expectTypeOf<TriggerItemPayload<MentionItem>>().toExtend<MenuItemPayload<MentionItem>>();
		expectTypeOf<HistoryVersionItem>().toExtend<MenuItemPayload<HistoryVersion>>();
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
		const surfaces = (menu: BlockMenuController, bar: SuggestionBarPayload) => {
			// @ts-expect-error the block menu's rows are `rows`, not `commands`
			void menu.commands;
			// @ts-expect-error a suggestion bar has no `close`
			void bar.close;
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
			return [blockMenu, toolbar, mention];
		};
		expectTypeOf(options).toBeFunction();
	});
});
