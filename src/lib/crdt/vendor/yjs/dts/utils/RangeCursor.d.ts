/**
 * One element of the bounded read stream produced by {@link RangeCursor#read}
 * — one live piece of content overlapping the range, with the formats folded
 * at it.
 *
 * @typedef {Object} RangePiece
 * @property {AbstractContent} content - the piece's content object. BORROWED
 *   from the item (never mutated, never copied).
 *   Emit `[offset, offset + len)` of it: slice `content.str` for
 *   `ContentString` (UTF-16 units) and index `content.getContent()` for
 *   element content.
 * @property {ID} id - replicated id of the first emitted element.
 * @property {number} index - rendered position the emitted range starts at.
 * @property {number} offset - start of the emitted range inside `content`.
 * @property {number} len - rendered length of the emitted range (`0` for a
 *   live piece occupying no position).
 * @property {boolean} deleted - always `false`: a read emits live content only.
 * @property {null} attrs - always `null` (no attribution layer).
 * @property {Object<string,any>|undefined} formats - folded format state at
 *   the piece. SHARED between adjacent pieces of one fold state — treat as
 *   read-only.
 */
/**
 * A forward-only, read-only cursor over one `YNode` list. Fields mirror
 * `ItemTextListPosition` (`p`/`index`/`currentFormats`) — `index` is the
 * rendered position of `p`'s left edge, `currentFormats` the format state
 * folded to it.
 */
export class RangeCursor {
    /**
     * @param {YNode} parent - the list node to read.
     */
    constructor(parent: YNode);
    /**
     * @type {YNode}
     */
    parent: YNode;
    /**
     * The next unprocessed sequence item — a parked cursor keeps `index` at
     * its left edge.
     * @type {import('../structs/Item.js').Item?}
     */
    p: import("../structs/Item.js").Item | null;
    /**
     * Rendered units strictly before `p` — the
     * `ItemTextListPosition#index`/`ArraySearchMarker#index` space
     * (countable, non-deleted units).
     * @type {number}
     */
    index: number;
    /**
     * Format state folded to `index` — a private copy of any adopted marker
     * snapshot (`value === null` clears; same `updateCurrentFormats` fold).
     * @type {Map<string,any>}
     */
    currentFormats: Map<string, any>;
    /**
     * The materialized `formats` object handed to emitted pieces — `null`
     * until the next emission under the current fold state.
     * @type {Object<string,any>|undefined|null}
     */
    _formatsObj: {
        [x: string]: any;
    } | undefined | null;
    /**
     * Rewind to `_start` — format state cannot un-apply, so backward reads
     * reset before re-seeding.
     */
    reset(): void;
    /**
     * Reposition the cursor at-or-before rendered position `index`, seeding
     * from the best engine-owned checkpoint — an `ArraySearchMarker`
     * carrying a `formats` snapshot.
     *
     * Read-seed eligibility is deliberately WEAKER than the write cursor's
     * seed (UPSTREAM.md YP5): a read may resume on ANY item at-or-left
     * of the target — the forward fold reproduces format state from the
     * snapshot — while the mutation cursor must anchor on the FIRST item at
     * the index (its `p.left` must be countable-or-null). Both consume the
     * same marker records and snapshots.
     *
     * @param {number} index
     */
    seek(index: number): void;
    /**
     * Fold one `ContentFormat` item into the cursor's format state — the
     * `!deleted` gate mirrors `ItemTextListPosition#forward`: a tombstoned
     * marker applies nothing.
     *
     * @param {import('../structs/Item.js').Item} item
     * @param {{ markers: number }?} stats
     */
    _foldItem(item: import("../structs/Item.js").Item, stats: {
        markers: number;
    } | null): void;
    /**
     * The cursor's format state as an emittable object — materialized once
     * per fold state and SHARED between the pieces emitted under it
     * (aliasing contract: consumers treat it as read-only; interning/freeze
     * happens at the publication boundary).
     *
     * @return {Object<string,any>|undefined}
     */
    _emitFormats(): {
        [x: string]: any;
    } | undefined;
    /**
     * Emit the {@link RangePiece}s of `[i0, i1)` — a bounded, read-only walk
     * of the item list producing its live content, clipped to the range and
     * carrying the folded format state.
     *
     * The cursor is left positioned to serve the NEXT forward read cheaply:
     * items fully consumed advance `p`/`index`; a range ending inside an
     * item leaves the cursor parked at that item's left edge (re-walking it
     * is slice math, not a rescan). A backward read rewinds to `_start` and
     * re-seeks — format state cannot un-apply.
     *
     * @param {number} i0 - rendered start position (inclusive).
     * @param {number} i1 - rendered end position (exclusive).
     * @param {{ items: number, markers: number }?} [stats] - per-read
     *   instrumentation: `items` counts sequence items stepped over,
     *   `markers` counts `ContentFormat` pieces seen (folded or tombstoned).
     * @return {Array<RangePiece>}
     */
    read(i0: number, i1: number, stats?: {
        items: number;
        markers: number;
    } | null): Array<RangePiece>;
}
/**
 * One element of the bounded read stream produced by {@link RangeCursor#read}
 * — one live piece of content overlapping the range, with the formats folded
 * at it.
 */
export type RangePiece = {
    /**
     * - the piece's content object. BORROWED
     * from the item (never mutated, never copied).
     * Emit `[offset, offset + len)` of it: slice `content.str` for
     * `ContentString` (UTF-16 units) and index `content.getContent()` for
     * element content.
     */
    content: AbstractContent;
    /**
     * - replicated id of the first emitted element.
     */
    id: ID;
    /**
     * - rendered position the emitted range starts at.
     */
    index: number;
    /**
     * - start of the emitted range inside `content`.
     */
    offset: number;
    /**
     * - rendered length of the emitted range (`0` for a
     * live piece occupying no position).
     */
    len: number;
    /**
     * - always `false`: a read emits live content only.
     */
    deleted: boolean;
    /**
     * - always `null` (no attribution layer).
     */
    attrs: null;
    /**
     * - folded format state at
     * the piece. SHARED between adjacent pieces of one fold state — treat as
     * read-only.
     */
    formats: {
        [x: string]: any;
    } | undefined;
};
