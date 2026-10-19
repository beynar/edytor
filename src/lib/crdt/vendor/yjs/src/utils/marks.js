/**
 * @typedef {import('./Transaction.js').Transaction} Transaction
 */

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
 * mark item `2`, a claim item `3` (YP21: a sequence unit `{ m }`, after
 * everything else, so content and boundaries a concurrent writer puts at
 * its origin land before it), a move record `4` or `5` by its side (YP22:
 * after every slot of its origin — a split's pieces first — and a record
 * standing after what precedes it before one standing before what follows
 * it: the order every serial run of the gestures gives). Deleted or collected items keep the class
 * their content gave them while it is there; a collected item (its content
 * gone) would read `1`, which is why the fork never collects the content of
 * an item of another class (`Item#gc` keeps it).
 *
 * @param {any} item
 * @return {number}
 */
export const markClass = item => {
  const content = item.content
  if (content === undefined) return 1
  if (content.cls !== undefined) return content.cls // YP29: a collected mark or claim (`ContentDeleted`)
  if (typeof content.key !== 'string') {
    // YP22: a move record (its side: 0 after, 1 before)
    if (content.priority !== undefined && content.ids !== undefined) return 4 + content.side
    // YP21: a claim item
    return item.parentSub === null && typeof content.arr?.[0]?.m === 'string' ? 3 : 1
  }
  const role = pairedRole(content)
  if (role < 0) return 1
  const side = role === 0 ? content.value[4] : content.value[2]
  return side === SIDE_LEFT ? 0 : 2
}

/**
 * YP22: the unit id `client:clock` names, as its item and clock, `null` where
 * a GC struct replaced it.
 *
 * @param {import('./StructStore.js').StructStore} store
 * @param {number} client
 * @param {number} clock
 * @return {{ item: any, clock: number } | null}
 */
const unitAt = (store, client, clock) => {
  const item = store.getItem({ client, clock })
  return item.isItem ? { item, clock } : null
}

/**
 * YP22: the order of two units (`unitAt`): by clock in one item, else by
 * `sequenceOrder` (`NaN`: not in one sequence); `0` for one unit.
 *
 * @param {{ item: any, clock: number }} p
 * @param {{ item: any, clock: number }} q
 * @return {number}
 */
const unitOrder = (p, q) => (p.item === q.item ? p.clock - q.clock : sequenceOrder(p.item, q.item))

/**
 * YP22: a block slot's split key (`{ b, s: [client, clock] }`: the id of the
 * boundary item of the split that made the block, kept when the slot is
 * collected, `Item#gc`) as a unit (`unitAt`: `null` where a GC struct
 * replaced the boundary), `undefined` for any other item (a slot no split
 * made, a boundary, whose own `s` names a block).
 *
 * @param {any} item
 * @param {import('./StructStore.js').StructStore} store
 * @return {{ item: any, clock: number } | null | undefined}
 */
const splitKey = (item, store) => {
  const s = item.content.arr?.[0]?.s
  return Array.isArray(s) ? unitAt(store, s[0], s[1]) : undefined
}

/**
 * YP22: whether `item` is a list item outside a text (a block's or an
 * array's slot: its parent is no `content` node) written by the writer of
 * its origin: it extends that writer's run there, and sorts before every
 * other writer's slot of the same origin (`order.insert.run`: the lines one
 * writer types after its own line stay together around a peer's line
 * inserted there meanwhile). Read from the item's ids and parent, which
 * collection never changes, so every replica integrates alike.
 *
 * @param {any} item
 * @return {boolean}
 */
const extendsRun = (/** @type {Item} */ item) =>
  item.parentSub === null && /** @type {YNode} */ (item.parent).name !== 'content' && item.origin !== null && item.origin.client === item.id.client

/**
 * YP22: the order of two items of one sequence (one parent, one key):
 * negative when `x` stands before `y`, positive after, `0` for one item,
 * `NaN` when they are not in one sequence. The walk goes left from both at
 * once, so it costs the distance between them.
 *
 * @param {any} x
 * @param {any} y
 * @return {number}
 */
export const sequenceOrder = (x, y) => {
  if (x === y) return 0
  if (x.parent !== y.parent || x.parentSub !== y.parentSub) return NaN
  for (let l = x, r = y; ;) {
    l = l.left
    r = r.left
    if (l === y || r === null) return 1
    if (r === x || l === null) return -1
  }
}

