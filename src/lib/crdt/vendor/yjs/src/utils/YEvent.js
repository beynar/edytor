/**
 * YEvent describes the changes on a YNode.
 */
export class YEvent {
  /**
   * @param {YNode} target The changed type.
   * @param {import('./Transaction.js').Transaction} transaction
   * @param {Set<any>?} subs The keys that changed
   */
  constructor (target, transaction, subs) {
    /**
     * The type on which this event was created on.
     * @type {import('../ynode.js').YNode}
     */
    this.target = target
    /**
     * The current target on which the observe callback is called.
     * @type {YNode}
     */
    this.currentTarget = target
    /**
     * The transaction that triggered this event.
     * @type {import('./Transaction.js').Transaction}
     */
    this.transaction = transaction
    /**
     * Whether the children changed.
     * @type {Boolean}
     * @private
     */
    this.childListChanged = false
    /**
     * Set of all changed attributes.
     * @type {Set<string>}
     */
    this.keysChanged = new Set()
    subs?.forEach((sub) => {
      if (sub === null) {
        this.childListChanged = true
      } else {
        this.keysChanged.add(sub)
      }
    })
  }

  /**
   * Check if a struct is deleted by this event.
   *
   * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
   *
   * @param {AbstractStruct} struct
   * @return {boolean}
   */
  deletes (struct) {
    return this.transaction.deleteSet.hasId(struct.id)
  }

  /**
   * Check if a struct is added by this event.
   *
   * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
   *
   * @param {AbstractStruct} struct
   * @return {boolean}
   */
  adds (struct) {
    return this.transaction.insertSet.hasId(struct.id)
  }
}
