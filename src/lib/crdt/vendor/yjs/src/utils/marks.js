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
export const MARK_START = '\u0001'
/** Key prefix of a paired mark's end item. */
export const MARK_END = '\u0002'

/** Side of a mark item attached to the content before it (`1`: to the content after it). */
export const SIDE_LEFT = 0

/**
 * The open operations of one mark at a position: immutable, so a search
 * marker's format snapshot can share it with a cursor.
 */
export class MarkState {
  /**
   * @param {ReadonlyArray<{ c: number, k: number, v: any, l: number }>} ops
   */
  constructor (ops) {
    this.ops = ops
    let best = ops[0]
    for (let i = 1; i < ops.length; i++) {
      const o = ops[i]
      if (o.l > best.l || (o.l === best.l && (o.c > best.c || (o.c === best.c && o.k > best.k)))) best = o
    }
    /**
     * The winning operation's value (`null`: the mark is off).
     * @type {any}
     */
    this.value = best === undefined ? null : best.v
  }
}

/**
 * `0` for a paired mark's start, `1` for its end, `-1` for any other format.
 *
 * @param {{ key: string }} content
 * @return {number}
 */
export const pairedRole = content => {
  const c = content.key.charCodeAt(0)
  return c === 1 ? 0 : c === 2 ? 1 : -1
}

/**
 * Fold a paired mark item into `formats` (a `currentFormats` map: mark →
 * `MarkState`). Returns whether the item was a paired mark.
 *
 * @param {Map<string,any>} formats
 * @param {{ key: string, value: any }} content
 * @return {boolean}
 */
export const foldPaired = (formats, content) => {
  const role = pairedRole(content)
  if (role < 0) return false
  const mark = content.key.slice(1)
  const prev = formats.get(mark)
  const ops = prev instanceof MarkState ? prev.ops : []
  const value = /** @type {Array<any>} */ (content.value)
  const c = role === 0 ? value[2] : value[0]
  const k = role === 0 ? value[3] : value[1]
  const rest = ops.filter(o => o.c !== c || o.k !== k)
  if (role === 0) rest.push({ c, k, v: value[0], l: value[1] })
  if (rest.length === 0) formats.delete(mark)
  else formats.set(mark, new MarkState(rest))
  return true
}

/**
 * The value a `currentFormats` entry renders (`null`: none).
 *
 * @param {any} value
 * @return {any}
 */
export const formatValue = value => value instanceof MarkState ? value.value : value

/**
 * The integration class of an item among the items of one origin: a
 * left-side mark item `0`, content and plain formats `1`, a right-side
 * mark item `2`. Deleted or collected items keep the class their content
 * gave them while it is there; a collected format item (its content gone)
 * would read `1`, which is why the fork never collects a paired mark item's
 * content (`ContentFormat#gc` keeps it).
 *
 * @param {any} item
 * @return {number}
 */
export const markClass = item => {
  const content = item.content
  if (content === undefined || typeof content.key !== 'string') return 1
  const role = pairedRole(content)
  if (role < 0) return 1
  const side = role === 0 ? content.value[4] : content.value[2]
  return side === SIDE_LEFT ? 0 : 2
}

/**
 * Whether `o` sorts before `item` among the items of one origin (the
 * integration's conflict rule): by class, then by client id as upstream.
 *
 * @param {any} o
 * @param {any} item
 * @return {boolean}
 */
export const sortsBefore = (o, item) => {
  const a = markClass(o)
  const b = markClass(item)
  return a !== b ? a < b : o.id.client < item.id.client
}
