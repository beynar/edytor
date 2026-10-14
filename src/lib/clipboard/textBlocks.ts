/**
 * A plain or markdown string as blocks — AI output, a suggestion's string
 * content (`edytor.suggestions`), a markdown file. Pure: no view, no
 * document, no DOM; Worker-safe.
 *
 * Plain (`markdown: false`): blank lines split paragraphs; a single newline
 * stays in the text. Markdown (the default, CommonMark and GFM's common
 * set), line by line: `#`–`######` headings (deeper than `###` read as
 * `###`), `-`/`*`/`+` bullets, `1.` numbers, `[ ]`/`[x]` to-dos (also after
 * a bullet), list items nested by indentation (under the item whose marker
 * is left of theirs), `>` quotes (consecutive lines one quote, its first
 * paragraph its text), a GitHub alert (`> [!NOTE]`) a callout (a leading
 * emoji its icon), `<details>`/`<summary>` a toggle, `---` dividers,
 * fenced code (its language in `data.language`; an unclosed fence keeps
 * its lines: a stream cut mid-block), `$$` equations, a line holding only
 * an image (`![alt](src "caption")`) an image, GFM tables (`| a | b |`
 * over `| --- | --- |`) a table whose first row is a header, and
 * paragraphs of consecutive lines joined by a space (a line ending in `\`
 * or two spaces a line break). Inline: `**bold**`, `*italic*` or
 * `_italic_`, `***both***`, `~~strike~~`, `` `code` ``, `[text](url)`
 * and `<https://…>` links (a link's href through the link sanitizer: a
 * `javascript:` URL is text), nested (`**[bold link](url)**`), `\`
 * escapes. The kinds and marks are the bundled plugins'.
 *
 * `streaming: true` reads a text that is still arriving (a model's answer
 * so far): the last line, while it has no newline yet, is held back while
 * it is only a block marker (`#`, `-`, `1.`, a table row), and from an
 * inline marker it has not closed yet (`**bol`); a table's header row
 * waits for its separator row. Each call then shows only what will not
 * change kind or marks when more arrives.
 */
import type { JSONBlock, JSONText, SerializableContent } from '../utils/json.js';
import { sanitizeLinkHref } from '../utils/sanitize.js';
import { tableBlock } from '../crdt/tables.js';

export type TextToBlocksOptions = {
	/** Read markdown (default `true`); `false` keeps every character as text. */
	markdown?: boolean;
	/** The kind of a paragraph (default `paragraph`). */
	type?: string;
	/**
	 * The text is still arriving (default `false`): hold back an unfinished
	 * last line's block marker or unclosed inline marker, and a table header
	 * row without its separator yet, so a streamed preview never shows raw
	 * markdown that the next chunk turns into a kind or a mark.
	 */
	streaming?: boolean;
};

type Marks = Record<string, SerializableContent>;

/** ASCII punctuation: what a backslash escapes. */
const PUNCT = /[!-/:-@[-`{-~]/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** The end of the code span opened by the backtick run at `at`, or -1. */
const codeEnd = (text: string, at: number, length: number) => {
	for (let i = at + length; i < text.length; ) {
		if (text[i] !== '`') {
			i++;
			continue;
		}
		let j = i;
		while (text[j] === '`') j++;
		if (j - i === length) return i;
		i = j;
	}
	return -1;
};

/** The index after a link's `](dest "title")` starting at `at` (`(`), its href; else null. */
const destinationAt = (text: string, at: number): { end: number; href: string } | null => {
	if (text[at] !== '(') return null;
	let i = at + 1;
	while (text[i] === ' ') i++;
	let href: string;
	if (text[i] === '<') {
		const close = text.indexOf('>', i);
		if (close === -1) return null;
		href = text.slice(i + 1, close);
		i = close + 1;
	} else {
		let depth = 0;
		const start = i;
		for (; i < text.length; i++) {
			const c = text[i]!;
			if (c === '\\') i++;
			else if (c === '(') depth++;
			else if (c === ')' && depth-- === 0) break;
			else if (/\s/.test(c)) break;
		}
		href = text.slice(start, i).replace(/\\(.)/g, '$1');
	}
	while (text[i] === ' ') i++;
	if (text[i] === '"' || text[i] === "'") {
		const close = text.indexOf(text[i]!, i + 1);
		if (close === -1) return null;
		i = close + 1;
		while (text[i] === ' ') i++;
	}
	return text[i] === ')' ? { end: i + 1, href } : null;
};

