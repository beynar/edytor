/**
 * Paired marks — an edytor fork addition (UPSTREAM.md YP13), not upstream source.
 *
 * Upstream formatting writes a format item `{key: value}` where a range
 * starts and `{key: null}` (or the previous value) where it ends: any end
 * closes whatever value is open, so two overlapping concurrent bolds lose
 * bold where the first one's end lands inside the second (Peritext's
 * overlapping-marks case), and a concurrent insert next to a format item
 * lands before or after it by client id (Peritext's expand case).
 *
 * A paired mark is one operation written as two `ContentFormat` items:
 *
 * - its start, key `MARK_START + mark`, value `[v, l, c, k, side]`: the
 *   value (`null`: the mark removed over the range), the operation's
 *   Lamport timestamp, the operation id (the start item's id when it was
 *   written: a redo's copy keeps it) and its side;
 * - its end, key `MARK_END + mark`, value `[c, k, side]`: the id of the
 *   start it closes.
 *
 * An end closes only its own start. The value of a mark at a character is
 * the value of the open operation with the greatest `(l, c, k)` (Peritext's
 * rule): two overlapping same-value marks union, a later removal wins where
 * it covers, and ranges of different values never clip each other outside
 * their overlap.
 *
 * The side decides where a concurrent insert at the item's gap lands
 * (Peritext's anchors): `0` (left) attaches the item to the content before
 * it, so a concurrent insert there goes after it; `1` (right) attaches it to
 * the content after it, so the insert goes before it. Every write in a gap
 * — content (`insertInGap`), a mark's start or end — takes the gap's last
 * content item (deleted or not, never a format item) as its origin and the
 * gap's next live content item as its right origin, and the integration
 * orders the items of one origin left-side marks, then content, then
 * right-side marks (`markClass`), by client id within a class. So the
 * outcome never depends on client ids:
 *
 * - an expanding start (left side) takes a concurrent insert at its gap in;
 * - a non-expanding start (right side) leaves it out;
 * - an expanding end (right side) takes it in;
 * - a non-expanding end (left side) leaves it out.
 */
/** Key prefix of a paired mark's start item. */
export const MARK_START: "\u0001";
/** Key prefix of a paired mark's end item. */
export const MARK_END: "\u0002";
/** Side of a mark item attached to the content before it (`1`: to the content after it). */
export const SIDE_LEFT: 0;
/**
 * The open operations of one mark at a position: immutable, so a search
 * marker's format snapshot can share it with a cursor.
 */
export class MarkState {
    /**
     * @param {ReadonlyArray<{ c: number, k: number, v: any, l: number }>} ops
     */
    constructor(ops: ReadonlyArray<{
        c: number;
        k: number;
        v: any;
        l: number;
    }>);
    ops: readonly {
        c: number;
        k: number;
        v: any;
        l: number;
    }[];
    /**
     * The winning operation's value (`null`: the mark is off).
     * @type {any}
     */
    value: any;
}
export function pairedRole(content: {
    key: string;
}): number;
export function foldPaired(formats: Map<string, any>, content: {
    key: string;
    value: any;
}): boolean;
export function formatValue(value: any): any;
export function markClass(item: any): number;
export function sortsBefore(o: any, item: any): boolean;
