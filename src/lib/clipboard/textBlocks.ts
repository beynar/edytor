/**
 * A plain or markdown-ish string as blocks — AI output, a suggestion's string
 * content (`edytor.suggestions`). Pure: no view, no document.
 *
 * Plain (`markdown: false`): blank lines split paragraphs; a single newline
 * stays in the text. Markdown (the default), line by line: `#`–`###`
 * headings (deeper read as `###`), `-`/`*`/`+` bullets, `1.` numbers,
 * `[ ]`/`[x]` to-dos (also after a bullet), `>` quotes, `---` dividers,
 * fenced code (an unclosed fence keeps its lines: a stream cut mid-block),
 * list items nested by indentation (two spaces a level), and paragraphs of
 * consecutive lines joined by a space; inline `**bold**`, `*italic*` or
 * `_italic_`, `` `code` `` and `[text](url)` links become marks (not nested).
 * The kinds and marks are the rich-text and code plugins'.
 */
import type { JSONBlock, JSONText } from '../utils/json.js';

export type TextToBlocksOptions = {
	/** Read markdown (default `true`); `false` keeps every character as text. */
	markdown?: boolean;
	/** The kind of a paragraph (default `paragraph`). */
	type?: string;
};

const INLINE =
	/\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*|(?<!\w)_([^_\s][^_]*)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Inline markdown as text runs. */
const runs = (text: string): JSONText[] => {
	const out: JSONText[] = [];
	let at = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > at) out.push({ text: text.slice(at, m.index) });
		const [, bold, code, star, under, label, href] = m;
		if (bold) out.push({ text: bold, marks: { bold: true } });
		else if (code) out.push({ text: code, marks: { code: true } });
		else if (label) out.push({ text: label, marks: { link: { href: href! } } });
		else out.push({ text: (star ?? under)!, marks: { italic: true } });
		at = m.index + m[0].length;
	}
	if (at < text.length || !out.length) out.push({ text: text.slice(at) });
	return out;
};

/** A line that opens block markdown: a heading, a list or to-do item, a quote, a fence, a divider. */
const BLOCK_LINE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|(?:-{3,}|\*{3,}|_{3,})\s*$)/;

/** Whether `text` holds block markdown (one line of it is enough), as a paste reads it. */
export const hasBlockMarkdown = (text: string): boolean =>
	text.split(/\r?\n/).some((line) => BLOCK_LINE.test(line));

/** One line's kind, data and text, or `null` for a paragraph line. */
const lineKind = (line: string): (Omit<JSONBlock, 'content'> & { text: string }) | null => {
	let m = /^(#{1,6})\s+(.*)$/.exec(line);
	if (m) return { type: 'heading', data: { level: `h${Math.min(3, m[1]!.length)}` }, text: m[2]! };
	m = /^(?:[-*+]\s+)?\[([ xX])\]\s+(.*)$/.exec(line);
	if (m) return { type: 'todo-item', data: { checked: m[1] !== ' ' }, text: m[2]! };
	m = /^[-*+]\s+(.*)$/.exec(line);
	if (m) return { type: 'bulleted-list-item', text: m[1]! };
	m = /^\d+[.)]\s+(.*)$/.exec(line);
	if (m) return { type: 'numbered-list-item', text: m[1]! };
	m = /^>\s?(.*)$/.exec(line);
	if (m) return { type: 'quote', text: m[1]! };
	return null;
};

/** `text` as blocks (see the module comment). */
export const textToBlocks = (
	text: string,
	{ markdown = true, type = 'paragraph' }: TextToBlocksOptions = {}
): JSONBlock[] => {
	if (!markdown)
		return text
			.split(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/)
			.filter((part) => part.trim())
			.map((part) => ({ type, content: [{ text: part }] }));
	const out: JSONBlock[] = [];
	/** The list items open at each indentation level. */
	const levels: JSONBlock[] = [];
	let paragraph: string[] | null = null;
	let code: JSONBlock | null = null;
	const close = () => {
		if (paragraph) out.push({ type, content: runs(paragraph.join(' ')) });
		paragraph = null;
	};
	for (const raw of text.split(/\r?\n/)) {
		if (code) {
			if (/^\s*```/.test(raw)) code = null;
			else code.children!.push({ type: 'codeLine', content: [{ text: raw }] });
			continue;
		}
		const line = raw.trim();
		const indent = Math.floor(raw.replace(/\t/g, '  ').search(/\S|$/) / 2);
		const kind = line && lineKind(line);
		if (!kind) levels.length = 0;
		if (line.startsWith('```')) {
			close();
			out.push((code = { type: 'code', content: [], children: [] }));
		} else if (!line) close();
		else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
			close();
			out.push({ type: 'divider', content: [] });
		} else if (!kind) (paragraph ??= []).push(line);
		else {
			close();
			const { text: body, ...rest } = kind;
			const block: JSONBlock = { ...rest, content: runs(body) };
			const parent = rest.type.endsWith('item')
				? levels[Math.min(indent, levels.length) - 1]
				: null;
			if (parent) (parent.children ??= []).push(block);
			else out.push(block);
			levels.length = parent ? Math.min(indent, levels.length) : 0;
			if (rest.type.endsWith('item')) levels.push(block);
		}
	}
	close();
	return out;
};
