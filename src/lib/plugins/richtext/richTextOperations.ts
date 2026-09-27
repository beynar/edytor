import type { Block } from '$lib/block/block.svelte.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { SerializableContent } from '$lib/utils/json.js';

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
 * Scheme allowlist for link hrefs. `javascript:`/`data:`/`vbscript:`
 * payloads can arrive through native `insertLink`, pasted HTML, or a
 * malicious collaborator — and Svelte renders `href` verbatim. The URL
 * parser is used rather than a regex so whitespace/case obfuscation
 * (`java\tscript:`) can't slip through. Scheme-less hrefs (relative
 * paths, anchors, queries, protocol-relative) are not scriptable and
 * pass through.
 */
/**
 * CSS-color sanitizer for `color`/`highlight` marks. The value lands in
 * `style="color: {value}"` — a `;`/`{`/`}` payload escapes the property
 * and injects arbitrary declarations (`url()` exfil, `position:fixed`
 * overlays). Metacharacters, escape/obfuscation sequences, and
 * resource-loading functions are rejected; real `<color>` values
 * (`#hex`, `rgb()/hsl()/oklch()/color-mix()/var()`, named colors) pass.
 */
export const sanitizeCssColorValue = (value: unknown): string | null => {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 128) {
		return null;
	}
	if (/[;{}<>\\'"`]/.test(trimmed) || /url\s*\(|expression\s*\(|\/\*|\*\//i.test(trimmed)) {
		return null;
	}
	return trimmed;
};

export const sanitizeLinkHref = (href: unknown): string | null => {
	// Marks arrive from untrusted sources too (synced peers, paste) —
	// reject non-strings outright instead of throwing on `.replace`.
	if (typeof href !== 'string') {
		return null;
	}
	// WHATWG URL preprocessing removes tab/newline/CR before parsing —
	// doing it here too means `java\tscript:` collapses back to a
	// detectable scheme instead of slipping through as "scheme-less".
	const trimmed = href.replace(/[\t\n\r]/g, '').trim();
	if (!trimmed) {
		return null;
	}
	if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
		return trimmed;
	}
	try {
		return SAFE_LINK_PROTOCOLS.has(new URL(trimmed).protocol) ? trimmed : null;
	} catch {
		return null;
	}
};

export const canConvertBlock = (block: Block | null | undefined): block is Block =>
	Boolean(block?.convertible);

const selectedRangeMutates = (edytor: Edytor) => {
	const { yStart, yEnd, texts } = edytor.selection.state;
	return texts.some((text, index) => {
		const isFirst = index === 0;
		const isLast = index === texts.length - 1;
		const start = isFirst ? yStart : 0;
		const end = isLast ? yEnd : text.length;
		return end > start;
	});
};

const formatSelectedTextRange = (
	edytor: Edytor,
	mark: RichTextMark,
	value: SerializableContent | null | undefined,
	toggle: boolean
) => {
	const { yStart, yEnd, startText, endText, texts, isCollapsed, isReversed } =
		edytor.selection.state;
	if (isCollapsed || !startText || !endText) {
		return;
	}

	if (selectedRangeMutates(edytor)) {
		edytor.selection.queueNextUndoSelectionSnapshot();
	}
	edytor.dispatcher.cut('format');
	texts.forEach((text, index) => {
		const isFirst = index === 0;
		const isLast = index === texts.length - 1;
		text.markText({
			mark,
			value,
			toggle,
			start: isFirst ? yStart : 0,
			end: isLast ? yEnd : text.length
		});
	});
	edytor.selection.setRangeStateAtTextOffsets(startText, yStart, endText, yEnd, { isReversed });
	void edytor.selection.setAtRange(startText, yStart, endText, yEnd, { isReversed }).finally(() =>
		edytor.selection.setRangeStateAtTextOffsets(startText, yStart, endText, yEnd, {
			isReversed
		})
	);
};

const normalizeLink = (link: RichTextLink): Record<string, SerializableContent> => {
	const value: Record<string, SerializableContent> = { href: link.href };
	if (link.target) {
		value.target = link.target;
	}
	return value;
};

