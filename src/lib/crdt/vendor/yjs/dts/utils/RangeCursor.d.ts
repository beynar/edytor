/**
 * One element of the bounded read stream produced by {@link RangeCursor#read}
 * — the read-side analogue of a delta op's content payload, carrying the same
 * attribution inputs `YNode#toDelta` consumes (mode `1` semantics).
 *
 * @typedef {Object} RangePiece
 * @property {AbstractContent} content - the piece's content object. BORROWED
 *   from the item (never mutated, never copied) or produced by the renderer.
 *   Emit `[offset, offset + len)` of it: slice `content.str` for
 *   `ContentString` (UTF-16 units — identical to clipping a `toDelta` insert
 *   op's string) and index `content.getContent()` for element content.
 * @property {ID} id - replicated id of the first emitted element.
 * @property {number} index - rendered position the emitted range starts at.
 * @property {number} offset - start of the emitted range inside `content`.
 * @property {number} len - rendered length of the emitted range. `0` for
 *   `ContentFormat` markers and for pieces occupying no rendered position
 *   (renderer-hidden or unattributed tombstones).
 * @property {boolean} deleted - effective tombstone flag (renderer-aware: a
 *   restored piece clears it, an attributed tombstone keeps it).
 * @property {Array<ContentAttribute<any>>?} attrs - native attribution
 *   inputs (`createAttributionFromAttributionItems` computes the delta-level
 *   `Attribution` from them); `null` when unattributed.
 * @property {Object<string,any>|undefined} formats - folded format state at
 *   the piece (the `toDelta` `format` object equivalent). SHARED between
 *   adjacent pieces of one fold state — treat as read-only.
 */
/**
 * A forward-only, read-only cursor over one `YNode` list. Fields mirror
 * `ItemTextListPosition` (`p`/`index`/`currentFormats`) — `index` is the
 * rendered position of `p`'s left edge, `currentFormats` the format state
 * folded to it.
 */
export class RangeCursor {
    /**
     * @param {YNode<any>} parent - the list node to read.
     * @param {AbstractRenderer?} [renderer] - defaults to the node's active
     *   renderer (`this._renderer`), the `toDelta`/`applyDelta` convention.
     *   Pass `null` to force the generic interpretation.
     */
    constructor(parent: YNode<any>, renderer?: AbstractRenderer | null);
    /**
     * @type {YNode<any>}
     */
    parent: YNode<any>;
    /**
     * @type {AbstractRenderer?}
     */
    renderer: AbstractRenderer | null;
    /**
     * The next unprocessed sequence item — a parked cursor keeps `index` at
     * its left edge.
     * @type {import('../structs/Item.js').Item?}
     */
    p: import("../structs/Item.js").Item | null;
    /**
     * Rendered units strictly before `p` — the
     * `ItemTextListPosition#index`/`ArraySearchMarker#index` space
     * (countable, non-deleted units while `renderer === null`).
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
     * Read-seed eligibility is deliberately WEAKER than `applyDelta`'s
     * mutation seed (UPSTREAM.md P5): a read may resume on ANY item at-or-left
     * of the target — the forward fold reproduces format state from the
     * snapshot — while the mutation cursor must anchor on the FIRST item at
     * the index (its `p.left` must be countable-or-null). Both consume the
     * same marker records and snapshots.
     *
     * Restricted to `renderer === null` for the same reason the mutation seed
     * is: `marker.index` records the raw countable space, which a renderer's
     * `contentLength` can reinterpret.
     *
     * @param {number} index
     */
    seek(index: number): void;
    /**
     * Fold one `ContentFormat` piece into the cursor's format state — the
     * `!deleted` gate mirrors `ItemTextListPosition#forward`/`toDelta`: a
     * tombstoned marker (or a piece the renderer renders as deleted) applies
     * nothing.
     *
     * @param {AttributedContent<any>} c
     * @param {{ markers: number }?} stats
     */
    _foldPiece(c: AttributedContent<any>, stats: {
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
     * of the item list producing the same pieces `toDelta`'s current-state
     * render consumes (`readItemPieces`), clipped to the range and carrying
     * folded format state + native attribution inputs.
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
 * — the read-side analogue of a delta op's content payload, carrying the same
 * attribution inputs `YNode#toDelta` consumes (mode `1` semantics).
 */
export type RangePiece = {
    /**
     * - the piece's content object. BORROWED
     * from the item (never mutated, never copied) or produced by the renderer.
     * Emit `[offset, offset + len)` of it: slice `content.str` for
     * `ContentString` (UTF-16 units — identical to clipping a `toDelta` insert
     * op's string) and index `content.getContent()` for element content.
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
     * - rendered length of the emitted range. `0` for
     * `ContentFormat` markers and for pieces occupying no rendered position
     * (renderer-hidden or unattributed tombstones).
     */
    len: number;
    /**
     * - effective tombstone flag (renderer-aware: a
     * restored piece clears it, an attributed tombstone keeps it).
     */
    deleted: boolean;
    /**
     * - native attribution
     * inputs (`createAttributionFromAttributionItems` computes the delta-level
     * `Attribution` from them); `null` when unattributed.
     */
    attrs: Array<ContentAttribute<any>> | null;
    /**
     * - folded format state at
     * the piece (the `toDelta` `format` object equivalent). SHARED between
     * adjacent pieces of one fold state — treat as read-only.
     */
    formats: {
        [x: string]: any;
    } | undefined;
};