/** The `]` closing the link label opened at `at` (`[`), skipping code spans and escapes; or -1. */
const labelEnd = (text: string, at: number) => {
	let depth = 0;
	for (let i = at + 1; i < text.length; i++) {
		const c = text[i];
		if (c === '\\') i++;
		else if (c === '`') {
			let n = 0;
			while (text[i + n] === '`') n++;
			const end = codeEnd(text, i, n);
			if (end !== -1) i = end + n - 1;
		} else if (c === '[') depth++;
		else if (c === ']' && depth-- === 0) return i;
	}
	return -1;
};

/**
 * The closing delimiter run of the emphasis `char` × `length` opened at
 * `at`: the first run of at least `length` of them after a non-space
 * (an `_` not followed by a letter), skipping code spans, links and
 * escapes. Returns where the closing `length` characters start.
 */
const emphasisEnd = (text: string, at: number, char: string, length: number) => {
	for (let i = at + length; i < text.length; i++) {
		const c = text[i];
		if (c === '\\') {
			i++;
			continue;
		}
		if (c === '`') {
			let n = 0;
			while (text[i + n] === '`') n++;
			const end = codeEnd(text, i, n);
			if (end !== -1) i = end + n - 1;
			continue;
		}
		if (c === '[') {
			const end = labelEnd(text, i);
			const link = end !== -1 ? destinationAt(text, end + 1) : null;
			if (link) i = link.end - 1;
			continue;
		}
		if (c !== char) continue;
		let j = i;
		while (text[j] === char) j++;
		const run = j - i;
		if (
			run >= length &&
			!isSpace(text[i - 1]) &&
			i > at + length &&
			!(char === '_' && isWord(text[j]))
		)
			return j - length;
		i = j - 1;
	}
	return -1;
};

/** The marks of an emphasis run: `*` italic, `**` bold, `***` both, `~~` strike. */
const emphasisMarks = (char: string, length: number): Marks =>
	char === '~'
		? { strike: true }
		: length === 1
			? { italic: true }
			: length === 2
				? { bold: true }
				: { bold: true, italic: true };

/** Inline markdown as text runs, `marks` on every run (nested marks add up). */
const inline = (text: string, marks: Marks = {}): JSONText[] => {
	const out: JSONText[] = [];
	let plain = '';
	const push = (value: string, own: Marks) => {
		if (!value) return;
		const last = out.at(-1);
		if (last && JSON.stringify(last.marks ?? {}) === JSON.stringify(own)) last.text += value;
		else out.push(Object.keys(own).length ? { text: value, marks: own } : { text: value });
	};
	const flush = () => {
		push(plain, marks);
		plain = '';
	};
	for (let i = 0; i < text.length; ) {
		const c = text[i]!;
		if (c === '\\' && PUNCT.test(text[i + 1] ?? '')) {
			plain += text[i + 1];
			i += 2;
			continue;
		}
		if (c === '`') {
			let n = 0;
			while (text[i + n] === '`') n++;
			const end = codeEnd(text, i, n);
			if (end === -1) {
				plain += '`'.repeat(n);
				i += n;
				continue;
			}
			let code = text.slice(i + n, end);
			if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
			flush();
			push(code, { ...marks, code: true });
			i = end + n;
			continue;
		}
		if (c === '<') {
			const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(text.slice(i));
			const href = auto && sanitizeLinkHref(auto[1]);
			if (auto && href) {
				flush();
				push(auto[1]!, { ...marks, link: { href } });
				i += auto[0].length;
				continue;
			}
		}
		if (c === '[' || (c === '!' && text[i + 1] === '[')) {
			const image = c === '!';
			const open = image ? i + 1 : i;
			const end = labelEnd(text, open);
			const link = end !== -1 ? destinationAt(text, end + 1) : null;
			if (link) {
				flush();
				const label = text.slice(open + 1, end);
				const href = sanitizeLinkHref(link.href);
				// An inline image keeps its alt text; an unsafe href keeps the label as text.
				if (image) out.push(...inline(label, marks));
				else out.push(...inline(label, href ? { ...marks, link: { href } } : marks));
				i = link.end;
				continue;
			}
		}
		if (c === '*' || c === '_' || (c === '~' && text[i + 1] === '~')) {
			let n = 0;
			while (text[i + n] === c) n++;
			const length = c === '~' ? 2 : Math.min(n, 3);
			const opens = n === length && !isSpace(text[i + n]) && !(c === '_' && isWord(text[i - 1]));
			const end = opens ? emphasisEnd(text, i, c, length) : -1;
			if (end !== -1) {
				flush();
				for (const part of inline(text.slice(i + length, end), {
					...marks,
					...emphasisMarks(c, length)
				}))
					push(part.text, part.marks ?? {});
				i = end + length;
				continue;
			}
			plain += c.repeat(n);
			i += n;
			continue;
		}
		plain += c;
		i++;
	}
	flush();
	if (!out.length) out.push({ text: '' });
	return out;
};

