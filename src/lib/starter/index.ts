/**
 * `edytor/starter`: a full editor in one component (`StarterEditor`), and
 * the ready-made chrome it draws, for an app that builds its own editor
 * from the bundled plugins. Only an app that imports it ships it.
 */
export { default as StarterEditor } from './StarterEditor.svelte';
export { starterPlugins, type StarterPluginInput } from './starterPlugins.js';
export { themeStyle, themeVariables } from './theme.js';
export type {
	StarterColors,
	StarterCoverPayload,
	StarterEditorProps,
	StarterIconPayload,
	StarterPageData,
	StarterPart,
	StarterPerson,
	StarterPluginOptions,
	StarterPlugins,
	StarterPropertiesPayload,
	StarterProperty,
	StarterPropertyCellPayload,
	StarterPropertyOption,
	StarterPropertyType,
	StarterPropertyValue,
	StarterTheme,
	StarterTitlePayload
} from './types.js';

// The ready-made chrome: each bundled plugin drawn with it, and its words.
export {
	chrome,
	slashMenu,
	slashMenuPlugin,
	blockMenu,
	blockMenuPlugin,
	toolbar,
	toolbarPlugin,
	blockHandles,
	blockHandlesPlugin,
	code,
	codePlugin,
	table,
	tablePlugin,
	equation,
	image,
	imagePlugin,
	imageToolbarPlugin,
	embed,
	embedPlugin,
	bookmark,
	bookmarkPlugin,
	richText,
	richTextPlugin,
	calloutIcons,
	calloutIconsPlugin,
	find,
	findPlugin,
	arrowMovePlugin,
	suggestionsPlugin,
	suggestionBarPlugin,
	comments,
	mention,
	pageLink,
	file,
	filePlugin,
	video,
	videoPlugin,
	audio,
	audioPlugin,
	mediaEmptyPlugin,
	marquee,
	marqueePlugin
} from './chrome/plugins.js';
export {
	words,
	setWords,
	englishWords,
	type ChromeWords,
	type PartialChromeWords
} from './chrome/words.svelte.js';
export { default as HistoryPanel } from './chrome/HistoryPanel.svelte';
