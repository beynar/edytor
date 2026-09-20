export function writeStructs(encoder: UpdateEncoderV1 | UpdateEncoderV2, structs: Array<GC | Item | Skip>, client: number, idranges: Array<IdRange>): void;
export function writeStructsFromIdSet(encoder: UpdateEncoderV1 | UpdateEncoderV2, store: StructStore, idset: IdSet): void;
export function writeStructsFromTransaction(encoder: UpdateEncoderV1 | UpdateEncoderV2, transaction: Transaction): void;
export function writeUpdateMessageFromTransaction(encoder: UpdateEncoderV1 | UpdateEncoderV2, transaction: Transaction): boolean;
import { Skip } from '../structs/Skip.js';
