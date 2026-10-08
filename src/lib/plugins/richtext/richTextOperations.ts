import type { Edytor } from '$lib/edytor.svelte.js';
import { isRecord, type JSONText, type SerializableContent } from '$lib/utils/json.js';
import type { Prepared } from '$lib/crdt/edytor-doc.js';
import type { BlockSpec } from '$lib/crdt/index.js';
import type { Text } from '$lib/text/text.svelte.js';
import { dispatchPlan } from '$lib/block/block.utils.js';
import { holdsNothing, lineage, placing } from '$lib/kinds.js';
import { id } from '$lib/utils.js';
import { marksForInsertion } from '$lib/session/editing/text.js';
import { selectedTextSpans, viewOf } from '$lib/selection/visibility.js';

export type RichTextMark =
	| 'bold'
	| 'italic'
	| 'underline'
	| 'code'
	| 'link'
	| 'strike'
	| 'superscript'
	| 'subscript'
	| 'color'
	| 'highlight';

export type RichTextLink = {
	href: string;
	target?: string;
};

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * CSS-color sanitizer for `color`/`highlight` marks. The value lands in
 * `style="color: {value}"` — a `;`/`{`/`}` payload escapes the property
 * and injects arbitrary declarations (`url()` exfil, `position:fixed`
 * overlays). Metacharacters, escape/obfuscation sequences, and
 * resource-loading functions are rejected; real `<color>` values
 * (`#hex`, `rgb()/hsl()/oklch()/color-mix()/var()`, named colors) pass.
 */
export const sanitizeCssColorValue = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 128) return null;
	if (/[;{}<>\\'"`]/.test(trimmed) || /url\s*\(|expression\s*\(|\/\*|\*\//i.test(trimmed)) {
		return null;
	}
	return trimmed;
};

/**
 * Scheme allowlist for link hrefs. `javascript:`/`data:`/`vbscript:`
 * payloads can arrive through native `insertLink`, pasted HTML, or a
 * malicious collaborator — and Svelte renders `href` verbatim. The href is
 * read as the browser's URL parser reads it: it strips C0 controls and
 * spaces at both ends and tab/newline/CR anywhere (`\u0001javascript:` is
 * `javascript:` to a browser), then resolves it against a base; only an
 * allowed scheme, or a relative href that stays relative, passes.
 */
export const sanitizeLinkHref = (href: unknown): string | null => {
	// Marks arrive from untrusted sources too (synced peers, paste) —
	// reject non-strings outright instead of throwing on `.replace`.
	if (typeof href !== 'string') return null;
	// eslint-disable-next-line no-control-regex
	const trimmed = href.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
	if (!trimmed) return null;
	try {
		// A relative href resolves to the base's `https:`: it names no scheme of its own.
		return SAFE_LINK_PROTOCOLS.has(new URL(trimmed, 'https://relative.invalid/').protocol)
			? trimmed
			: null;
	} catch {
		return null;
	}
};

/**
 * The URL a paste carries when its plain text is one link and nothing else
 * (surrounding whitespace aside): `http:`/`https:` with a host, or
 * `mailto:`. `null` for anything else — words, several URLs, a bare
 * domain, a scriptable scheme.
 */
export const pastedLink = (plain: string | undefined | null): string | null => {
	const text = plain?.trim();
	if (!text || /\s/.test(text)) return null;
	try {
		const url = new URL(text);
		const web = (url.protocol === 'http:' || url.protocol === 'https:') && url.host;
		return web || (url.protocol === 'mailto:' && url.pathname) ? sanitizeLinkHref(text) : null;
	} catch {
		return null;
	}
};

/** What a typed URL may end with that belongs to the sentence, not the URL (`see https://a.dev.`). */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * The URL `before` (the text before a typed space) ends with: its last word,
 * trailing `.,;:!?` left out, when that is one link as `pastedLink` reads
 * it. Answers where it starts and its href, or `null` (autolink, Notion).
 */
export const typedLink = (before: string): { start: number; href: string } | null => {
	const word = /\S+$/.exec(before)?.[0];
	if (!word) return null;
	const url = word.replace(TRAILING_PUNCTUATION, '');
	return url && pastedLink(url) === url ? { start: before.length - word.length, href: url } : null;
};

/** A run of `text` carrying one link: its segment-local range and its href. */
export type LinkRun = { start: number; end: number; href: string };

const hrefOf = (marks: JSONText['marks']) => {
	const value = marks?.link;
	return isRecord(value) && typeof value.href === 'string' ? value.href : null;
};

