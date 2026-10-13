/**
 * The bundled plugins drawn with the demo's chrome (`chrome.svelte`): what
 * the demo route, the `/test/*` routes and the DOM tests list. Each is the
 * package's factory given the chrome's snippets; a test that needs other
 * options builds its own with `chrome`.
 */
import {
	createArrowMovePlugin,
	createBlockHandlesPlugin,
	createBlockMenuPlugin,
	createCodePlugin,
	createCommentsPlugin,
	createEmbedPlugin,
	createBookmarkPlugin,
	createEquationPlugin,
	createFindPlugin,
	createImagePlugin,
	createMarqueePlugin,
	type MarqueePluginOptions,
	createMentionPlugin,
	createPageLinkPlugin,
	createFilePlugin,
	createVideoPlugin,
	createAudioPlugin,
	type MentionPluginOptions,
	type PageLinkPluginOptions,
	createMediaEmptyPlugin,
	createImageToolbarPlugin,
	createRichTextPlugin,
	createCalloutIconsPlugin,
	type CalloutIconsOptions,
	createSlashMenuPlugin,
	createSuggestionsPlugin,
	createTablePlugin,
	createToolbarPlugin,
	type BlockHandlesOptions,
	type Plugin,
	type BookmarkPluginOptions,
	type CommentsPluginOptions,
	type EmbedPluginOptions,
	type EquationPluginOptions,
	type RichTextPluginOptions,
	type TablePluginOptions,
	type CodePluginOptions,
	type BlockMenuOptions,
	type ToolbarOptions,
	type SlashMenuOptions,
	type FindPluginOptions,
	type FilePluginOptions,
	type ImagePluginOptions,
	type VideoPluginOptions,
	type AudioPluginOptions,
	createSuggestionBarPlugin
} from 'edytor';
import * as chrome from './chrome.svelte';

export { chrome };

export const slashMenu = (options: SlashMenuOptions = {}) =>
	createSlashMenuPlugin({ menu: chrome.slashMenu, ...options });
export const slashMenuPlugin = slashMenu();
export const blockMenu = (options: BlockMenuOptions = {}) =>
	createBlockMenuPlugin({ menu: chrome.blockMenu, ...options });
export const blockMenuPlugin = blockMenu();
export const toolbar = (options: ToolbarOptions = {}) =>
	createToolbarPlugin({ toolbar: chrome.toolbar, card: chrome.linkCard, ...options });
export const toolbarPlugin = toolbar();
/** The handle plugins `blockHandles` made: a harness that adds the handles adds none over one. */
export const handlePlugins = new WeakSet<Plugin>();
export const blockHandles = (options: BlockHandlesOptions = {}) => {
	const plugin = createBlockHandlesPlugin({ handle: chrome.blockHandle, ...options });
	handlePlugins.add(plugin);
	return plugin;
};
export const blockHandlesPlugin = blockHandles();
export const code = (options: CodePluginOptions = {}) =>
	createCodePlugin({ header: chrome.codeHeader, menu: chrome.languageMenu, ...options });
export const codePlugin = code();
export const table = (options: TablePluginOptions = {}) =>
	createTablePlugin({
		grip: chrome.tableGrip,
		menu: chrome.tableMenu,
		add: chrome.tableAdd,
		...options
	});
export const tablePlugin = table();
export const equation = (options: EquationPluginOptions = {}) =>
	createEquationPlugin({ panel: chrome.equationPanel, ...options });
export const image = (options: ImagePluginOptions = {}) => createImagePlugin(options);
/** The image toolbar (alignments, alt text) over the hovered image. */
export const imageToolbarPlugin = createImageToolbarPlugin({ toolbar: chrome.imageToolbar });
export const imagePlugin = image();
export const embed = (options: EmbedPluginOptions = {}) =>
	createEmbedPlugin({ menu: chrome.urlPasteMenu, ...options });
export const embedPlugin = embed();
export const bookmark = (options: BookmarkPluginOptions = {}) =>
	createBookmarkPlugin({ menu: chrome.urlPasteMenu, ...options });
export const bookmarkPlugin = bookmark();
export const richText = (options: RichTextPluginOptions = {}) => createRichTextPlugin(options);
export const richTextPlugin = richText();
export const calloutIcons = (options: CalloutIconsOptions = {}) =>
	createCalloutIconsPlugin({ picker: chrome.calloutIcons, ...options });
export const calloutIconsPlugin = calloutIcons();
export const find = (options: FindPluginOptions = {}) =>
	createFindPlugin({ bar: chrome.findBar, ...options });
export const findPlugin = find();
/** Block moves from the keyboard (Mod+Up/Down): not a default, listed where blocks move. */
export const arrowMovePlugin = createArrowMovePlugin();
export const suggestionsPlugin = createSuggestionsPlugin();
/** The bar under each block suggestion. */
export const suggestionBarPlugin = createSuggestionBarPlugin({ bar: chrome.suggestionBar });
export const comments = (options: CommentsPluginOptions) =>
	createCommentsPlugin({ card: chrome.commentCard, header: chrome.commentsHeader, ...options });
export const mention = (options: MentionPluginOptions) =>
	createMentionPlugin({ menu: chrome.mentionMenu, ...options });
export const pageLink = (options: PageLinkPluginOptions) =>
	createPageLinkPlugin({ menu: chrome.pageLinkMenu, ...options });
export const file = (options: FilePluginOptions = {}) => createFilePlugin(options);
export const video = (options: VideoPluginOptions = {}) => createVideoPlugin(options);
export const audio = (options: AudioPluginOptions = {}) => createAudioPlugin(options);
export const filePlugin = file();
export const videoPlugin = video();
export const audioPlugin = audio();
/** Every empty image and media block's panel (the demo's Notion "Add …" panels). */
export const mediaEmptyPlugin = createMediaEmptyPlugin({ empty: chrome.mediaEmpty });
export const marquee = (options: MarqueePluginOptions = {}) =>
	createMarqueePlugin({ box: chrome.marqueeBox, ...options });
export const marqueePlugin = marquee();
