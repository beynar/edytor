export class StackItem {
    /**
     * @param {IdSet} insertions
     * @param {IdSet} deletions
     */
    constructor(insertions: IdSet, deletions: IdSet);
    inserts: import("./ids.js").IdSet;
    deletes: import("./ids.js").IdSet;
    /**
     * Use this to save and restore metadata like selection range
     */
    meta: Map<any, any>;
}
/**
 * @typedef {Object} UndoManagerOptions
 * @property {number} [UndoManagerOptions.captureTimeout=500]
 * @property {function(Transaction):boolean} [UndoManagerOptions.captureTransaction] Do not capture changes of a Transaction if result false.
 * @property {function(Item):boolean} [UndoManagerOptions.deleteFilter=()=>true] Sometimes
 * it is necessary to filter what an Undo/Redo operation can delete. If this
 * filter returns false, the type/item won't be deleted even it is in the
 * undo/redo scope.
 * @property {Set<any>} [UndoManagerOptions.trackedOrigins=new Set([null])]
 * @property {boolean} [ignoreRemoteAttributeChanges] By default, the UndoManager will never overwrite remote changes. In some cases this might be the expected behavior. This property enables overwriting remote changes on attribute changes. (previously named `ignoreRemoteMapChanges`)
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
 * @property {Map<YNode,Array<YEvent<any>>>} StackItemEvent.changedParentTypes
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
export class UndoManager extends ObservableV2<{
    'stack-item-added': (arg0: StackItemEvent, arg1: UndoManager) => void;
    'stack-item-popped': (arg0: StackItemEvent, arg1: UndoManager) => void;
    'stack-cleared': (arg0: {
        undoStackCleared: boolean;
        redoStackCleared: boolean;
    }) => void;
    'stack-item-updated': (arg0: StackItemEvent, arg1: UndoManager) => void;
}> {
    /**
     * @param {Doc|YNode|Array<YNode>} typeScope Limits the scope of the UndoManager. If this is set to a ydoc instance, all changes on that ydoc will be undone. If set to a specific type, only changes on that type or its children will be undone. Also accepts an array of types.
     * @param {UndoManagerOptions} options
     */
    constructor(typeScope: Doc | YNode | Array<YNode>, { captureTimeout, captureTransaction, deleteFilter, trackedOrigins, ignoreRemoteAttributeChanges, restoreFilter, onApply, withdraw, doc }?: UndoManagerOptions);
    /**
     * @type {Array<YNode | Doc>}
     */
    scope: Array<YNode | Doc>;
    doc: Doc;
    deleteFilter: (arg0: Item) => boolean;
    restoreFilter: (arg0: Item, arg1: StackItem) => boolean;
    onApply: (arg0: Transaction, arg1: StackItem) => void;
    withdraw: (arg0: Item, arg1: StackItem, arg2: Transaction) => boolean;
    trackedOrigins: Set<any>;
    captureTransaction: (arg0: Transaction) => boolean;
    /**
     * @type {Array<StackItem>}
     */
    undoStack: Array<StackItem>;
    /**
     * @type {Array<StackItem>}
     */
    redoStack: Array<StackItem>;
    /**
     * Whether the client is currently undoing (calling UndoManager.undo)
     *
     * @type {boolean}
     */
    undoing: boolean;
    redoing: boolean;
    /**
     * The currently popped stack item if UndoManager.undoing or UndoManager.redoing
     *
     * @type {StackItem|null}
     */
    currStackItem: StackItem | null;
    lastChange: number;
    ignoreRemoteAttributeChanges: boolean;
    captureTimeout: number;
    /**
     * @param {Transaction} transaction
     */
    afterTransactionHandler: (transaction: Transaction) => void;
    /**
     * Extend the scope.
     *
     * @param {Array<YNode | Doc> | YNode | Doc} ynodes
     */
    addToScope(ynodes: Array<YNode | Doc> | YNode | Doc): void;
    /**
     * @param {any} origin
     */
    addTrackedOrigin(origin: any): void;
    /**
     * @param {any} origin
     */
    removeTrackedOrigin(origin: any): void;
    clear(clearUndoStack?: boolean, clearRedoStack?: boolean): void;
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
    stopCapturing(): void;
    /**
     * Undo last changes on type.
     *
     * @return {StackItem?} Returns StackItem if a change was applied
     */
    undo(): StackItem | null;
    /**
     * Redo last undo operation.
     *
     * @return {StackItem?} Returns StackItem if a change was applied
     */
    redo(): StackItem | null;
    /**
     * Are undo steps available?
     *
     * @return {boolean} `true` if undo is possible
     */
    canUndo(): boolean;
    /**
     * Are redo steps available?
     *
     * @return {boolean} `true` if redo is possible
     */
    canRedo(): boolean;
}
export function redoItem(transaction: Transaction, item: Item, redoitems: Set<Item>, itemsToDelete: IdSet, ignoreRemoteAttributeChanges: boolean, um: import("../utils/UndoManager.js").UndoManager): Item | null;
export function keepItem(item: Item | null, keep: boolean): void;
export type UndoManagerOptions = {
    captureTimeout?: number | undefined;
    /**
     * Do not capture changes of a Transaction if result false.
     */
    captureTransaction?: ((arg0: Transaction) => boolean) | undefined;
    /**
     * Sometimes
     * it is necessary to filter what an Undo/Redo operation can delete. If this
     * filter returns false, the type/item won't be deleted even it is in the
     * undo/redo scope.
     */
    deleteFilter?: ((arg0: Item) => boolean) | undefined;
    trackedOrigins?: Set<any> | undefined;
    /**
     * By default, the UndoManager will never overwrite remote changes. In some cases this might be the expected behavior. This property enables overwriting remote changes on attribute changes. (previously named `ignoreRemoteMapChanges`)
     */
    ignoreRemoteAttributeChanges?: boolean | undefined;
    /**
     * The document that this UndoManager operates on. Only needed if typeScope is empty.
     */
    doc?: Doc | undefined;
    /**
     * Whether popping the stack item may re-create the deleted item (default: always). // YP11
     */
    restoreFilter?: ((arg0: Item, arg1: StackItem) => boolean) | undefined;
    /**
     * Called inside the undo/redo transaction once the stack item is applied; its writes join the step. // YP11
     */
    onApply?: ((arg0: Transaction, arg1: StackItem) => void) | undefined;
    /**
     * Asked for every item a popped stack item would delete; `true` keeps it (the hook may write in its place, in the transaction) and counts as a change (default: never). // YP12
     */
    withdraw?: ((arg0: Item, arg1: StackItem, arg2: Transaction) => boolean) | undefined;
};
export type StackItemEvent = {
    stackItem: StackItem;
    origin: any;
    type: "undo" | "redo";
    changedParentTypes: Map<YNode, Array<YEvent<any>>>;
};
import { ObservableV2 } from 'lib0-v14/observable';
import { YNode } from '../ynode.js';
import { Doc } from './Doc.js';
import { Item } from '../structs/Item.js';
