export function redoItem(transaction: Transaction, item: Item, redoitems: Set<Item>, itemsToDelete: IdSet, deletedByHistory?: (arg0: ID) => boolean): Item | null;
export function keepItem(item: Item | null, keep: boolean): void;
import { Item } from '../structs/Item.js';
