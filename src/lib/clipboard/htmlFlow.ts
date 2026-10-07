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
/**
 * Where inline content goes: the line being read, and how a void kind's
 * element met inside it (an `<img>`, at any depth of inline markup) ends it
 * (`flow.html.void`).
 */
type Cursor = { line: () => Line; apart: (element: HTMLElement) => void };

/** Never content: their text is code, metadata or form state. */
const SKIP =
	/^(script|style|template|noscript|svg|math|iframe|object|embed|canvas|video|audio|img|input|button|select|textarea|head|title|meta|link|base)$/;
/** HTML's block-level elements: they start a line (a kind's tag does too). */
const BLOCK =
	/^(address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)$/;
/** The largest side, in CSS px, of an inline glyph image (an emoji, an icon, a tracking pixel). */
const GLYPH_PX = 32;
/** An alt made of emoji only (with their joiners, variation selectors and skin tones). */
const EMOJI_ALT =
	/^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\s]|\u200d|\ufe0f|\u20e3|\p{Emoji_Modifier})+$/u;
const sizeOf = (img: HTMLElement, side: 'width' | 'height') => {
	const value = img.getAttribute(side) ?? img.style.getPropertyValue(side);
	const px = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(value);
	return px ? Number(px[1]) : undefined;
};
/**
 * An inline glyph image (`flow.html.glyph`): an emoji drawn as an image (an
 * emoji-only alt, an `emoji` class or `data-emoji`, as X, Gmail, Slack and
 * WordPress write them), or an image no larger than a glyph (an icon, an
 * email's tracking pixel). It is text, its `alt`, never a block.
 */
const isGlyph = (node: Node): boolean => {
	if (!(node instanceof HTMLElement) || node.localName !== 'img') return false;
	const alt = node.getAttribute('alt')?.trim() ?? '';
	if (alt && EMOJI_ALT.test(alt) && /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(alt))
		return true;
	if (/emoji/i.test(node.className) || node.hasAttribute('data-emoji')) return true;
	const sides = [sizeOf(node, 'width'), sizeOf(node, 'height')].filter((n) => n !== undefined);
	return sides.length > 0 && sides.every((n) => n <= GLYPH_PX);
};
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
 * A void kind with a `parse` hook (an image, an embed, a video) is found
 * by its hook only, and a void takes only its `figcaption`'s text; an
 * `iframe`, `video` or `audio` no hook claims carries nothing. Unknown
 * elements degrade to text runs; whitespace collapses as HTML renders it. `null` when the HTML carries nothing (`flow.shape`, F-P10).
 */
export const flowOfHtml = (kinds: ImportKinds, html: string | undefined): Flow | null => {
	if (!html || html.length > 8 * 1024 * 1024 || typeof DOMParser === 'undefined') return null;
	const { blocks, marks } = kinds;
	const byTag = new Map<string, Claim>();
	for (const [type, kind] of blocks) {
		// A void found by its hook carries its substance in data (a source): its tag alone is none.
		if (!kind.presets?.length || (kind.void && kind.parse)) continue;
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
		// A glyph is text: no kind claims it.
		if (isGlyph(element)) return undefined;
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
	/** A void kind's element (an image): it shows no text, so a line it is met in ends there. */
	const isVoid = (node: Node): node is HTMLElement => {
		const claim = node instanceof HTMLElement ? kindOf(node) : undefined;
		return claim !== undefined && blocks.get(claim.type)?.void === true;
	};

	const text = (line: Line, value: string, marks: Values, pre: boolean) => {
		const last = line.content.at(-1) as JSONText | undefined;
		if (!pre) value = value.replace(/[ \t\n\f\r]+/g, ' ');
		if (!pre && (!last || /[ \n]$/.test(last.text))) value = value.replace(/^ /, '');
		value = value.replace(/\u00a0/g, ' ');
		if (!value) return;
		if (last && JSON.stringify(last.marks ?? {}) === JSON.stringify(marks)) last.text += value;
		else line.content.push(Object.keys(marks).length ? { text: value, marks } : { text: value });
	};
	const inline = (node: Node, at: Cursor, marks: Values, pre: boolean) => {
		if (node.nodeType === Node.TEXT_NODE)
			return text(at.line(), node.textContent ?? '', marks, pre);
		if (isGlyph(node))
			return text(at.line(), (node as HTMLElement).getAttribute('alt') ?? '', marks, pre);
		if (isVoid(node)) return at.apart(node);
		if (!(node instanceof HTMLElement) || SKIP.test(node.localName)) return;
		if (node.localName === 'br') return text(at.line(), '\n', marks, true);
		const inner = { ...marks, ...marksOf(node) };
		for (const child of node.childNodes) inline(child, at, inner, pre || node.localName === 'pre');
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
		const at: Cursor = {
			line: () => (run ??= { type, content: [] }),
			apart: (element) => {
				flush();
				lines.push(...blockOf(element, type));
			}
		};
		for (const node of parent.childNodes) {
			if (!isBlock(node)) inline(node, at, {}, false);
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
		// A void's only text is its caption: an `iframe`'s fallback, a `video`'s source list or
		// a bookmark's link text is never content.
		if (claim && blocks.get(claim.type)?.void) {
			const line: Line = { type: claim.type, data: claim.data, content: [] };
			const caption = [...element.children].find((child) => child.localName === 'figcaption');
			// A caption is one line: an element that would end it (an image) adds nothing.
			const at: Cursor = { line: () => line, apart: () => {} };
			for (const node of caption?.childNodes ?? []) inline(node, at, {}, false);
			return [end(line)];
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
		const pre = element.localName === 'pre';
		// The element's line, then, for each void element met in it, that block
		// and a line of the element's kind for what follows (`flow.html.void`).
		const parts: Line[] = [line];
		const texts = new Set([line]);
		let current = line;
		const at: Cursor = {
			line: () => current,
			apart: (inner) => {
				// A void's own media (a figure's `img`) is part of it.
				if (claim && blocks.get(claim.type)?.void) return;
				parts.push(...blockOf(inner, type));
				current = { type: line.type, data: line.data, content: [] };
				parts.push(current);
				texts.add(current);
			}
		};
		for (const node of element.childNodes)
			if (isVoid(node)) at.apart(node);
			else if (!isBlock(node)) inline(node, at, {}, pre);
			// A leading plain paragraph is the element's own text (`<li><p>Item</p></li>`).
			else if (
				!current.content.length &&
				!current.children?.length &&
				!kindOf(node) &&
				!wraps(node)
			)
				for (const child of node.childNodes) inline(child, at, {}, pre);
			else (current.children ??= []).push(...blockOf(node, childType));
		for (const part of texts) if (!part.children?.length) delete part.children;
		if (parts.length === 1) return [end(line)];
		// Split: a text line left empty around a void element is not kept.
		return parts.filter(
			(part) => !texts.has(part) || end(part).content.length > 0 || part.children !== undefined
		);
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
