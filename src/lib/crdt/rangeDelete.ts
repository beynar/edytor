/**
 * The types range deletion (`deleteRange`, `replaceRange`: the `del.range.*`
 * rows, prepared in `doc/ops.ts`) reads.
 */
import type { BlockId } from './placement/model.js';

/** A position in one document version: a block and a display offset. */
export type DocPosition = { block: BlockId; offset: number };

/**
 * What the view knows of a range (view state the document does not hold):
 * whether it hides a block, and, given `removed`, whether the block stays
 * hidden once those go (a removed closed toggle's children take its place, shown).
 */
export type RangeView = { hidden?: (id: BlockId, removed?: ReadonlySet<BlockId>) => boolean };