/** A line that opens block markdown: a heading, a list or to-do item, a quote, a fence, a divider. */
const BLOCK_LINE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/;

/** Whether `text` holds block markdown (one line of it is enough), as a paste reads it. */
export const hasBlockMarkdown = (text: string): boolean =>
	text.split(/\r?\n/).some((line) => BLOCK_LINE.test(line));

/** A list or to-do item line: its kind, data and text. */
const itemOf = (line: string): (Omit<JSONBlock, 'content'> & { text: string }) | null => {
	let m = /^(?:[-*+]\s+)?\[([ xX])\]\s+(.*)$/.exec(line);
	if (m) return { type: 'todo-item', data: { checked: m[1] !== ' ' }, text: m[2]! };
	m = /^[-*+]\s+(.*)$/.exec(line);
	if (m) return { type: 'bulleted-list-item', text: m[1]! };
	m = /^\d+[.)]\s+(.*)$/.exec(line);
	if (m) return { type: 'numbered-list-item', text: m[1]! };
	return null;
};

/** A table row's cells: split on unescaped `|` outside code spans, the outer pipes dropped. */
const cellsOf = (line: string) => {
	const cells: string[] = [];
	let cell = '';
	const text = line.trim().replace(/^\|/, '');
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (c === '\\' && text[i + 1] === '|') {
			cell += '|';
			i++;
		} else if (c === '`') {
			let n = 0;
			while (text[i + n] === '`') n++;
			const end = codeEnd(text, i, n);
			const to = end === -1 ? i + n : end + n;
			cell += text.slice(i, to);
			i = to - 1;
		} else if (c === '|') {
			cells.push(cell.trim());
			cell = '';
		} else cell += c;
	}
	if (cell.trim() || !/\|\s*$/.test(line)) cells.push(cell.trim());
	return cells;
};
const TABLE_ROW = /^\s*\|.*\|?\s*$|^[^|]*\|.*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const ICON =
	/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s+/u;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const IMAGE_LINE =
	/^!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"((?:\\.|[^"\\])*)")?\s*\)$/;

