/**
 * Test-only: the engine's UndoManager as the fork carried it before YP18 (UPSTREAM.md).
 *
 * The fork ships no undo manager: the document's history is edytor's
 * (`src/lib/crdt/doc/history.ts`), over the engine's `redoItem` and `keepItem`.
 * The tests that exercise the engine's undo on raw documents (the upstream
 * suite, the replica harness's `raw` adapter, the engine probes) construct this
 * one instead, with its YP11/YP12 hooks. `ignoreRemoteAttributeChanges` is gone
 * with the fork's `redoItem` parameter. Never imported by `src/lib`.
 */
import * as time from 'lib0-v14/time';
import * as array from 'lib0-v14/array';
import { ObservableV2 } from 'lib0-v14/observable';

import * as Fork from '../../../lib/crdt/vendor/yjs/src/index.js';

/**
 * The UndoManager class over engine `Y` (the fork's namespace, or a copy of its tree).
 *
 * @param {any} Y
 */
/**
 * The types a transaction changed and their ancestors (what the engine's
 * deep observers collected as `changedParentTypes` before YP19).
 *
 * @param {any} tr
 * @return {Map<any, Array<any>>}
 */
const changedParentTypesOf = (tr) => {
	const out = new Map();
	for (const type of tr.changed.keys())
		for (let t = type; t; t = t._item?.parent ?? null) if (!out.has(t)) out.set(t, []);
	return out;
};

