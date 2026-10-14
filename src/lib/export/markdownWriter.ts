/**
 * Blocks as Markdown (`toMarkdown`): each block by its kind's `markdown`
 * form (else its `plain` form, else its text), text by its marks' and
 * atoms' forms. The export's alone: a view ships none of it.
 */
import type { JSONBlock } from '$lib/utils/json.js';
import type { MarkdownContext } from '$lib/plugins.js';
import { isTextPart } from '$lib/block/contentRange.js';
import type { JSONContentPart } from '$lib/clipboard/types.js';
import {
	contentOf,
	type ExportKinds,
	type MarkForms
} from '$lib/clipboard/serializeClipboardFragment.js';

/** Characters markdown reads as syntax inside a line: escaped in exported text. */
const MD_SPECIAL = /[\\`*_[\]~<]/g;
/** A line start markdown reads as a block (a heading, a list item, a quote, a rule): escaped. */
const MD_LINE_START = /^(\s*)(#{1,6}(?=\s|$)|[-+](?=\s)|\d+(?=[.)]\s)|>|=+\s*$|-{3,}\s*$)/;

/** Text as markdown: its syntax characters escaped, a soft break a hard break (`\` + newline). */
const escapeMarkdown = (text: string) =>
	text.replace(MD_SPECIAL, (c) => `\\${c}`).replace(/\n/g, '\\\n');

/** The delimiters a mark's value exports as, or none. */
const delimitersOf = (mark: MarkForms, value: unknown) =>
	typeof mark.markdown === 'function' ? mark.markdown(value) : mark.markdown;

/** A code span's fence: one backtick more than the longest run inside it. */
const codeFence = (text: string) =>
	'`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);

/**
 * Rich text as inline markdown. Marks open in their registration order
 * reversed (the first registered innermost, as HTML wraps them), a mark
 * spanning several runs opens once (`**a *b***`), a mark without a
 * `markdown` form is left out, and a delimiter never sits on a space
 * (`** x**` is no emphasis): the spaces move outside it.
 */
const inlineMarkdown = (content: JSONContentPart[] = [], kinds: ExportKinds) => {
	// A code span holds no markup: it opens last, innermost.
	const order = [...kinds.marks.keys()]
		.reverse()
		.sort((a, b) => Number(a === 'code') - Number(b === 'code'));
	/** The open marks, outermost first: name, value key and closing delimiter. */
	const open: { name: string; key: string; close: string }[] = [];
	let out = '';
	const closeTo = (depth: number) => {
		// A delimiter closes after the text's last non-space: trailing spaces move out.
		const spaces = /[ \t]*$/.exec(out)![0];
		out = out.slice(0, out.length - spaces.length);
		while (open.length > depth) out += open.pop()!.close;
		out += spaces;
	};
	for (const part of content) {
		if (!isTextPart(part)) {
			closeTo(0);
			const atom = kinds.inlineBlocks.get(part.type);
			out += atom?.markdown?.(part.data) ?? escapeMarkdown(atom?.plain?.(part.data) ?? '');
			continue;
		}
		const wanted = order
			.map((name) => {
				const mark = kinds.marks.get(name)!;
				const value = part.marks?.[name];
				const delimiters = value ? delimitersOf(mark, value) : undefined;
				return delimiters && { name, key: JSON.stringify(value), delimiters };
			})
			.filter((m) => !!m);
		// Keep the open marks this run still has, in order; close from the first it lacks.
		let keep = 0;
		while (
			keep < open.length &&
			wanted.some((m) => m.name === open[keep]!.name && m.key === open[keep]!.key)
		)
			keep++;
		// A mark opening inside an open code span would be literal: the span closes first.
		const opening = wanted.some((m) => !open.slice(0, keep).some((o) => o.name === m.name));
		const span = open.findIndex((m) => m.name === 'code');
		if (opening && span !== -1 && span < keep) keep = span;
		closeTo(keep);
		const code = wanted.some((m) => m.name === 'code');
		const raw = part.text;
		const lead = /^[ \t]*/.exec(raw)![0];
		const body = raw.slice(lead.length);
		out += lead;
		if (!body) continue;
		for (const mark of wanted)
			if (!open.some((m) => m.name === mark.name)) {
				const [start, end] = mark.delimiters;
				const fence = mark.name === 'code' ? codeFence(body) : '';
				const pad = fence && /^`|`$/.test(body) ? ' ' : '';
				out += fence ? fence + pad : start;
				open.push({ name: mark.name, key: mark.key, close: fence ? pad + fence : end });
			}
		out += code ? body : escapeMarkdown(body);
	}
	closeTo(0);
	return out;
};

/** Every line of `text` prefixed with `prefix` (an empty line with its trimmed form). */
const indent = (text: string, prefix: string) =>
	text
		.split('\n')
		.map((line) => (line ? prefix + line : prefix.trimEnd()))
		.join('\n');

/** A list item's markdown (`- `, `1. `, `- [ ] `): its block's first line starts one. */
const LIST_LINE = /^(?:[-*+]|\d+[.)])\s/;

/**
 * Sibling blocks as markdown: a blank line between blocks, a single
 * newline between items of one list (a tight list).
 */
const siblingsMarkdown = (blocks: JSONBlock[], kinds: ExportKinds) => {
	let out = '';
	let previous: string | null = null;
	let run = 0;
	let type: string | null = null;
	for (const block of blocks) {
		run = block.type === type ? run + 1 : 1;
		type = block.type;
		const md = blockMarkdown(block, kinds, run);
		if (!md) continue;
		if (previous !== null) out += LIST_LINE.test(previous) && LIST_LINE.test(md) ? '\n' : '\n\n';
		out += md;
		previous = md;
	}
	return out;
};

/** A block and its subtree as markdown, by its kind's form. */
const blockMarkdown = (block: JSONBlock, kinds: ExportKinds, index: number): string => {
	const kind = kinds.blocks.get(block.type);
	const content = inlineMarkdown(block.content, kinds);
	const children = siblingsMarkdown(block.children ?? [], kinds);
	if (kind?.markdown) {
		const context: MarkdownContext = {
			index,
			indent,
			inline: (parts) => inlineMarkdown(parts, kinds)
		};
		return kind.markdown(block, content, children, context);
	}
	if (kind?.plain) {
		const plain = kind.plain(block, contentOf(block.content, kinds, false), '');
		return [plain && escapeMarkdown(plain), children].filter(Boolean).join('\n\n');
	}
	// A paragraph: its text, a leading block marker escaped (`\# not a heading`).
	const text = content.replace(MD_LINE_START, (_, space: string, marker: string) =>
		/^\d/.test(marker) ? `${space}${marker}\\` : `${space}\\${marker}`
	);
	return [text, children].filter(Boolean).join('\n\n');
};

/** Blocks as markdown (`toMarkdown`), by each kind's, mark's and atom's `markdown` form. */
export const blocksToMarkdown = (blocks: JSONBlock[], kinds: ExportKinds) =>
	siblingsMarkdown(blocks, kinds);
