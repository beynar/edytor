/**
 * A plain or markdown string as blocks — AI output, a suggestion's string
 * content (`edytor.suggestions`), a markdown file. Pure: no view, no
 * document, no DOM; Worker-safe.
 *
 * Plain (`markdown: false`): blank lines split paragraphs; a single newline
 * stays in the text. Markdown (the default) is parsed by
 * `@tanstack/markdown` (`parseMarkdown`, its serializable AST) and the AST
 * mapped to blocks: headings (deeper than `###` read as `###`), bulleted,
 * numbered and to-do items nested as the list nests, quotes (their first
 * paragraph their text), fenced code (its language in `data.language`),
 * GFM tables (a table whose first row is a header), dividers, a paragraph
 * holding only an image an image, and paragraphs (a soft break a space, a
 * hard break a newline). Inline: bold, italic, strike, code, links
 * (`[text](url)`, `<https://…>`; an href through the link sanitizer: a
 * `javascript:` URL is its text), nested. Raw HTML is never trusted: it
 * stays text.
 *
 * Edytor's own syntax is a TanStack extension each, not a second parser:
 * a GitHub alert (`> [!NOTE]`) is a callout (a leading emoji its icon),
 * `<details>`/`<summary>` a toggle, `$$ … $$` an equation, an autolink a
 * link, and, given `components`, an MDX-lite tag (`<Endpoint id="x" />`)
 * a block of the kind it names.
 *
 * `streaming: true` reads a text that is still arriving (a model's answer
 * so far): the last line, while it has no newline yet, is held back while
 * it is only a block marker (`#`, `-`, `1.`, a table row, a tag being
 * typed), and from an inline marker it has not closed yet (`**bol`); a
 * table's header row waits for its separator row; then TanStack's streaming
 * profile drops a trailing empty heading or list item. Each call then
 * shows only what will not change kind or marks when more arrives.
 */
import { parseMarkdown } from '@tanstack/markdown/parser';
import { streamingMarkdownExtension } from '@tanstack/markdown/extensions/streaming';
import type {
	BlockNode,
	BlockParseContext,
	ComponentNode,
	InlineNode,
	MarkdownExtension
} from '@tanstack/markdown';
import type { JSONBlock, JSONText, SerializableContent } from '../utils/json.js';
import { sanitizeLinkHref } from '../utils/sanitize.js';
import { safeImageSrc } from '../plugins/image/image.js';
import { tableBlock } from '../crdt/tables.js';

/** MDX-lite tags by name, each the kind it reads as: `{ Endpoint: 'endpoint' }`. */
export type MarkdownComponents = Readonly<Record<string, string>>;

/** A tag or line `fromMarkdown` kept as text, with why. */
export type MarkdownIssue = {
	/**
	 * `component`: a tag `components` does not name; `expression`: an
	 * attribute whose value is not a string, a number, `true` or `false`
	 * (`{a + b}`, `{...props}`); `unclosed`: a tag without its closing tag;
	 * `import` / `export`: an MDX import or export line.
	 */
	reason: 'component' | 'expression' | 'unclosed' | 'import' | 'export';
	/** The line kept as text. */
	source: string;
	/** The tag's name, for a tag. */
	name?: string;
};

export type MarkdownOptions = {
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
	/**
	 * MDX-lite: the tags to read, each as the kind it names
	 * (`{ Endpoint: 'endpoint', Callout: 'callout' }`). Literal attributes
	 * (`"text"`, `{1}`, `{true}`) become the block's data; the tag's
	 * markdown its text (one line) or its text and children (lines).
	 */
	components?: MarkdownComponents;
	/** Told of each tag, expression, import or export kept as text. */
	onUnknown?: (issue: MarkdownIssue) => void;
};

type Marks = Record<string, SerializableContent>;
type Data = Record<string, SerializableContent>;