export const undoManagerOf = (Y) => {
	const {
		mergeIdSets,
		iterateStructsByIdSet,
		Item,
		followRedone,
		transact,
		createID,
		isParentOf,
		getItemCleanStart,
		Doc,
		Node: YNode,
		redoItem,
		keepItem
	} = Y;
	class StackItem {
		/**
		 * @param {IdSet} insertions
		 * @param {IdSet} deletions
		 */
		constructor(insertions, deletions) {
			this.inserts = insertions;
			this.deletes = deletions;
			/**
			 * Use this to save and restore metadata like selection range
			 */
			this.meta = new Map();
		}
	}
	/**
	 * @param {Transaction} tr
	 * @param {UndoManager} um
	 * @param {StackItem} stackItem
	 */
	const clearUndoManagerStackItem = (tr, um, stackItem) => {
		iterateStructsByIdSet(tr, stackItem.deletes, (item) => {
			if (
				item instanceof Item &&
				um.scope.some((type) => type === tr.doc || isParentOf(/** @type {YNode} */ (type), item))
			) {
				keepItem(item, false);
			}
		});
	};

	/**
	 * @param {UndoManager} undoManager
	 * @param {Array<StackItem>} stack
	 * @param {'undo'|'redo'} eventType
	 * @return {StackItem?}
	 */
	const popStackItem = (undoManager, stack, eventType) => {
		/**
		 * Keep a reference to the transaction so we can fire the event with the changedParentTypes
		 * @type {any}
		 */
		let _tr = null;
		const doc = undoManager.doc;
		const scope = undoManager.scope;
		transact(
			doc,
			(transaction) => {
				while (stack.length > 0 && undoManager.currStackItem === null) {
					const store = doc.store;
					const stackItem = /** @type {StackItem} */ (stack.pop());
					/**
					 * @type {Set<Item>}
					 */
					const itemsToRedo = new Set();
					/**
					 * @type {Array<Item>}
					 */
					const itemsToDelete = [];
					let performedChange = false;
					iterateStructsByIdSet(transaction, stackItem.inserts, (struct) => {
						if (struct instanceof Item) {
							if (struct.redone !== null) {
								let { item, diff } = followRedone(store, struct.id);
								if (diff > 0) {
									item = getItemCleanStart(
										transaction,
										createID(item.id.client, item.id.clock + diff)
									);
								}
								struct = item;
							}
							if (
								!struct.deleted &&
								scope.some(
									(type) =>
										type === transaction.doc ||
										isParentOf(/** @type {YNode} */ (type), /** @type {Item} */ (struct))
								)
							) {
								itemsToDelete.push(struct);
							}
						}
					});
					iterateStructsByIdSet(transaction, stackItem.deletes, (struct) => {
						if (
							struct instanceof Item &&
							scope.some(
								(type) =>
									type === transaction.doc || isParentOf(/** @type {YNode} */ (type), struct)
							) &&
							// Never redo structs in stackItem.insertions because they were created and deleted in the same capture interval.
							!stackItem.inserts.hasId(struct.id)
						) {
							// YP11 begin
							if (!undoManager.restoreFilter(struct, stackItem)) {
								// withheld (its owner restores it, or not): the step still applies
								performedChange = true;
								return;
							}
							// YP11 end
							itemsToRedo.add(struct);
						}
					});
					itemsToRedo.forEach((struct) => {
						performedChange =
							redoItem(
								transaction,
								struct,
								itemsToRedo,
								stackItem.inserts,
								(id) =>
									isDeletedByUndoStack(undoManager.undoStack, id) ||
									isDeletedByUndoStack(undoManager.redoStack, id)
							) !== null || performedChange;
					});
					// We want to delete in reverse order so that children are deleted before
					// parents, so we have more information available when items are filtered.
					for (let i = itemsToDelete.length - 1; i >= 0; i--) {
						const item = itemsToDelete[i];
						// YP12 begin
						if (undoManager.withdraw(item, stackItem, transaction)) {
							// kept (the document may have written in its place): the step still applies
							performedChange = true;
							continue;
						}
						// YP12 end
						if (undoManager.deleteFilter(item)) {
							item.delete(transaction);
							performedChange = true;
						}
					}
					undoManager.currStackItem = performedChange ? stackItem : null;
					if (performedChange) undoManager.onApply(transaction, stackItem); // YP11
				}
				transaction.changed.forEach((subProps, type) => {
					// destroy search marker if necessary
					if (subProps.has(null) && type._searchMarker) {
						type._searchMarker.length = 0;
					}
				});
				_tr = transaction;
			},
			undoManager
		);
		const res = undoManager.currStackItem;
		if (res != null) {
			const changedParentTypes = changedParentTypesOf(_tr);
			undoManager.emit('stack-item-popped', [
				{ stackItem: res, type: eventType, changedParentTypes, origin: undoManager },
				undoManager
			]);
			undoManager.currStackItem = null;
		}
		return res;
	};

	/**
	 * @typedef {Object} UndoManagerOptions
	 * @property {number} [UndoManagerOptions.captureTimeout=500]
	 * @property {function(Transaction):boolean} [UndoManagerOptions.captureTransaction] Do not capture changes of a Transaction if result false.
	 * @property {function(Item):boolean} [UndoManagerOptions.deleteFilter=()=>true] Sometimes
	 * it is necessary to filter what an Undo/Redo operation can delete. If this
	 * filter returns false, the type/item won't be deleted even it is in the
	 * undo/redo scope.
	 * @property {Set<any>} [UndoManagerOptions.trackedOrigins=new Set([null])]
	 * @property {Doc} [doc] The document that this UndoManager operates on. Only needed if typeScope is empty.
	 * @property {function(Item,StackItem):boolean} [restoreFilter] Whether popping the stack item may re-create the deleted item (default: always). // YP11
	 * @property {function(Transaction,StackItem):void} [onApply] Called inside the undo/redo transaction once the stack item is applied; its writes join the step. // YP11
	 * @property {function(Item,StackItem,Transaction):boolean} [withdraw] Asked for every item a popped stack item would delete; `true` keeps it (the hook may write in its place, in the transaction) and counts as a change (default: never). // YP12
	 */

	/**
	 * @typedef {Object} StackItemEvent
	 * @property {StackItem} StackItemEvent.stackItem
	 * @property {any} StackItemEvent.origin
	 * @property {'undo'|'redo'} StackItemEvent.type
	 * @property {Map<YNode,Array<YEvent>>} StackItemEvent.changedParentTypes
	 */

	/**
	 * Fires 'stack-item-added' event when a stack item was added to either the undo- or
	 * the redo-stack. You may store additional stack information via the
	 * metadata property on `event.stackItem.meta` (it is a `Map` of metadata properties).
	 * Fires 'stack-item-popped' event when a stack item was popped from either the
	 * undo- or the redo-stack. You may restore the saved stack information from `event.stackItem.meta`.
	 *
	 * @extends {ObservableV2<{'stack-item-added':function(StackItemEvent, UndoManager):void, 'stack-item-popped': function(StackItemEvent, UndoManager):void, 'stack-cleared': function({ undoStackCleared: boolean, redoStackCleared: boolean }):void, 'stack-item-updated': function(StackItemEvent, UndoManager):void }>}
	 */
	class UndoManager extends ObservableV2 {
		/**
		 * @param {Doc|YNode|Array<YNode>} typeScope Limits the scope of the UndoManager. If this is set to a ydoc instance, all changes on that ydoc will be undone. If set to a specific type, only changes on that type or its children will be undone. Also accepts an array of types.
		 * @param {UndoManagerOptions} options
		 */
		constructor(
			typeScope,
			{
				captureTimeout = 500,
				captureTransaction = (_tr) => true,
				deleteFilter = () => true,
				trackedOrigins = new Set([null]),
				restoreFilter = () => true, // YP11
				onApply = () => {}, // YP11
				withdraw = () => false, // YP12
				doc = /** @type {Doc} */ (
					array.isArray(typeScope)
						? typeScope[0].doc
						: typeScope instanceof Doc
							? typeScope
							: typeScope.doc
				)
			} = {}
		) {
			super();
			/**
			 * @type {Array<YNode | Doc>}
			 */
			this.scope = [];
			this.doc = doc;
			this.addToScope(typeScope);
			this.deleteFilter = deleteFilter;
			this.restoreFilter = restoreFilter; // YP11
			this.onApply = onApply; // YP11
			this.withdraw = withdraw; // YP12
			trackedOrigins.add(this);
			this.trackedOrigins = trackedOrigins;
			this.captureTransaction = captureTransaction;
			/**
			 * @type {Array<StackItem>}
			 */
			this.undoStack = [];
			/**
			 * @type {Array<StackItem>}
			 */
			this.redoStack = [];
			/**
			 * Whether the client is currently undoing (calling UndoManager.undo)
			 *
			 * @type {boolean}
			 */
			this.undoing = false;
			this.redoing = false;
			/**
			 * The currently popped stack item if UndoManager.undoing or UndoManager.redoing
			 *
			 * @type {StackItem|null}
			 */
			this.currStackItem = null;
			this.lastChange = 0;
			this.captureTimeout = captureTimeout;
			/**
			 * @param {Transaction} transaction
			 */
			this.afterTransactionHandler = (transaction) => {
				// Only track certain transactions
				if (
					!this.captureTransaction(transaction) ||
					!this.scope.some(
						(type) =>
							changedParentTypesOf(transaction).has(/** @type {YNode} */ (type)) ||
							type === this.doc
					) ||
					(!this.trackedOrigins.has(transaction.origin) &&
						(!transaction.origin || !this.trackedOrigins.has(transaction.origin.constructor)))
				) {
					return;
				}
				const undoing = this.undoing;
				const redoing = this.redoing;
				const stack = undoing ? this.redoStack : this.undoStack;
				if (undoing) {
					this.stopCapturing(); // next undo should not be appended to last stack item
				} else if (!redoing) {
					// neither undoing nor redoing: delete redoStack
					this.clear(false, true);
				}
				const insertions = transaction.insertSet;
				const now = time.getUnixTime();
				let didAdd = false;
				if (
					this.lastChange > 0 &&
					now - this.lastChange < this.captureTimeout &&
					stack.length > 0 &&
					!undoing &&
					!redoing
				) {
					// append change to last stack op
					const lastOp = stack[stack.length - 1];
					lastOp.deletes = mergeIdSets([lastOp.deletes, transaction.deleteSet]);
					lastOp.inserts = mergeIdSets([lastOp.inserts, insertions]);
				} else {
					// create a new stack op
					stack.push(new StackItem(insertions, transaction.deleteSet));
					didAdd = true;
				}
				if (!undoing && !redoing) {
					this.lastChange = now;
				}
				// make sure that deleted structs are not gc'd
				iterateStructsByIdSet(
					transaction,
					transaction.deleteSet,
					/** @param {Item|GC} item */ (item) => {
						if (
							item instanceof Item &&
							this.scope.some(
								(type) => type === transaction.doc || isParentOf(/** @type {YNode} */ (type), item)
							)
						) {
							keepItem(item, true);
						}
					}
				);
				/**
				 * @type {[StackItemEvent, UndoManager]}
				 */
				const changeEvent = [
					{
						stackItem: stack[stack.length - 1],
						origin: transaction.origin,
						type: undoing ? 'redo' : 'undo',
						changedParentTypes: changedParentTypesOf(transaction)
					},
					this
				];
				if (didAdd) {
					this.emit('stack-item-added', changeEvent);
				} else {
					this.emit('stack-item-updated', changeEvent);
				}
			};
			this.destroy = this.destroy.bind(this);
			this.doc.on('afterTransaction', this.afterTransactionHandler);
			this.doc.on('destroy', this.destroy);
		}

		/**
		 * Extend the scope.
		 *
		 * @param {Array<YNode | Doc> | YNode | Doc} ynodes
		 */
		addToScope(ynodes) {
			const tmpSet = new Set(this.scope);
			ynodes = array.isArray(ynodes) ? ynodes : [ynodes];
			ynodes.forEach((ynode) => {
				if (!tmpSet.has(ynode)) {
					tmpSet.add(ynode);
					if (ynode instanceof YNode ? ynode.doc !== this.doc : ynode !== this.doc)
						console.warn('[yjs#509] Not same Y.Doc'); // YP15. use MultiDocUndoManager instead. also see https://github.com/yjs/yjs/issues/509
					this.scope.push(ynode);
				}
			});
		}

		/**
		 * @param {any} origin
		 */
		addTrackedOrigin(origin) {
			this.trackedOrigins.add(origin);
		}

		/**
		 * @param {any} origin
		 */
		removeTrackedOrigin(origin) {
			this.trackedOrigins.delete(origin);
		}

		clear(clearUndoStack = true, clearRedoStack = true) {
			if ((clearUndoStack && this.canUndo()) || (clearRedoStack && this.canRedo())) {
				this.doc.transact((tr) => {
					if (clearUndoStack) {
						this.undoStack.forEach((item) => clearUndoManagerStackItem(tr, this, item));
						this.undoStack = [];
					}
					if (clearRedoStack) {
						this.redoStack.forEach((item) => clearUndoManagerStackItem(tr, this, item));
						this.redoStack = [];
					}
					this.emit('stack-cleared', [
						{ undoStackCleared: clearUndoStack, redoStackCleared: clearRedoStack }
					]);
				});
			}
		}

		/**
		 * UndoManager merges Undo-StackItem if they are created within time-gap
		 * smaller than `options.captureTimeout`. Call `um.stopCapturing()` so that the next
		 * StackItem won't be merged.
		 *
		 *
		 * @example
		 *     // without stopCapturing
		 *     ytext.insert(0, 'a')
		 *     ytext.insert(1, 'b')
		 *     um.undo()
		 *     ytext.toString() // => '' (note that 'ab' was removed)
		 *     // with stopCapturing
		 *     ytext.insert(0, 'a')
		 *     um.stopCapturing()
		 *     ytext.insert(0, 'b')
		 *     um.undo()
		 *     ytext.toString() // => 'a' (note that only 'b' was removed)
		 *
		 */
		stopCapturing() {
			this.lastChange = 0;
		}

		/**
		 * Undo last changes on type.
		 *
		 * @return {StackItem?} Returns StackItem if a change was applied
		 */
		undo() {
			this.undoing = true;
			let res;
			try {
				res = popStackItem(this, this.undoStack, 'undo');
			} finally {
				this.undoing = false;
			}
			return res;
		}

		/**
		 * Redo last undo operation.
		 *
		 * @return {StackItem?} Returns StackItem if a change was applied
		 */
		redo() {
			this.redoing = true;
			let res;
			try {
				res = popStackItem(this, this.redoStack, 'redo');
			} finally {
				this.redoing = false;
			}
			return res;
		}

		/**
		 * Are undo steps available?
		 *
		 * @return {boolean} `true` if undo is possible
		 */
		canUndo() {
			return this.undoStack.length > 0;
		}

		/**
		 * Are redo steps available?
		 *
		 * @return {boolean} `true` if redo is possible
		 */
		canRedo() {
			return this.redoStack.length > 0;
		}

		destroy() {
			this.trackedOrigins.delete(this);
			this.doc.off('afterTransaction', this.afterTransactionHandler);
			this.doc.off('destroy', this.destroy);
			super.destroy();
		}
	}

	/**
	 * @param {Array<StackItem>} stack
	 * @param {ID} id
	 */
	const isDeletedByUndoStack = (stack, id) =>
		array.some(stack, /** @param {StackItem} s */ (s) => s.deletes.hasId(id));
	return UndoManager;
};

/** Over the fork. */
export const UndoManager = undoManagerOf(Fork);
