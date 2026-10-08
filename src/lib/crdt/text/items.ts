/**
 * The guards of a backing text's items: a boundary item's payload, and a
 * node's first item for sequence walks.
 */
import type { EngineNode } from '../engine-api.js';
import type { Boundary, SeqItem } from './model.js';

export const isBoundary = (v: unknown): v is Boundary =>
	v != null && typeof v === 'object' && typeof (v as Boundary).s === 'string' && 'n' in v;

export const nodeStart = (node: EngineNode): SeqItem | null =>
	(node as unknown as { _start?: SeqItem | null })._start ?? null;
