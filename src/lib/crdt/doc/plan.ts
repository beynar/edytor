/**
 * The pure helpers every prepared operation shares: the op results, the
 * effect of a plan's steps, ingress normalization, and the facade's applied
 * ops (`apply(prepare.op(…))`).
 */
import type { BlockId, BlockSpec, ContentItem, InlineSpec } from '../placement/model.js';
import type { OpResult, PlanEffect, PlanStep, Prepared } from './types.js';
import { sanitizeWireJson, sanitizeWireString } from '../../utils/json.js';

/** Shared frozen empty child list for `DocChange.order` tombstone entries. */
export const EMPTY_IDS = Object.freeze([]) as readonly BlockId[];

/** An op body's refusal: `null`, or the reason it names. */
export type Refusal = null | string;
export const NOOP: OpResult = Object.freeze({ status: 'noop', ids: EMPTY_IDS });
export const refused = (reason: Refusal): OpResult =>
	Object.freeze({ status: 'refused', ids: EMPTY_IDS, ...(reason !== null && { reason }) });

/** Each prepared op, applied: the op itself. */
export type Applied<P> = {
	[K in keyof P]: P[K] extends (...args: infer A) => Prepared ? (...args: A) => OpResult : never;
};
export const applied = <P extends Record<string, (...args: never[]) => Prepared>>(
	prepare: P,
	apply: (p: Prepared) => OpResult
): Applied<P> =>
	Object.fromEntries(
		Object.entries(prepare).map(([name, op]) => [name, (...args: never[]) => apply(op(...args))])
	) as Applied<P>;

/** The effect summary of `writes`. */
export const effectOf = (writes: readonly PlanStep[]): PlanEffect => {
	const e: PlanEffect = {
		creates: [],
		removes: [],
		merges: [],
		moves: [],
		meta: [],
		textRanges: []
	};
	const text = (block: BlockId, offset: number, length: number): void => {
		if (length > 0) e.textRanges.push({ block, offset, length });
	};
	const created = (sp: BlockSpec): void => {
		e.creates.push(sp.id);
		sp.children?.forEach(created);
	};
	for (const w of writes) {
		if (w.op === 'insertBlocks') w.specs.forEach(created);
		else if (w.op === 'moveBlocks') e.moves.push(...w.ids);
		else if (w.op === 'deleteBlock') e.removes.push(...w.removes);
		else if (w.op === 'splitBlock') {
			e.creates.push(w.newId);
			text(w.id, w.offset, w.length);
		} else if (w.op === 'mergeBlocks') {
			e.merges.push([w.from, w.into]);
			text(w.into, w.at, w.length);
		} else if (w.op === 'setBlockType') e.meta.push(w.id);
		else if (w.op === 'patchData') {
			if (w.inlineId !== undefined) text(w.id!, w.offset!, 1);
			else if (w.id !== undefined) e.meta.push(w.id);
		} else if (w.op === 'insertText') text(w.id, w.offset, w.text.length);
		else if (w.op === 'deleteText' || w.op === 'formatRange') text(w.id, w.offset, w.length);
		else text(w.id, w.offset, 1);
	}
	// Text written into a block the plan creates is part of its creation.
	e.textRanges = e.textRanges.filter((r) => !e.creates.includes(r.block));
	return e;
};

/**
 * Ingress for an id reference (O1): it normalizes exactly like a stored id
 * (`sanitizeSpec`), so a write and a later lookup by the same string agree.
 */
export const ref = <I extends string | null>(id: I): I =>
	(id === null ? id : sanitizeWireString(id)) as I;

/** A replacement content item normalized at ingress. */
export const sanitizeItem = (item: ContentItem): ContentItem =>
	item.kind === 'text'
		? {
				kind: 'text',
				text: ref(item.text),
				...(item.marks && { marks: sanitizeWireJson(item.marks) })
			}
		: sanitizeInline(item);
export const sanitizeInline = <I extends InlineSpec>(item: I): I => ({
	...item,
	id: ref(item.id),
	type: ref(item.type),
	...(item.data !== undefined && { data: sanitizeWireJson(item.data) })
});
