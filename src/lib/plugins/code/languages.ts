/**
 * Code block languages: the languages a code block's header
 * offers, stored in its `data.language`, and their TanStack Highlight
 * grammars, loaded the first time a line of that language renders. JSX
 * (JavaScript, the default) ships with the plugin; every other grammar is
 * its own chunk.
 */
import {
	createHighlighter,
	type Highlighter,
	type LanguageDefinition
} from '@tanstack/highlight/core';
import { jsx } from '@tanstack/highlight/languages/jsx';
import { SvelteMap } from 'svelte/reactivity';
import type { JSONText } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { englishLabels, type CodeLabels, type PartialLabels } from '$lib/labels.js';
import type { Snippet } from 'svelte';
import type { CodeHeader } from './header.svelte.js';
import type { LanguageMenu } from './languageMenu.svelte.js';

/** A language a code block may be in. */
export type CodeLanguage = {
	/** Stored in the code block's `data.language`. */
	id: string;
	/** Shown in the header and its picker. */
	label: string;
	/**
	 * The name of the grammar its lines are tokenized with; absent, its lines
	 * are plain text (no tokens).
	 */
	grammar?: string;
	/**
	 * Loads the grammar, then the grammars it embeds (HTML's styles and
	 * scripts). Called once, the first time a line of the language renders.
	 */
	load?: () => Promise<readonly LanguageDefinition[]>;
};

const scripts = () =>
	Promise.all([
		import('@tanstack/highlight/languages/css'),
		import('@tanstack/highlight/languages/js'),
		import('@tanstack/highlight/languages/ts')
	]).then(([{ css }, { js }, { ts }]) => [css, js, ts]);

/** A markup grammar with the style and script grammars it embeds. */
const markup = (grammar: () => Promise<LanguageDefinition>) => () =>
	Promise.all([grammar(), scripts()]).then(([own, embedded]) => [own, ...embedded]);

/** The default languages, after Notion's list, sorted by label (Plain text first). */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
	{ id: 'plaintext', label: 'Plain text' },
	{
		id: 'bash',
		label: 'Bash',
		grammar: 'shell',
		load: () => import('@tanstack/highlight/languages/shell').then((m) => [m.shell])
	},
	{
		id: 'cpp',
		label: 'C++',
		grammar: 'cpp',
		load: () => import('@tanstack/highlight/languages/cpp').then((m) => [m.cpp])
	},
	{
		id: 'css',
		label: 'CSS',
		grammar: 'css',
		load: () => import('@tanstack/highlight/languages/css').then((m) => [m.css])
	},
	{
		id: 'diff',
		label: 'Diff',
		grammar: 'diff',
		load: () => import('@tanstack/highlight/languages/diff').then((m) => [m.diff])
	},
	{
		id: 'docker',
		label: 'Docker',
		grammar: 'dockerfile',
		load: () => import('@tanstack/highlight/languages/dockerfile').then((m) => [m.dockerfile])
	},
	{
		id: 'go',
		label: 'Go',
		grammar: 'go',
		load: () => import('@tanstack/highlight/languages/go').then((m) => [m.go])
	},
	{
		id: 'html',
		label: 'HTML',
		grammar: 'html',
		load: markup(() => import('@tanstack/highlight/languages/html').then((m) => m.html))
	},
	{ id: 'javascript', label: 'JavaScript', grammar: 'jsx', load: async () => [jsx] },
	{
		id: 'json',
		label: 'JSON',
		grammar: 'json',
		load: () => import('@tanstack/highlight/languages/json').then((m) => [m.json])
	},
	{
		id: 'markdown',
		label: 'Markdown',
		grammar: 'markdown',
		load: () => import('@tanstack/highlight/languages/markdown').then((m) => [m.markdown])
	},
	{
		id: 'mermaid',
		label: 'Mermaid',
		grammar: 'mermaid',
		load: () => import('@tanstack/highlight/languages/mermaid').then((m) => [m.mermaid])
	},
	{
		id: 'php',
		label: 'PHP',
		grammar: 'php',
		load: () => import('@tanstack/highlight/languages/php').then((m) => [m.php])
	},
	{
		id: 'python',
		label: 'Python',
		grammar: 'python',
		load: () => import('@tanstack/highlight/languages/python').then((m) => [m.python])
	},
	{
		id: 'sql',
		label: 'SQL',
		grammar: 'sql',
		load: () => import('@tanstack/highlight/languages/sql').then((m) => [m.sql])
	},
	{
		id: 'svelte',
		label: 'Svelte',
		grammar: 'svelte',
		load: markup(() => import('@tanstack/highlight/languages/svelte').then((m) => m.svelte))
	},
	{
		id: 'toml',
		label: 'TOML',
		grammar: 'toml',
		load: () => import('@tanstack/highlight/languages/toml').then((m) => [m.toml])
	},
	{
		id: 'typescript',
		label: 'TypeScript',
		grammar: 'ts',
		load: () => import('@tanstack/highlight/languages/ts').then((m) => [m.ts])
	},
	{
		id: 'vue',
		label: 'Vue',
		grammar: 'vue',
		load: markup(() => import('@tanstack/highlight/languages/vue').then((m) => m.vue))
	},
	{
		id: 'xml',
		label: 'XML',
		grammar: 'html',
		load: () => import('@tanstack/highlight/languages/html').then((m) => [m.html])
	},
	{
		id: 'yaml',
		label: 'YAML',
		grammar: 'yaml',
		load: () => import('@tanstack/highlight/languages/yaml').then((m) => [m.yaml])
	}
];

