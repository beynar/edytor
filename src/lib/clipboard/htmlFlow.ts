import type { Edytor } from '$lib/edytor.svelte.js';
import type { Flow } from '$lib/crdt/flow.js';
import type { BlockDefinition } from '$lib/plugins.js';
import type { JSONContentPart } from '$lib/block/contentRange.js';
import {
	jsonBlockToSpec,
	type JSONBlock,
	type JSONText,
	type SerializableContent
} from '$lib/utils/json.js';

/** What HTML import reads: the kind and mark records, and the document's default child. */
export type ImportKinds = Pick<Edytor, 'blocks' | 'marks'> & {
	document: Pick<Edytor['document'], 'defaultChild'>;
};

type Values = Record<string, SerializableContent>;
type Line = { type?: string; data?: Values; content: JSONContentPart[]; children?: Line[] };
/** A kind claiming an element; `lines`: a container whose default child takes each text line. */
type Claim = { type: string; data: Values; lines?: string };

/** Never content: their text is code, metadata or form state. */
const SKIP =
	/^(script|style|template|noscript|svg|math|iframe|object|embed|canvas|video|audio|img|input|button|select|textarea|head|title|meta|link|base)$/;
/** HTML's block-level elements: they start a line (a kind's tag does too). */
const BLOCK =
	/^(address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)$/;
/** Tags that carry no meaning of their own: a kind rendering one is not found by it. */
const GENERIC = /^(div|span)$/;

/** The tag a kind writes for `data`: its export form's first tag, else its element's, else its content element's. */
export const tagOf = (type: string, kind: BlockDefinition, data: Values) => {
	const { html, element, contentElement } = kind;
	if (typeof html === 'string') return html;
	try {
		if (html) return /^<([a-z][\w-]*)/i.exec(html({ type, data }, '', ''))?.[1]?.toLowerCase();
	} catch {
		return undefined;
	}
	for (const declared of [element, contentElement]) {
		const form = typeof declared === 'function' ? declared(data) : declared;
		const tag = typeof form === 'string' ? form : form?.tag;
		if (tag && !GENERIC.test(tag)) return tag;
	}
	return undefined;
};

/**
 * External HTML as a flow (P4.1): the browser parses (inert: no script
 * runs, nothing loads), and the tag tables are the records inverted — a
 * catalogue kind's tag per preset (a content-less container takes its
 * default child's tag, one child per text line), a value-less mark's
 * `tag`, and each record's `parse` hook first (aliases, sanitized values).
 * Unknown elements degrade to text runs; whitespace collapses as HTML
 * renders it. `null` when the HTML carries nothing (`flow.shape`, F-P10).
 */