/** The data a component node carries, typed (a node's `attributes` are strings). */
const dataOf = new WeakMap<object, Data>();
/** The components of Edytor's own syntax: their names cannot be a tag's (`:`). */
const CALLOUT = 'edytor:callout';
const TOGGLE = 'edytor:toggle';
const EQUATION = 'edytor:equation';

const component = (name: string, data: Data, children: BlockNode[]): ComponentNode => {
	const node: ComponentNode = {
		type: 'component',
		name,
		attributes: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
		children
	};
	dataOf.set(node, data);
	return node;
};

/** The lines from `from` up to the closing line `close` matches (nesting by `open`), and where it is. */
const blockUntil = (
	lines: string[],
	from: number,
	close: RegExp,
	open?: RegExp
): { body: string[]; end: number } => {
	let depth = 0;
	for (let i = from; i < lines.length; i++) {
		const line = lines[i]!;
		if (close.test(line)) {
			if (depth === 0) return { body: lines.slice(from, i), end: i };
			depth--;
		} else if (open?.test(line)) depth++;
	}
	return { body: lines.slice(from), end: -1 };
};

/** `<https://…>` and `<mailto:…>` autolinks (the parser keeps them as text). */
const autolinks: MarkdownExtension = {
	name: 'edytor-autolinks',
	inlineParser: {
		markers: '<',
		parse(context) {
			if (context.inLink) return undefined;
			const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(context.source.slice(context.index));
			if (!auto) return undefined;
			return {
				node: { type: 'link', href: auto[1]!, children: [{ type: 'text', value: auto[1]! }] },
				length: auto[0].length
			};
		}
	}
};