/** A code block's language as stored: a short name, else none. */
const languageOf = (name: string | undefined) =>
	name && /^[\w#+.-]{1,40}$/.test(name) ? name : undefined;

/** Markdown lines as blocks (see the module comment). */
const parse = (lines: string[], type: string): JSONBlock[] => {
	const root: JSONBlock[] = [];
	/** The containers open (`<details>`), their children the current output. */
	const containers: JSONBlock[] = [];
	const out = () => containers.at(-1)?.children ?? root;
	/** The list items open, with their marker's column. */
	const levels: { block: JSONBlock; indent: number }[] = [];
	let paragraph: string[] | null = null;
	const close = () => {
		if (paragraph) {
			let text = '';
			paragraph.forEach((line, index) => {
				if (index === 0) text = line;
				else
					text = /(?:\\| {2,})$/.test(text)
						? `${text.replace(/(?:\\| +)$/, '')}\n${line}`
						: `${text} ${line}`;
			});
			out().push({ type, content: inline(text.replace(/ +$/, '')) });
		}
		paragraph = null;
	};
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const line = raw.trim();
		const fence = FENCE.exec(raw);
		if (fence) {
			close();
			levels.length = 0;
			const [, space, marks, name] = fence;
			const children: JSONBlock[] = [];
			const closing = new RegExp(`^\\s*${marks![0] === '`' ? '`' : '~'}{${marks!.length},}\\s*$`);
			for (i++; i < lines.length && !closing.test(lines[i]!); i++) {
				const text = lines[i]!.startsWith(space!)
					? lines[i]!.slice(space!.length)
					: lines[i]!.trimStart();
				children.push({ type: 'codeLine', content: [{ text }] });
			}
			const language = languageOf(name);
			out().push({ type: 'code', ...(language && { data: { language } }), content: [], children });
			continue;
		}
		if (!line) {
			close();
			levels.length = 0;
			continue;
		}
		if (/^<details>$/i.test(line)) {
			close();
			levels.length = 0;
			const toggle: JSONBlock = { type: 'toggle', content: [], children: [] };
			out().push(toggle);
			containers.push(toggle);
			continue;
		}
		const summary = /^<summary>(?:<(h[1-6])>)?(.*?)(?:<\/h[1-6]>)?<\/summary>$/i.exec(line);
		if (summary && containers.length) {
			close();
			const toggle = containers.at(-1)!;
			toggle.content = inline(summary[2]!);
			if (summary[1]) {
				toggle.type = 'toggle-heading';
				const level = summary[1].toLowerCase();
				toggle.data = { level: level === 'h1' || level === 'h2' ? level : 'h3' };
			}
			continue;
		}
		if (/^<\/details>$/i.test(line) && containers.length) {
			close();
			levels.length = 0;
			const toggle = containers.pop()!;
			if (!toggle.children!.length) delete toggle.children;
			continue;
		}
		if (line === '$$') {
			close();
			levels.length = 0;
			const source: string[] = [];
			for (i++; i < lines.length && lines[i]!.trim() !== '$$'; i++) source.push(lines[i]!);
			out().push({ type: 'equation', data: { expression: source.join('\n').trim() }, content: [] });
			continue;
		}
		if (/^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/.test(line)) {
			close();
			levels.length = 0;
			out().push({ type: 'divider', content: [] });
			continue;
		}
		const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(line) ?? /^(#{1,6})$/.exec(line);
		if (heading) {
			close();
			levels.length = 0;
			out().push({
				type: 'heading',
				data: { level: `h${Math.min(3, heading[1]!.length)}` },
				content: inline(heading[2] ?? '')
			});
			continue;
		}
		if (
			TABLE_ROW.test(line) &&
			line.includes('|') &&
			TABLE_SEPARATOR.test(lines[i + 1] ?? '') &&
			(lines[i + 1] ?? '').includes('-')
		) {
			close();
			levels.length = 0;
			const rows = [cellsOf(line)];
			for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes('|'); i++)
				rows.push(cellsOf(lines[i]!));
			i--;
			const cells = rows.map((row) =>
				row.map((cell) => inline(cell.replace(/<br\s*\/?>/gi, '\n')))
			);
			out().push(
				tableBlock({
					cells: cells.map((row) =>
						row.map((runs) => (runs.length === 1 && !runs[0]!.text ? '' : runs))
					),
					headerRow: true
				})
			);
			continue;
		}
		const image = IMAGE_LINE.exec(line);
		if (image) {
			close();
			levels.length = 0;
			const src = image[2]!.replace(/^<|>$/g, '');
			const alt = image[1]!.replace(/\\(.)/g, '$1');
			const caption = image[3]?.replace(/\\(.)/g, '$1');
			out().push({
				type: 'image',
				data: { src, ...(alt && { alt }) },
				content: caption ? inline(caption) : []
			});
			continue;
		}
		if (line.startsWith('>')) {
			close();
			levels.length = 0;
			const inner: string[] = [];
			for (; i < lines.length && lines[i]!.trim().startsWith('>'); i++)
				inner.push(lines[i]!.trim().replace(/^> ?/, ''));
			i--;
			const alert = ALERT.test(inner[0] ?? '');
			const blocks = parse(alert ? inner.slice(1) : inner, type);
			const first = blocks[0]?.type === type ? blocks.shift()! : undefined;
			const block: JSONBlock = { type: alert ? 'callout' : 'quote', content: first?.content ?? [] };
			if (alert) {
				const head = block.content![0];
				const icon = head && 'text' in head ? ICON.exec(head.text) : null;
				if (icon && head && 'text' in head) {
					block.data = { icon: icon[1]! };
					head.text = head.text.slice(icon[0].length);
					if (!head.text && block.content!.length > 1) block.content!.shift();
				}
			}
			if (blocks.length) block.children = blocks;
			out().push(block);
			continue;
		}
		const item = itemOf(line);
		if (item) {
			close();
			const indent = raw.replace(/\t/g, '    ').search(/\S/);
			while (levels.length && levels.at(-1)!.indent >= indent) levels.pop();
			const { text, ...rest } = item;
			const block: JSONBlock = { ...rest, content: inline(text) };
			const parent = levels.at(-1)?.block;
			if (parent) (parent.children ??= []).push(block);
			else out().push(block);
			levels.push({ block, indent });
			continue;
		}
		levels.length = 0;
		(paragraph ??= []).push(line);
	}
	close();
	return root;
};