export const richTextOperations = (edytor: Edytor) => ({
	canConvertCurrentBlock: () => canConvertBlock(edytor.selection.state.startBlock),
	convertCurrentBlock: ({
		type,
		data = {},
		void: isVoid = false
	}: {
		type: string;
		data?: Record<string, SerializableContent>;
		void?: boolean;
	}) => {
		const block = edytor.selection.state.startBlock;
		if (!canConvertBlock(block)) {
			return null;
		}

		block.setBlock({
			value: isVoid ? { type, data, content: [], children: [] } : { type, data }
		});
		return block;
	},
	/**
	 * Insert a `divider` void block at the caret — the native
	 * `insertHorizontalRule` semantic. Splitting at the caret (or
	 * inserting before/after at the edges) preserves the block's content;
	 * converting it would silently delete text and children.
	 */
	insertDividerAtSelection: () => {
		const { startBlock, startText, yStart, isCollapsed } = edytor.selection.state;
		if (!canConvertBlock(startBlock) || !startBlock.parent || !isCollapsed) {
			return null;
		}
		const block = startBlock;
		const defaultType = () => edytor.defaultChild(block.parent!);
		const caretInto = (target: typeof block | null | undefined) => {
			const text = target?.firstText;
			if (text) {
				void edytor.selection.setAtTextOffset(text, 0);
			}
		};

		if (block.isEmpty) {
			// Nothing to lose — convert in place, then land the caret in a
			// fresh paragraph after the divider.
			block.setBlock({ value: { type: 'divider', data: {}, content: [], children: [] } });
			caretInto(block.insertBlockAfter({ block: { type: defaultType() } }));
			return block;
		}

		if (startText && yStart === 0) {
			block.insertBlockBefore({ block: { type: 'divider', data: {} } });
			void edytor.selection.setAtTextOffset(startText, 0);
			return block;
		}

		let tail: typeof block | null = null;
		if (startText && yStart < startText.length) {
			tail = block.splitBlock({ index: yStart, text: startText });
			if (!tail) {
				return null;
			}
		}
		const divider = block.insertBlockAfter({ block: { type: 'divider', data: {} } });
		if (tail) {
			caretInto(tail);
			return block;
		}
		// Caret was at the block's end — continue after the divider, in
		// the existing next block or a fresh paragraph.
		const next = divider?.parent?.children[(divider.index ?? 0) + 1];
		caretInto(next ?? divider?.insertBlockAfter({ block: { type: defaultType() } }));
		return block;
	},
	removeAllMarksAtRange: () => {
		const { yStart, yEnd, startText, endText, texts, isCollapsed, isReversed } =
			edytor.selection.state;
		if (isCollapsed) {
			if (startText) {
				startText.markOnNextInsert = {};
				edytor.selection.setAtTextOffset(startText, yStart);
			}
			return;
		}

		const mutatesSelectedRange = texts.some((text, index) => {
			const isFirst = index === 0;
			const isLast = index === texts.length - 1;
			const start = isFirst ? yStart : 0;
			const end = isLast ? yEnd : text.length;
			return end > start;
		});
		if (mutatesSelectedRange) {
			edytor.selection.queueNextUndoSelectionSnapshot();
		}
		texts.forEach((text, index) => {
			const isFirst = index === 0;
			const isLast = index === texts.length - 1;
			const start = isFirst ? yStart : 0;
			const end = isLast ? yEnd : text.length;
			if (end > start) {
				text.removeMarksFromText({ start, end });
			}
		});
		if (startText) {
			edytor.selection.setAtRange(startText, yStart, endText, yEnd, { isReversed });
		}
	},
	setLinkAtRange: (link: RichTextLink) => {
		// Reject scriptable/empty hrefs at the write boundary — the model
		// never stores a poisoned link. (The render boundary sanitizes too
		// for marks arriving via paste or sync.)
		const safeHref = sanitizeLinkHref(link.href);
		if (safeHref === null) {
			return;
		}
		formatSelectedTextRange(edytor, 'link', normalizeLink({ ...link, href: safeHref }), false);
	},
	removeLinkAtRange: () => {
		formatSelectedTextRange(edytor, 'link', null, false);
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
		if (safeValue === null) {
			return;
		}
		const { isCollapsed, startText, yStart } = edytor.selection.state;
		if (isCollapsed) {
			if (startText) {
				// Inherit the surrounding truthy marks like `markText`'s
				// collapsed path — a bare `markOnNextInsert` write
				// short-circuits adjacent-mark inheritance, so a color
				// command inside italic text would silently drop the
				// italic on the next insert.
				const activeMarks = startText
					.getMarksAtRange(yStart - 1, yStart)
					.reduce<Record<string, SerializableContent>>((acc, { marks }) => {
						for (const [key, value] of Object.entries(marks ?? {})) {
							if (value === true) {
								acc[key] = true;
							}
						}
						return acc;
					}, {});
				edytor.dispatcher.cut('format');
				startText.markOnNextInsert = {
					...activeMarks,
					...(startText.markOnNextInsert ?? {}),
					[mark]: safeValue
				};
				void edytor.selection.setAtTextOffset(startText, yStart);
			}
			return;
		}
		formatSelectedTextRange(edytor, mark, safeValue, false);
	},
	setMarkAtRange: (mark: RichTextMark, value?: SerializableContent) => {
		const { yStart, yEnd, startText, endText, texts, isCollapsed } = edytor.selection.state;
		if (isCollapsed) {
			if (startText) {
				edytor.dispatcher.cut('format');
				startText.markText({
					mark,
					value,
					toggle: true,
					start: yStart,
					end: yEnd
				});
				edytor.selection.setAtRange(startText, yStart, endText, yEnd);
			}
			return;
		}

		formatSelectedTextRange(edytor, mark, value, true);
	}
});