export const flowOfHtml = (kinds: ImportKinds, html: string | undefined): Flow | null => {
	if (!html || html.length > 8 * 1024 * 1024 || typeof DOMParser === 'undefined') return null;
	const { blocks, marks } = kinds;
	const byTag = new Map<string, Claim>();
	for (const [type, kind] of blocks) {
		if (!kind.presets?.length) continue;
		for (const { data = {} } of kind.presets) {
			const tag = tagOf(type, kind, data);
			if (tag && !byTag.has(tag)) byTag.set(tag, { type, data });
		}
		const child = kind.rendersContent === false ? kind.defaultChild : undefined;
		const tag = child && blocks.has(child) ? tagOf(child, blocks.get(child)!, {}) : undefined;
		if (tag && !byTag.has(tag))
			byTag.set(tag, { type, data: kind.presets[0]!.data ?? {}, lines: child });
	}
	const kindOf = (element: HTMLElement): Claim | undefined => {
		for (const [type, kind] of blocks) {
			const data = kind.parse?.(element);
			if (data) return { type, data };
		}
		return byTag.get(element.localName);
	};
	const marksOf = (element: HTMLElement) => {
		const found: Values = {};
		for (const [name, mark] of marks) {
			const value =
				mark.parse?.(element) ??
				(!mark.attributes && mark.tag === element.localName ? true : undefined);
			if (value != null && value !== false) found[name] = value;
		}
		return found;
	};
	const isBlock = (node: Node): node is HTMLElement =>
		node instanceof HTMLElement && (BLOCK.test(node.localName) || kindOf(node) !== undefined);

	const text = (line: Line, value: string, marks: Values, pre: boolean) => {
		const last = line.content.at(-1) as JSONText | undefined;
		if (!pre) value = value.replace(/[ \t\n\f\r]+/g, ' ');
		if (!pre && (!last || /[ \n]$/.test(last.text))) value = value.replace(/^ /, '');
		value = value.replace(/\u00a0/g, ' ');
		if (!value) return;
		if (last && JSON.stringify(last.marks ?? {}) === JSON.stringify(marks)) last.text += value;
		else line.content.push(Object.keys(marks).length ? { text: value, marks } : { text: value });
	};
	const inline = (node: Node, line: Line, marks: Values, pre: boolean) => {
		if (node.nodeType === Node.TEXT_NODE) return text(line, node.textContent ?? '', marks, pre);
		if (!(node instanceof HTMLElement) || SKIP.test(node.localName)) return;
		if (node.localName === 'br') return text(line, '\n', marks, true);
		const inner = { ...marks, ...marksOf(node) };
		for (const child of node.childNodes)
			inline(child, line, inner, pre || node.localName === 'pre');
	};
	/** A line ends without its trailing space or `<br>`. */
	const end = (line: Line) => {
		const last = line.content.at(-1) as JSONText | undefined;
		if (last) last.text = last.text.replace(/ ?\n?$/, '');
		if (last && !last.text) line.content.pop();
		return line;
	};
	/** `parent`'s children as lines: its blocks, and runs of the inline nodes between them. */
	const linesOf = (parent: Node, type: string | undefined): Line[] => {
		const lines: Line[] = [];
		let run: Line | null = null;
		const flush = () => {
			if (run && end(run).content.length) lines.push(run);
			run = null;
		};
		for (const node of parent.childNodes) {
			if (!isBlock(node)) inline(node, (run ??= { type, content: [] }), {}, false);
			else {
				flush();
				lines.push(...blockOf(node, type));
			}
		}
		flush();
		return lines;
	};
	const blockOf = (element: HTMLElement, type: string | undefined): Line[] => {
		const claim = kindOf(element);
		if (claim?.lines) {
			const rows = (element.textContent ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
			const children = rows.split('\n').map((row) => ({
				type: claim.lines,
				content: row ? [{ text: row }] : []
			}));
			return [{ type: claim.type, data: claim.data, content: [], children }];
		}
		// A kind that shows no text of its own (a list, a layout, a column) takes none: its
		// inline runs and a leading paragraph are lines of its default child, never hidden text.
		if (claim && blocks.get(claim.type)?.rendersContent === false) {
			const children = linesOf(element, kinds.document.defaultChild(claim.type));
			return [
				{ type: claim.type, data: claim.data, content: [], ...(children.length && { children }) }
			];
		}
		const wraps = (element: HTMLElement) => [...element.children].some(isBlock);
		// An element that only wraps blocks (a `div`, a `ul`) is not a line of its own.
		if (!claim && wraps(element)) return linesOf(element, type);
		const line: Line = { type: claim?.type ?? type, data: claim?.data, content: [] };
		const childType = claim ? kinds.document.defaultChild(claim.type) : type;
		const children: Line[] = [];
		const pre = element.localName === 'pre';
		for (const node of element.childNodes)
			if (!isBlock(node)) inline(node, line, {}, pre);
			// A leading plain paragraph is the element's own text (`<li><p>Item</p></li>`).
			else if (!line.content.length && !children.length && !kindOf(node) && !wraps(node))
				for (const child of node.childNodes) inline(child, line, {}, pre);
			else children.push(...blockOf(node, childType));
		if (children.length) line.children = children;
		return [end(line)];
	};

	const body = new DOMParser().parseFromString(html, 'text/html').body;
	const lines = linesOf(body, undefined);
	const carries = (line: Line): boolean =>
		line.content.length > 0 ||
		Boolean(line.children?.some(carries)) ||
		Boolean(line.type && blocks.get(line.type)?.void);
	return lines.some(carries)
		? { lines: lines.map((line) => jsonBlockToSpec(line as JSONBlock, true)) }
		: null;
};