/** An inline marker the last line opened and has not closed: where it starts, else -1. */
const unclosedAt = (line: string) => {
	const open: { char: string; length: number; at: number }[] = [];
	for (let i = 0; i < line.length; ) {
		const c = line[i]!;
		if (c === '\\') {
			i += 2;
			continue;
		}
		if (c === '`') {
			let n = 0;
			while (line[i + n] === '`') n++;
			const end = codeEnd(line, i, n);
			if (end === -1) return open[0]?.at ?? i;
			i = end + n;
			continue;
		}
		if (c === '[' || (c === '!' && line[i + 1] === '[')) {
			const at = c === '!' ? i + 1 : i;
			const end = labelEnd(line, at);
			if (end === -1) return open[0]?.at ?? i;
			if (line[end + 1] === '(') {
				const link = destinationAt(line, end + 1);
				if (!link) return open[0]?.at ?? i;
				i = link.end;
			} else i = end + 1;
			continue;
		}
		if (c === '*' || c === '_' || c === '~') {
			let n = 0;
			while (line[i + n] === c) n++;
			const top = open.at(-1);
			if (top && top.char === c && !isSpace(line[i - 1])) {
				if (n >= top.length) open.pop();
			} else if (
				!isSpace(line[i + n]) &&
				!(c === '_' && isWord(line[i - 1])) &&
				(c !== '~' || n >= 2)
			)
				open.push({ char: c, length: n, at: i });
			i += n;
			continue;
		}
		i++;
	}
	return open[0]?.at ?? -1;
};

/** A line that is only a block marker so far: `#`, `-`, `1.`, `>`, a fence's backticks, a to-do box. */
const MARKER_ONLY =
	/^\s*(?:#{1,6}|[-*+]|\d+[.)]?|>|`{1,2}|~{1,2}|(?:[-*+]\s+)?\[[ xX]?\]?|<\/?\w*)\s*$/;

/** What of a text still arriving shows now (see `streaming`). */
const settled = (text: string) => {
	const lines = text.split(/\r?\n/);
	let partial = lines.pop() ?? '';
	// Inside an open fence, everything is code: only a fence being typed waits.
	let fenced = false;
	for (const line of lines)
		if (FENCE.test(line) || (fenced && /^\s*(`{3,}|~{3,})\s*$/.test(line))) fenced = !fenced;
	if (fenced) return [...lines, /^\s*[`~]{1,}$/.test(partial) ? '' : partial];
	if (MARKER_ONLY.test(partial) || /^\s*\|/.test(partial)) partial = '';
	else {
		const at = unclosedAt(partial);
		if (at !== -1) partial = partial.slice(0, at);
	}
	// A table's header row waits for its separator row.
	let end = lines.length;
	while (end > 0 && lines[end - 1]!.includes('|') && lines[end - 1]!.trim()) end--;
	const block = lines.slice(end);
	if (block.length && !block.some((line) => TABLE_SEPARATOR.test(line) && line.includes('-'))) {
		lines.length = end;
		partial = '';
	}
	return [...lines, partial];
};

/** `text` as blocks (see the module comment). */
export const textToBlocks = (
	text: string,
	{ markdown = true, type = 'paragraph', streaming = false }: TextToBlocksOptions = {}
): JSONBlock[] => {
	if (!markdown)
		return text
			.split(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/)
			.filter((part) => part.trim())
			.map((part) => ({ type, content: [{ text: part }] }));
	return parse(streaming ? settled(text) : text.split(/\r?\n/), type);
};
