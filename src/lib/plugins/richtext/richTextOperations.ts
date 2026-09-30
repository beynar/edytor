import type { Edytor } from '$lib/edytor.svelte.js';
import type { SerializableContent } from '$lib/utils/json.js';
import type { Prepared } from '$lib/crdt/edytor-doc.js';
import type { BlockSpec } from '$lib/crdt/index.js';
import { dispatchPlan } from '$lib/block/block.utils.js';
import { landingOf } from '$lib/kinds.js';
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
 * malicious collaborator — and Svelte renders `href` verbatim. The URL
 * parser is used rather than a regex so whitespace/case obfuscation
 * (`java\tscript:`) can't slip through. Scheme-less hrefs (relative
 * paths, anchors, queries, protocol-relative) are not scriptable and
 * pass through.
 */
export const sanitizeLinkHref = (href: unknown): string | null => {
	// Marks arrive from untrusted sources too (synced peers, paste) —
	// reject non-strings outright instead of throwing on `.replace`.
	if (typeof href !== 'string') return null;
	// WHATWG URL preprocessing removes tab/newline/CR before parsing —
	// doing it here too means `java\tscript:` collapses back to a
	// detectable scheme instead of slipping through as "scheme-less".
	const trimmed = href.replace(/[\t\n\r]/g, '').trim();
	if (!trimmed) return null;
	if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
	try {
		return SAFE_LINK_PROTOCOLS.has(new URL(trimmed).protocol) ? trimmed : null;
	} catch {
		return null;
	}
};

const formatSelectedTextRange = (
	edytor: Edytor,
	mark: RichTextMark,
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

	edytor.dispatcher.run('format', () =>
		spans.forEach(({ text, start, end }) => text.markText({ mark, value: next, start, end }))
	);
	edytor.selection.setAtRange(startText, yStart, endText, yEnd, { isReversed });
};

export const richTextOperations = (edytor: Edytor) => ({
	/**
	 * Insert a `divider` void block at the caret — the native
	 * `insertHorizontalRule` semantic — as one command (`insertDivider`, one
	 * plan). Splitting at the caret (or inserting before/after at the edges)
	 * preserves the block's content; converting it would silently delete text
	 * and children. In a list, which holds only its items, the divider lands
	 * out of it as Turn into puts one (`liftOut`, SW10-lists-2): in an empty
	 * item's place, else after the item, whose text stays whole.
	 */
	insertDividerAtSelection: () => {
		const { startBlock: block, startText, yStart, isCollapsed } = edytor.selection.state;
		if (!block?.convertible || !block.parent || !block.model || !isCollapsed) return null;
		const { facade, dispatcher } = edytor;
		const [self, parent] = [block.model.id, block.parent.isRoot ? null : block.parent.id];
		const landing = landingOf(block, 'divider');
		const divider = { id: id('b'), type: 'divider', data: {} };
		const paragraph = { id: id('b'), type: edytor.defaultChild(landing.parent ?? block.parent) };
		const slot = (after: number, specs: BlockSpec[]) =>
			facade.prepare.insertBlocks({ parent, index: block.index + after }, specs);
		const offset = startText ? startText.segStart + yStart : 0;
		const next = block.parent.children[block.index + 1];
		// The caret lands in `caret` (a block id), or stays at `yStart` in its text.
		let caret: string | undefined = paragraph.id;
		let prepare: () => Prepared;
		const value = { type: 'divider', data: {}, content: [], children: [] };
		// An emptied document's line: the divider and the paragraph are created (DR-behavior-2).
		if (facade.virtual() === self) prepare = () => slot(0, [divider, paragraph]);
		else if (landing.lifted.length) {
			const lift = (options: { keep?: boolean; after: BlockSpec[] }) =>
				facade.prepare.liftOut(self, 'divider', options);
			prepare = block.isEmpty
				? () => facade.compose(lift({ after: [paragraph] }), facade.prepare.setBlock(self, value))
				: () => lift({ keep: true, after: [divider, paragraph] });
		} else if (block.isEmpty) {
			// Nothing to lose — convert in place, then a fresh paragraph after it.
			prepare = () => facade.compose(facade.prepare.setBlock(self, value), slot(1, [paragraph]));
		} else if (yStart === 0) {
			caret = undefined;
			prepare = () => slot(0, [divider]);
		} else if (startText && yStart < startText.length) {
			// Split at the caret with the divider between: one flow.
			const lines = [{ id: id('b'), content: [] }, divider, { ...paragraph, content: [] }];
			prepare = () => facade.prepare.insertFlow({ block: self, offset }, { lines }, viewOf(edytor));
		} else {
			// At the end — continue after the divider, in the next block or a fresh paragraph.
			caret = next?.id ?? paragraph.id;
			prepare = () => slot(1, next ? [divider] : [divider, paragraph]);
		}
		const touched = [block.parent, ...landing.lifted, landing.parent];
		if (!dispatchPlan(block, 'insertDivider', {}, prepare, touched)) return null;
		const text = caret ? edytor.idToBlock.get(caret)?.firstText : startText;
		dispatcher.caret(text, caret ? 0 : yStart);
		return block;
	},
	removeAllMarksAtRange: () => {
		const { yStart, startText, isCollapsed } = edytor.selection.state;
		if (isCollapsed) {
			if (startText) {
				edytor.selection.stage({});
				edytor.selection.setAtTextOffset(startText, yStart);
			}
			return;
		}

		edytor.dispatcher.run('format', () =>
			selectedTextSpans(edytor).forEach(({ text, start, end }) => {
				if (end > start) text.removeMarksFromText({ start, end });
			})
		);
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
			if (startText) {
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
	setMarkAtRange: (mark: RichTextMark, value?: SerializableContent) => {
		const { yStart, yEnd, startText, endText, isCollapsed } = edytor.selection.state;
		if (isCollapsed) {
			if (startText) {
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
