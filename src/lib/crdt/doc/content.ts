/**
 * Content ops: text and inline atoms in a block's display (allowed
 * inside voids — the caption contract), and marks over a range.
 */
import { sanitizeWireJson, jsonEquals } from '../../utils/json.js';
import type { BlockId, InlineSpec } from '../placement/model.js';
import { ref, sanitizeInline } from './plan.js';
import type { Prepared, JsonObj } from './types.js';
import type { OpsContext } from './steps.js';

/** The content ops of one facade, prepared. */
export const contentOps = (c: OpsContext) => {
	const { contentTarget, REFUSED, plan, clamp, atomOf, textIn } = c;

	// content ops (allowed inside voids — caption contract)

	const insertText = (
		id: BlockId,
		offset: number,
		text: string,
		marks?: Record<string, unknown>
	): Prepared => {
		id = ref(id);
		const clean = ref(text);
		if (!contentTarget(id)) return REFUSED;
		const [at] = clamp(id, offset, 0);
		const m = marks && sanitizeWireJson(marks);
		return plan(
			[id],
			clean === '' ? [] : [{ op: 'insertText', id, offset: at, text: clean, marks: m }]
		);
	};

	const deleteText = (id: BlockId, offset: number, length: number): Prepared => {
		id = ref(id);
		if (!contentTarget(id)) return REFUSED;
		const [at, end] = clamp(id, offset, length);
		return plan([id], end > at ? [{ op: 'deleteText', id, offset: at, length: end - at }] : []);
	};

	/**
	 * Multi-mark format over a range (values may be null = unset); planned
	 * only when some text atom in the range carries a different value.
	 */
	const formatRange = (
		id: BlockId,
		offset: number,
		length: number,
		marks: Record<string, unknown>
	): Prepared => {
		id = ref(id);
		const clean = sanitizeWireJson(marks);
		if (!contentTarget(id)) return REFUSED;
		const [at, end] = clamp(id, offset, length);
		// Planned only when some text atom carries another value (the same-value guard).
		const differs = textIn(id, at, end).some((item) =>
			Object.keys(clean).some((k) => !jsonEquals(item.marks?.[k] ?? null, clean[k] ?? null))
		);
		return plan(
			[id],
			differs ? [{ op: 'formatRange', id, offset: at, length: end - at, marks: clean }] : []
		);
	};

	/**
	 * Baseline `removeMarksFromText`: every mark present anywhere in the
	 * range is unset over the range. Names are discovered from the content.
	 */
	const clearMarks = (id: BlockId, offset: number, length: number): Prepared => {
		const clears: JsonObj = {};
		for (const item of textIn(ref(id), offset, offset + length)) {
			for (const k of Object.keys(item.marks ?? {})) clears[k] = null;
		}
		return formatRange(id, offset, length, clears);
	};

	const insertInline = (id: BlockId, offset: number, atom: InlineSpec): Prepared => {
		id = ref(id);
		const clean = sanitizeInline(atom);
		if (!contentTarget(id)) return REFUSED;
		return plan([id], [{ op: 'insertInline', id, offset: clamp(id, offset, 0)[0], atom: clean }]);
	};

	const removeInline = (id: BlockId, inlineId: string): Prepared => {
		id = ref(id);
		const atom = atomOf(id, ref(inlineId));
		if (atom === undefined) return REFUSED;
		return plan([id], [{ op: 'removeInline', id, offset: atom.at, inlineId: ref(inlineId) }]);
	};

	return {
		insertText,
		deleteText,
		formatRange,
		clearMarks,
		insertInline,
		removeInline
	};
};
