/**
 * The guards of a backing text's items: a boundary item's payload, a merge
 * claim item's, and a node's first item for sequence walks.
 */
import type { EngineNode } from '../engine-api.js';
import { firstItem } from '../structs.js';
import type { Boundary, MergeClaim, SeqItem } from './model.js';

export const isBoundary = (v: unknown): v is Boundary =>
	v != null && typeof v === 'object' && typeof (v as Boundary).s === 'string' && 'n' in v;

/**
 * A merge claim item `{m}` (fork patch YP21: the engine sorts it after the
 * content and boundaries of its origin, and keeps it on collection).
 */
export const isClaimItem = (v: unknown): v is MergeClaim =>
	v != null && typeof v === 'object' && typeof (v as MergeClaim).m === 'string';

/** A unit a row tracks and no read displays: a boundary or a claim item. */
export const isRowMark = (v: unknown): boolean => isBoundary(v) || isClaimItem(v);

export const nodeStart = (node: EngineNode): SeqItem | null => firstItem<SeqItem>(node);
