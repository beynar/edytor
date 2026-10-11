/**
 * The bundled plugins drawn with the demo's chrome (`chrome.svelte`): what
 * the demo route, the `/test/*` routes and the DOM tests list. Each is the
 * package's factory given the chrome's snippets; a test that needs other
 * options builds its own with `chrome`.
 */
import {
	createBlockHandlesPlugin,
	createBlockMenuPlugin,
	createCodePlugin,
	createCommentsPlugin,
	createEmbedPlugin,
	createBookmarkPlugin,
	createEquationPlugin,
	createFindPlugin,
	createImagePlugin,
	createMentionPlugin,
	createPageLinkPlugin,
	createFilePlugin,
	createVideoPlugin,
	createAudioPlugin,
	type MentionPluginOptions,
	type PageLinkPluginOptions,
	type MediaPluginOptions,
	createRichTextPlugin,
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
	type ImagePluginOptions,
	type RichTextPluginOptions,
	type TablePluginOptions,
	type CodePluginOptions,
	type BlockMenuOptions,
	type ToolbarOptions,
	type SlashMenuOptions,
	type FindPluginOptions,
	type SuggestionsOptions
} from '$lib/index.js';
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
export const image = (options: ImagePluginOptions = {}) =>
	createImagePlugin({ toolbar: chrome.imageToolbar, empty: chrome.imageEmpty, ...options });
export const imagePlugin = image();
export const embed = (options: EmbedPluginOptions = {}) =>
	createEmbedPlugin({ menu: chrome.urlPasteMenu, empty: chrome.mediaEmpty, ...options });
export const embedPlugin = embed();
export const bookmark = (options: BookmarkPluginOptions = {}) =>
	createBookmarkPlugin({ menu: chrome.urlPasteMenu, empty: chrome.mediaEmpty, ...options });
export const bookmarkPlugin = bookmark();
export const richText = (options: RichTextPluginOptions = {}) =>
	createRichTextPlugin({
		...options,
		callout: { picker: chrome.calloutIcons, ...options.callout }
	});
export const richTextPlugin = richText();
export const find = (options: FindPluginOptions = {}) =>
	createFindPlugin({ bar: chrome.findBar, ...options });
export const findPlugin = find();
export const suggestions = (options: SuggestionsOptions = {}) =>
	createSuggestionsPlugin({ bar: chrome.suggestionBar, ...options });
export const suggestionsPlugin = suggestions();
export const comments = (options: CommentsPluginOptions) =>
	createCommentsPlugin({ card: chrome.commentCard, header: chrome.commentsHeader, ...options });
export const mention = (options: MentionPluginOptions) =>
	createMentionPlugin({ menu: chrome.mentionMenu, ...options });
export const pageLink = (options: PageLinkPluginOptions) =>
	createPageLinkPlugin({ menu: chrome.pageLinkMenu, ...options });
export const file = (options: MediaPluginOptions = {}) =>
	createFilePlugin({ empty: chrome.mediaEmpty, ...options });
export const video = (options: MediaPluginOptions = {}) =>
	createVideoPlugin({ empty: chrome.mediaEmpty, ...options });
export const audio = (options: MediaPluginOptions = {}) =>
	createAudioPlugin({ empty: chrome.mediaEmpty, ...options });
export const filePlugin = file();
export const videoPlugin = video();
export const audioPlugin = audio();