const ALERT = /^ {0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const ICON = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s+/u;

/** A GitHub alert as a callout, a leading emoji on its first line its icon. */
const callouts: MarkdownExtension = {
	name: 'edytor-callouts',
	parseBlock(context) {
		if (!ALERT.test(context.lines[context.index] ?? '')) return undefined;
		const body: string[] = [];
		let i = context.index + 1;
		for (; i < context.lines.length; i++) {
			const quoted = /^ {0,3}>\s?(.*)$/.exec(context.lines[i]!);
			if (!quoted) break;
			body.push(quoted[1]!);
		}
		context.consume(i - context.index);
		const icon = ICON.exec(body[0] ?? '');
		if (icon) body[0] = body[0]!.slice(icon[0].length);
		return component(CALLOUT, icon ? { icon: icon[1]! } : {}, context.parseBlocks(body.join('\n')));
	}
};

/** A to-do box without its bullet (`[ ] task`) as a to-do item, as the editor's paste reads it. */
const bareTodos: MarkdownExtension = {
	name: 'edytor-bare-todos',
	parseBlock(context) {
		const todo = /^\[([ xX])\]\s+(.*)$/.exec(context.lines[context.index] ?? '');
		if (!todo) return undefined;
		context.consume(1);
		const children: BlockNode[] = [{ type: 'paragraph', children: context.parseInline(todo[2]!) }];
		return {
			type: 'list',
			ordered: false,
			items: [{ type: 'listItem', checked: todo[1] !== ' ', children }]
		};
	}
};

const DETAILS = /^\s*<details>\s*$/i;
const DETAILS_END = /^\s*<\/details>\s*$/i;
const SUMMARY = /^\s*<summary>(?:<(h[1-6])>)?(.*?)(?:<\/h[1-6]>)?<\/summary>\s*$/i;

/** `<details>` and its `<summary>` as a toggle (a `<summary><h2>` a toggle heading). */
const details: MarkdownExtension = {
	name: 'edytor-details',
	parseBlock(context) {
		if (!DETAILS.test(context.lines[context.index] ?? '')) return undefined;
		const { body, end } = blockUntil(context.lines, context.index + 1, DETAILS_END, DETAILS);
		context.consume((end === -1 ? context.lines.length : end + 1) - context.index);
		const first = body.findIndex((line) => line.trim());
		const summary = first === -1 ? null : SUMMARY.exec(body[first]!);
		const level = summary?.[1]?.toLowerCase();
		const data: Data = level ? { level: level === 'h1' || level === 'h2' ? level : 'h3' } : {};
		const head: BlockNode[] = summary
			? [{ type: 'paragraph', children: context.parseInline(summary[2]!) }]
			: [];
		if (summary) body.splice(first, 1);
		if (summary) data.summary = true;
		return component(TOGGLE, data, [...head, ...context.parseBlocks(body.join('\n'))]);
	}
};

/** `$$` … `$$` lines as an equation (an unclosed one runs to the end: a stream cut mid-block). */
const equations: MarkdownExtension = {
	name: 'edytor-equations',
	parseBlock(context) {
		if (!/^\s*\$\$\s*$/.test(context.lines[context.index] ?? '')) return undefined;
		const { body, end } = blockUntil(context.lines, context.index + 1, /^\s*\$\$\s*$/);
		context.consume((end === -1 ? context.lines.length : end + 1) - context.index);
		return component(EQUATION, { expression: body.join('\n').trim() }, []);
	}
};

/** An MDX-lite opening tag's parts, or why it is text. */
type Tag =
	| { name: string; data: Data; selfClosing: boolean; rest: string }
	| { name: string; issue: 'expression' };

/** The tag opening `line` (`<Name a="x" b={1} c>`), its literal attributes as data. */
const openingTag = (line: string): Tag | null => {
	const head = /^\s*<([A-Z][\w.]*)/.exec(line);
	if (!head) return null;
	const name = head[1]!;
	const data: Data = {};
	let i = head[0].length;
	for (;;) {
		const space = /^\s*/.exec(line.slice(i))![0];
		i += space.length;
		if (line.startsWith('/>', i))
			return { name, data, selfClosing: true, rest: line.slice(i + 2).trim() };
		if (line[i] === '>') return { name, data, selfClosing: false, rest: line.slice(i + 1) };
		const attr = space || i === head[0].length ? /^[A-Za-z_][\w:-]*/.exec(line.slice(i)) : null;
		if (!attr) return { name, issue: 'expression' };
		i += attr[0].length;
		if (line[i] !== '=') {
			data[attr[0]] = true;
			continue;
		}
		i++;
		const quote = line[i];
		if (quote === '"' || quote === "'") {
			const close = line.indexOf(quote, i + 1);
			if (close === -1) return { name, issue: 'expression' };
			data[attr[0]] = line.slice(i + 1, close);
			i = close + 1;
			continue;
		}
		const literal = /^\{\s*(true|false|-?\d+(?:\.\d+)?)\s*\}/.exec(line.slice(i));
		if (!literal) return { name, issue: 'expression' };
		data[attr[0]] =
			literal[1] === 'true' ? true : literal[1] === 'false' ? false : Number(literal[1]);
		i += literal[0].length;
	}
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * MDX-lite: a tag `components` names as a component node; any other tag,
 * an expression, an import or an export declines (the parser keeps the
 * line as text) and is reported.
 */
const mdx = (
	components: MarkdownComponents,
	report: (issue: MarkdownIssue) => void,
	streaming: boolean
): MarkdownExtension => ({
	name: 'edytor-mdx',
	parseBlock(context: BlockParseContext) {
		const line = context.lines[context.index] ?? '';
		const statement = /^(import|export)\s/.exec(line);
		if (statement) {
			report({ reason: statement[1] as 'import' | 'export', source: line });
			return undefined;
		}
		const tag = openingTag(line);
		if (!tag) return undefined;
		if (!Object.hasOwn(components, tag.name)) {
			report({ reason: 'component', name: tag.name, source: line });
			return undefined;
		}
		if ('issue' in tag) {
			report({ reason: tag.issue, name: tag.name, source: line });
			return undefined;
		}
		const closing = `</${tag.name}>`;
		if (tag.selfClosing || tag.rest.trimEnd().endsWith(closing)) {
			if (tag.selfClosing && tag.rest) return undefined;
			context.consume(1);
			const text = tag.selfClosing ? '' : tag.rest.trimEnd().slice(0, -closing.length).trim();
			const children: BlockNode[] = text
				? [{ type: 'paragraph', children: context.parseInline(text) }]
				: [];
			return component(tag.name, tag.data, children);
		}
		if (tag.rest.trim()) {
			report({ reason: 'unclosed', name: tag.name, source: line });
			return undefined;
		}
		const name = escapeRegExp(tag.name);
		const { body, end } = blockUntil(
			context.lines,
			context.index + 1,
			new RegExp(`^\\s*</${name}>\\s*$`),
			new RegExp(`^\\s*<${name}(?:\\s[^>]*)?>\\s*$`)
		);
		if (end === -1 && !streaming) {
			report({ reason: 'unclosed', name: tag.name, source: line });
			return undefined;
		}
		context.consume((end === -1 ? context.lines.length : end + 1) - context.index);
		return component(tag.name, tag.data, context.parseBlocks(body.join('\n')));
	}
});

/** Inline nodes as text runs, `marks` on every run (nested marks add up), equal runs merged. */
const inline = (nodes: InlineNode[], cell = false): JSONText[] => {
	const out: JSONText[] = [];
	const push = (value: string, marks: Marks) => {
		if (!value) return;
		const last = out.at(-1);
		if (last && JSON.stringify(last.marks ?? {}) === JSON.stringify(marks)) last.text += value;
		else out.push(Object.keys(marks).length ? { text: value, marks } : { text: value });
	};
	const walk = (nodes: InlineNode[], marks: Marks) => {
		for (const node of nodes)
			switch (node.type) {
				case 'text': {
					const text = node.value.replace(/\n/g, ' ');
					push(cell ? text.replace(/<br\s*\/?>/gi, '\n') : text, marks);
					break;
				}
				case 'inlineCode':
					push(node.value, { ...marks, code: true });
					break;
				case 'strong':
					walk(node.children, { ...marks, bold: true });
					break;
				case 'emphasis':
					walk(node.children, { ...marks, italic: true });
					break;
				case 'strike':
					walk(node.children, { ...marks, strike: true });
					break;
				case 'link': {
					const href = sanitizeLinkHref(node.href);
					walk(node.children, href ? { ...marks, link: { href } } : marks);
					break;
				}
				case 'image':
					push(node.alt, marks);
					break;
				case 'break':
					push('\n', marks);
					break;
				case 'inlineHtml':
					push(node.value, marks);
					break;
				case 'footnoteReference':
					push(`[^${node.id}]`, marks);
					break;
				case 'inlineComponent':
					walk(node.children, marks);
					break;
			}
	};
	walk(nodes, {});
	const last = out.at(-1);
	if (last && !last.marks) last.text = last.text.replace(/ +$/, '');
	if (last && !last.text) out.pop();
	if (!out.length) out.push({ text: '' });
	return out;
};

/** A code block's language as stored: a short name, else none. */
const languageOf = (name: string | undefined) =>
	name && /^[\w#+.-]{1,40}$/.test(name) ? name : undefined;

/** The mapping's settings: the paragraph kind and the components by name. */
type Reading = { type: string; components: MarkdownComponents };

/** A container's blocks as its own text (a leading paragraph's) and its children. */
const split = (blocks: JSONBlock[], reading: Reading) => {
	const first = blocks[0]?.type === reading.type ? blocks.shift()! : undefined;
	return { content: first?.content ?? [], children: blocks };
};
const withChildren = (block: JSONBlock, children: JSONBlock[]): JSONBlock =>
	children.length ? { ...block, children } : block;

/** AST blocks as Edytor blocks. */
const blocks = (nodes: BlockNode[], reading: Reading): JSONBlock[] =>
	nodes.flatMap((node) => block(node, reading));

const block = (node: BlockNode, reading: Reading): JSONBlock[] => {
	switch (node.type) {
		case 'heading':
			return [
				{
					type: 'heading',
					data: { level: `h${Math.min(3, node.depth)}` },
					content: inline(node.children)
				}
			];
		case 'paragraph': {
			const only = node.children.filter((child) => child.type !== 'text' || child.value.trim());
			const image = only.length === 1 && only[0]!.type === 'image' ? only[0] : null;
			// A safe source, or a relative one (a markdown file's own `./cover.png`).
			const src = image && (safeImageSrc(image.src) ?? (/^[^:]*$/.test(image.src) && image.src));
			if (image && src)
				return [
					{
						type: 'image',
						data: { src, ...(image.alt && { alt: image.alt }) },
						content: image.title ? [{ text: image.title }] : []
					}
				];
			return [{ type: reading.type, content: inline(node.children) }];
		}
		case 'code': {
			const language = languageOf(node.lang);
			return [
				{
					type: 'code',
					...(language && { data: { language } }),
					content: [],
					children: node.value
						? node.value.split('\n').map((text) => ({ type: 'codeLine', content: [{ text }] }))
						: []
				}
			];
		}
		case 'list':
			return node.items.map((item) => {
				const { content, children } = split(blocks(item.children, reading), reading);
				const own: JSONBlock =
					item.checked !== undefined
						? { type: 'todo-item', data: { checked: item.checked }, content }
						: { type: node.ordered ? 'numbered-list-item' : 'bulleted-list-item', content };
				return withChildren(own, children);
			});
		case 'blockquote': {
			const { content, children } = split(blocks(node.children, reading), reading);
			return [withChildren({ type: 'quote', content }, children)];
		}
		case 'table': {
			const cells = [node.header, ...node.rows].map((row) =>
				row.map((cell) => {
					const runs = inline(cell.children, true);
					return runs.length === 1 && !runs[0]!.text ? '' : runs;
				})
			);
			return [tableBlock({ cells, headerRow: true })];
		}
		case 'thematicBreak':
			return [{ type: 'divider', content: [] }];
		case 'html':
			return [{ type: reading.type, content: [{ text: node.value }] }];
		case 'footnotes':
			return node.items.flatMap((item) => {
				const inner = blocks(item.children, reading);
				const head = inner[0]?.type === reading.type ? inner.shift()! : null;
				const label = { text: `[^${item.id}]: ` };
				return [{ type: reading.type, content: [label, ...(head?.content ?? [])] }, ...inner];
			});
		case 'callout':
			return [withChildren({ type: 'callout', content: [] }, blocks(node.children, reading))];
		case 'component': {
			const data = dataOf.get(node) ?? node.attributes;
			const inner = blocks(node.children, reading);
			if (node.name === EQUATION) return [{ type: 'equation', data, content: [] }];
			if (node.name === TOGGLE) {
				const { summary, ...rest } = data;
				const head = summary ? inner.shift() : undefined;
				const level = Object.keys(rest).length ? { data: rest } : {};
				return [
					withChildren(
						{
							type: rest.level ? 'toggle-heading' : 'toggle',
							...level,
							content: head?.content ?? []
						},
						inner
					)
				];
			}
			const type = node.name === CALLOUT ? 'callout' : reading.components[node.name]!;
			const { content, children } = split(inner, reading);
			const own: JSONBlock = Object.keys(data).length ? { type, data, content } : { type, content };
			return [withChildren(own, children)];
		}
	}
};

// ——— Streaming: what of a text still arriving shows now ———

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

/** The index after a link's `](dest "title")` starting at `at` (`(`); else -1. */
const destinationEnd = (text: string, at: number) => {
	let depth = 0;
	for (let i = at + 1; i < text.length; i++) {
		const c = text[i];
		if (c === '\\') i++;
		else if (c === '(') depth++;
		else if (c === ')' && depth-- === 0) return i + 1;
	}
	return -1;
};

/** The `]` closing the link label opened at `at` (`[`), skipping escapes; or -1. */
const labelEnd = (text: string, at: number) => {
	let depth = 0;
	for (let i = at + 1; i < text.length; i++) {
		const c = text[i];
		if (c === '\\') i++;
		else if (c === '[') depth++;
		else if (c === ']' && depth-- === 0) return i;
	}
	return -1;
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
				const to = destinationEnd(line, end + 1);
				if (to === -1) return open[0]?.at ?? i;
				i = to;
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

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/**
 * A line that is only a block marker so far: `#`, `-`, `1.`, `>`, a
 * fence's backticks, a to-do box, a tag being typed (`<Endpoint id="a`).
 */
const MARKER_ONLY =
	/^\s*(?:#{1,6}|[-*+]|\d+[.)]?|>|`{1,2}|~{1,2}|\$\$?|(?:[-*+]\s+)?\[[ xX]?\]?|<\/?[A-Za-z]?[^>]*)\s*$/;

/** What of a text still arriving shows now (see `streaming`). */
const settled = (text: string) => {
	const lines = text.split(/\r?\n/);
	let partial = lines.pop() ?? '';
	// Inside an open fence, everything is code: only a fence being typed waits.
	let fenced = false;
	for (const line of lines)
		if (FENCE.test(line) || (fenced && /^\s*(`{3,}|~{3,})\s*$/.test(line))) fenced = !fenced;
	if (fenced) return [...lines, /^\s*[`~]{1,}$/.test(partial) ? '' : partial].join('\n');
	if (MARKER_ONLY.test(partial) || /^\s*\|/.test(partial)) partial = '';
	else {
		const at = unclosedAt(partial);
		if (at !== -1) partial = partial.slice(0, at);
	}
	// A table's header row waits for its separator row.
	let end = lines.length;
	while (end > 0 && lines[end - 1]!.includes('|') && lines[end - 1]!.trim()) end--;
	const rows = lines.slice(end);
	if (rows.length && !rows.some((line) => TABLE_SEPARATOR.test(line) && line.includes('-'))) {
		lines.length = end;
		partial = '';
	}
	return [...lines, partial].join('\n');
};

/**
 * A line ending in two spaces as one ending in `\\` (both a hard break in
 * CommonMark; the parser reads only the backslash), outside fenced code.
 */
const hardBreaks = (text: string) => {
	let fenced = false;
	return text
		.split(/\r?\n/)
		.map((line, i, lines) => {
			if (FENCE.test(line) || (fenced && /^\s*(`{3,}|~{3,})\s*$/.test(line))) fenced = !fenced;
			return !fenced && /\S {2,}$/.test(line) && lines[i + 1]?.trim()
				? `${line.trimEnd()}\\`
				: line;
		})
		.join('\n');
};

const STREAMING = streamingMarkdownExtension();
const OWN = [autolinks, callouts, details, equations, bareTodos];

/** `text` as blocks (see the module comment). */
export const textToBlocks = (
	text: string,
	{
		markdown = true,
		type = 'paragraph',
		streaming = false,
		components,
		onUnknown
	}: MarkdownOptions = {}
): JSONBlock[] => {
	if (!markdown)
		return text
			.split(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/)
			.filter((part) => part.trim())
			.map((part) => ({ type, content: [{ text: part }] }));
	const extensions = [...OWN];
	if (components || onUnknown)
		extensions.unshift(mdx(components ?? {}, onUnknown ?? (() => {}), streaming));
	if (streaming) extensions.push(STREAMING);
	const document = parseMarkdown(hardBreaks(streaming ? settled(text) : text), {
		extensions,
		headingIds: false
	});
	return blocks(document.children, { type, components: components ?? {} });
};
