export function writeStructs(encoder: UpdateEncoder, structs: Array<GC | Item | Skip>, client: number, idranges: Array<IdRange>): void;
export function writeStructsFromIdSet(encoder: UpdateEncoder, store: StructStore, idset: IdSet): void;
export function writeStructsFromTransaction(encoder: UpdateEncoder, transaction: Transaction): void;
export function writeUpdateMessageFromTransaction(encoder: UpdateEncoder, transaction: Transaction): boolean;
import { Skip } from '../structs/Skip.js';