/**
 * The link the character at `index` of `text` belongs to: the run of
 * characters around it linked to the same href (Mod+K at a caret, the
 * link card). `null` when that character carries no link.
 */
export const linkAt = (text: Text, index: number): LinkRun | null => {
	if (index < 0) return null;
	const runs: LinkRun[] = [];
	let offset = 0;
	for (const { text: value, marks } of text.value) {
		const href = hrefOf(marks);
		const end = offset + value.length;
		const last = runs.at(-1);
		if (href && last?.end === offset && last.href === href) last.end = end;
		else if (href) runs.push({ start: offset, end, href });
		offset = end;
	}
	return runs.find(({ start, end }) => index >= start && index < end) ?? null;
};

/**
 * Open `href` in a new tab, without giving the page a handle on the
 * editor's window (Mod+click, the link card's Open). An unsafe scheme opens
 * nothing.
 */
export const openLink = (href: string, view: Window | null = globalThis.window ?? null) => {
	const safe = sanitizeLinkHref(href);
	if (safe) view?.open(safe, '_blank', 'noopener,noreferrer');
};

const formatSelectedTextRange = (
	edytor: Edytor,
	mark: string,
	value: SerializableContent | null | undefined,
	toggle: boolean
) => {
	const { yStart, yEnd, startText, endText, isCollapsed, isReversed } = edytor.selection.state;
	if (isCollapsed || !startText || !endText) return;
	const spans = selectedTextSpans(edytor).filter(({ start, end }) => end > start);
	// One decision for the whole range (Notion): a toggle removes the mark only
	// when every selected character has it, else it marks all of them.
	const on = spans.every(({ text, start, end }) =>
		text.getMarksAtRange(start, end).every(({ marks }) => marks && mark in marks)
	);
	const next = toggle && on ? null : value;

	// One command per span: a vetoed one keeps its marks (`dispatcher.each`).
	edytor.dispatcher.each('format', spans, ({ text, start, end }) =>
		text.markText({ mark, value: next, start, end })
	);
	// Selected blocks stay selected (Notion; a divider's phantom text is no range).
	if (!selectsBlocks(edytor))
		edytor.selection.setAtRange(startText, yStart, endText, yEnd, { isReversed });
};

/**
 * A block selection: formatting keeps it, and it has no caret to stage a
 * mark at (a lone selected divider's text is a phantom).
 */
const selectsBlocks = (edytor: Edytor) => edytor.selection.value.kind === 'blocks';