/**
 * YP22: the chain record `r` stands at, outermost first — the units its
 * writer named (`at`: the home slots from the root sequence down to the unit
 * it stands at), else the first unit it moves — each as its item and clock,
 * `null` where a GC struct replaced it.
 *
 * @param {any} r
 * @param {import('./StructStore.js').StructStore} store
 * @return {Array<{ item: any, clock: number } | null>}
 */
const chainOf = (r, store) => {
  const c = r.content
  return c.at !== null
    ? c.at.map((/** @type {ID} */ id) => unitAt(store, id.client, id.clock))
    : c.ids.length > 0 ? [unitAt(store, c.ids[0], c.ids[1])] : []
}

/**
 * YP22: the order of two move records at one origin: by the chains they
 * stand at (`chainOf`), level by level from the root — two units of one
 * sequence by `sequenceOrder` (one item: by clock), a unit before the units
 * inside its block (the shorter chain first); chains that meet no common
 * sequence order nothing — then by their `part` (the writer's order among
 * the records standing at one unit), then the stronger record first (the
 * greater priority, then client: a unit both move shows at the first of the
 * two). Two writers that move blocks out of one list into one gap at once (an
 * outdent, a lift, a divider after an item) keep the list's order there and
 * every serial order's placement of what stands at one item, whatever their
 * client ids (the delete contract's CW-01 and DR-crdt-6 rules). It reads only
 * the records and the units they name, all present when a record integrates
 * (`getMissing`), so every replica sorts alike in any delivery order.
 *
 * @param {any} o
 * @param {any} item
 * @param {Transaction} tr
 * @return {number}
 */
const sourceOrder = (o, item, tr) => {
  const store = tr.doc.store
  const x = chainOf(o, store)
  const y = chainOf(item, store)
  let d = 0
  for (let i = 0; ; i++) {
    const p = x[i]
    const q = y[i]
    if (p === undefined || q === undefined) {
      d = (p === undefined ? 0 : 1) - (q === undefined ? 0 : 1)
      break
    }
    if (p === null || q === null) break
    d = unitOrder(p, q)
    if (d === 0) continue
    if (Number.isNaN(d)) d = 0
    break
  }
  if (d === 0) d = o.content.part - item.content.part
  if (d === 0) d = item.content.priority - o.content.priority || item.id.client - o.id.client
  return d
}

/**
 * Whether `o` sorts before `item` among the items of one origin (the
 * integration's conflict rule): by class, then (YP22) block slots by their
 * split key and the origin writer's own first, records by `sourceOrder`,
 * then by client id as upstream.
 *
 * @param {any} o
 * @param {any} item
 * @param {Transaction} tr
 * @return {boolean}
 */
export const sortsBefore = (o, item, tr) => {
  const a = markClass(o)
  const b = markClass(item)
  if (a !== b) return a < b
  if (a === 1) {
    // YP22: block slots a split made sort by their boundaries' order in the
    // text (two writers' splits of one block keep its text's order), before
    // the slots no split made; then the origin writer's own slots first.
    const store = tr.doc.store
    const x = splitKey(o, store)
    const y = splitKey(item, store)
    if (x !== undefined || y !== undefined) {
      if (x === undefined || y === undefined) return y === undefined
      if (x !== null && y !== null) {
        // One total order over the keyed slots of an origin: the boundaries' text
        // first (by the text node's item id, a root text first), then their place in
        // it (two boundaries one item holds: their clocks).
        const px = /** @type {YNode} */ (x.item.parent)._item
        const py = /** @type {YNode} */ (y.item.parent)._item
        if (x.item.parent !== y.item.parent) {
          if (px === null || py === null) return px === null
          return (px.id.client - py.id.client || px.id.clock - py.id.clock) < 0
        }
        const d = unitOrder(x, y)
        if (d !== 0) return d < 0
      }
    }
    const run = extendsRun(o)
    if (run !== extendsRun(item)) return run
  } else if (a >= 4) {
    const d = sourceOrder(o, item, tr)
    if (d !== 0) return d < 0
  }
  return o.id.client < item.id.client
}