/**
 * The grammars loaded so far, by name, shared by every editor (a grammar is
 * pure). A line reading one tracks it: when a grammar lands, the lines that
 * rendered without it render again, highlighted.
 */
const grammars = new SvelteMap<string, LanguageDefinition>([[jsx.name, jsx]]);
let highlighter: Highlighter = createHighlighter({ languages: [jsx] });
/** One load per grammar name; a failed load is forgotten, so the next render tries again. */
const loading = new Map<string, Promise<void>>();

/** Load `language`'s grammar (and those it embeds); resolves once its lines highlight. */
export const loadCodeLanguage = (language: CodeLanguage): Promise<void> => {
	const { grammar, load } = language;
	if (!grammar || !load || grammars.has(grammar)) return Promise.resolve();
	let pending = loading.get(grammar);
	if (!pending) {
		pending = load().then(
			(definitions) => {
				const all = new Map(grammars);
				for (const definition of definitions) all.set(definition.name, definition);
				highlighter = createHighlighter({ languages: [...all.values()] });
				for (const definition of definitions) grammars.set(definition.name, definition);
			},
			() => void loading.delete(grammar)
		);
		loading.set(grammar, pending);
	}
	return pending;
};

/**
 * `code` as `language`'s tokens: a `codeToken` mark per token (its class),
 * plain text between. Before the grammar is loaded, plain text, and the load
 * starts; a language without a grammar is always plain text.
 */
export const tokenizeCode = (code: string, language: CodeLanguage | undefined): JSONText[] => {
	const grammar = language?.grammar;
	if (!grammar || !grammars.has(grammar)) {
		if (language) void loadCodeLanguage(language);
		return [{ text: code }];
	}
	return highlighter
		.tokenize(code, { lang: grammar })
		.tokens.map(
			({ className, value }): JSONText =>
				className ? { text: value, marks: { codeToken: className } } : { text: value }
		);
};

export type CodePluginOptions = {
	/** The languages a code block may be in, in the header's order. Default `CODE_LANGUAGES`. */
	languages?: readonly CodeLanguage[];
	/** The language of a code block whose `data.language` is unset. Default `'javascript'`. */
	defaultLanguage?: string;
	/**
	 * The words the code block shows (its menu row, header, a language's
	 * label by id), over the English ones.
	 */
	labels?: PartialLabels<'code'>;
	/** The slash menu's keywords of the code command (`block.code`), which replace its own. */
	keywords?: Partial<Record<string, string[]>>;
	/**
	 * Replace a code block's header (the language's button and Copy): it
	 * renders above the code, in the block's non-editable part. Put
	 * `{@attach header.button}` on the element that opens the language list.
	 */
	header?: Snippet<[CodeHeader]>;
	/**
	 * Replace the language list: it renders under the header's button while
	 * `menu.open` is set. Put `{@attach menu.keys}` on its search field,
	 * `{@attach menu.popup}` on the list, and spread `item.option` (or
	 * `menu.option(index)`) on each row of `menu.items`. The first code
	 * plugin listed in a view owns its list.
	 */
	menu?: Snippet<[LanguageMenu]>;
};

export type CodeSettings = {
	languages: readonly CodeLanguage[];
	defaultLanguage: string;
	labels: CodeLabels;
	/** The app's header markup, if any. */
	header?: Snippet<[CodeHeader]>;
	/** The app's language list markup, if any. */
	menu?: Snippet<[LanguageMenu]>;
};

export const DEFAULT_CODE_SETTINGS: CodeSettings = {
	languages: CODE_LANGUAGES,
	defaultLanguage: 'javascript',
	labels: englishLabels.code
};

/** A language's label as shown: the labels' `languages` entry for its id, else its own. */
export const languageLabel = (language: CodeLanguage, { labels }: CodeSettings) =>
	labels.languages[language.id] ?? language.label;

/** Each view's code options, for its code blocks' header (which reads them through its view). */
export const codeSettings = new WeakMap<Edytor, CodeSettings>();

/** A code block's language id: its `data.language`, else the default. */
export const languageOf = (
	data: { language?: unknown } | undefined,
	{ defaultLanguage }: CodeSettings
) => (typeof data?.language === 'string' && data.language ? data.language : defaultLanguage);