export const richTextOperations = (edytor: Edytor) => ({
	/**
	 * Insert a `divider` void block at the caret — the native
	 * `insertHorizontalRule` semantic — as one command (`insertDivider`, one
	 * plan). Splitting at the caret (or inserting before/after at the edges)
	 * preserves the block's content; converting it would silently delete text,
	 * inline atoms and children. A block that holds nothing (`holdsNothing`),
	 * or a list's item (a list holds only its items), is placed as Turn into
	 * places a divider (`placing`): in the block's place
	 * when it holds nothing, else right after it, out of the list, the item
	 * whole.
	 */
	insertDividerAtSelection: () => {
		const { startBlock: block, startText, yStart, isCollapsed } = edytor.selection.state;
		if (!block?.convertible || !block.parent || !block.model || !isCollapsed) return null;
		const { facade, dispatcher } = edytor;
		const [self, parent] = [block.model.id, block.parent.isRoot ? null : block.parent.id];
		const divider = { id: id('b'), type: 'divider', data: {}, content: [], children: [] };
		const paragraph = { id: id('b'), type: edytor.defaultChild(block.parent) };
		const slot = (after: number, specs: BlockSpec[]) =>
			facade.prepare.insertBlocks({ parent, index: block.index + after }, specs);
		const offset = startText ? startText.segStart + yStart : 0;
		const next = block.parent.children[block.index + 1];
		// The block offset decides (an inline atom counts); the caret lands in
		// `caret` (a block id), or stays at `yStart` in its text.
		let caret: string | undefined = paragraph.id;
		let prepare: () => Prepared;
		const empty = holdsNothing(edytor, block);
		if (empty || !facade.fits(parent, 'divider'))
			prepare = () => placing(block, divider, !empty, paragraph.id);
		else if (offset === 0) {
			caret = undefined;
			prepare = () => slot(0, [divider]);
		} else if (offset < facade.displayLength(self)) {
			// Split at the caret with the divider between: one flow.
			const lines = [{ id: id('b'), content: [] }, divider, { ...paragraph, content: [] }];
			prepare = () => facade.prepare.insertFlow({ block: self, offset }, { lines }, viewOf(edytor));
		} else {
			// At the end — continue after the divider, in the next block or a fresh paragraph.
			caret = next?.id ?? paragraph.id;
			prepare = () => slot(1, next ? [divider] : [divider, paragraph]);
		}
		if (!dispatchPlan(block, 'insertDivider', {}, prepare, lineage(block))) return null;
		const text = caret ? edytor.idToBlock.get(caret)?.firstText : startText;
		dispatcher.caret(text, caret ? 0 : yStart);
		return block;
	},
	removeAllMarksAtRange: () => {
		const { yStart, startText, isCollapsed } = edytor.selection.state;
		if (isCollapsed) {
			if (startText && !selectsBlocks(edytor)) {
				edytor.selection.stage({});
				edytor.selection.setAtTextOffset(startText, yStart);
			}
			return;
		}

		edytor.dispatcher.each('format', selectedTextSpans(edytor), ({ text, start, end }) => {
			if (end > start) text.removeMarksFromText({ start, end });
		});
	},
	setLinkAtRange: (link: RichTextLink) => {
		// Reject scriptable/empty hrefs at the write boundary — the model
		// never stores a poisoned link. (The render boundary sanitizes too
		// for marks arriving via paste or sync.)
		const href = sanitizeLinkHref(link.href);
		if (href === null) return;
		formatSelectedTextRange(
			edytor,
			'link',
			{ href, ...(link.target ? { target: link.target } : {}) },
			false
		);
	},
	removeLinkAtRange: () => {
		formatSelectedTextRange(edytor, 'link', null, false);
	},
	/**
	 * Link `start`–`end` of `text` to `href`, as an undo step of its own
	 * (autolink): undo gives the plain text back. An unsafe href links nothing.
	 */
	linkText: (text: Text, start: number, end: number, href: string) => {
		const safe = sanitizeLinkHref(href);
		if (safe === null || end <= start) return;
		edytor.dispatcher.run('autolink', () =>
			text.markText({ mark: 'link', value: { href: safe }, start, end })
		);
	},
	/** Unlink `start`–`end` of `text` (the link card's Remove), one undo step; the selection stays. */
	unlinkText: (text: Text, start: number, end: number) => {
		edytor.dispatcher.run('format', () => text.markText({ mark: 'link', value: null, start, end }));
	},
	/** Remove one mark (a color, a highlight…) from the selected range. */
	removeMarkAtRange: (mark: RichTextMark) => {
		if (!edytor.selection.state.isCollapsed) formatSelectedTextRange(edytor, mark, null, false);
	},
	/**
	 * Non-toggle valued-mark write — native `formatFontColor`/
	 * `formatBackColor` commands carry the desired value, so re-applying
	 * the same color must set, never remove. A collapsed caret stages the
	 * mark for the next insert (mirroring `removeAllMarksAtRange`).
	 */
	setMarkValueAtRange: (mark: RichTextMark, value: SerializableContent) => {
		// `color`/`highlight` values render inside `style="..."` —
		// sanitize at the write boundary so a hostile payload (native
		// command `data`, programmatic calls) never reaches the model.
		const safeValue =
			mark === 'color' || mark === 'highlight' ? sanitizeCssColorValue(value) : value;
		if (safeValue === null) return;
		const { isCollapsed, startText, yStart } = edytor.selection.state;
		if (isCollapsed) {
			if (startText && !selectsBlocks(edytor)) {
				// Stage the full set the next insertion carries, values kept (O29).
				edytor.dispatcher.run('format', () =>
					edytor.selection.stage({
						...marksForInsertion(startText, yStart, { pending: edytor.selection.pending }),
						[mark]: safeValue
					})
				);
				edytor.selection.setAtTextOffset(startText, yStart);
			}
			return;
		}
		formatSelectedTextRange(edytor, mark, safeValue, false);
	},
	/**
	 * Toggle `mark` (any mark the editor defines: the rich text ones are
	 * typed) over the selection, each text segment it spans; at a caret,
	 * stage it for the next character typed.
	 */
	setMarkAtRange: (mark: RichTextMark | (string & {}), value?: SerializableContent) => {
		const { yStart, yEnd, startText, endText, isCollapsed } = edytor.selection.state;
		if (isCollapsed) {
			if (startText && !selectsBlocks(edytor)) {
				edytor.dispatcher.run('format', () =>
					startText.markText({
						mark,
						value,
						toggle: true,
						start: yStart,
						end: yEnd
					})
				);
				edytor.selection.setAtRange(startText, yStart, endText, yEnd);
			}
			return;
		}

		formatSelectedTextRange(edytor, mark, value, true);
	}
});
