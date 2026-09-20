export class Snapshot {
    /**
     * @param {IdSet} ds
     * @param {Map<number,number>} sv state map
     */
    constructor(ds: IdSet, sv: Map<number, number>);
    /**
     * @type {IdSet}
     */
    ds: IdSet;
    /**
     * State Map
     * @type {Map<number,number>}
     */
    sv: Map<number, number>;
}
export function equalSnapshots(snap1: Snapshot, snap2: Snapshot): boolean;
export function encodeSnapshotV2(snapshot: Snapshot, encoder?: IdSetEncoderV1 | IdSetEncoderV2): Uint8Array;
export function encodeSnapshot(snapshot: Snapshot): Uint8Array;
export function decodeSnapshotV2(buf: Uint8Array, decoder?: IdSetDecoderV1 | IdSetDecoderV2): Snapshot;
export function decodeSnapshot(buf: Uint8Array): Snapshot;
export function createSnapshot(ds: IdSet, sm: Map<number, number>): Snapshot;
export const emptySnapshot: Snapshot;
export function snapshot(doc: Doc): Snapshot;
export function splitSnapshotAffectedStructs(transaction: Transaction, snapshot: Snapshot): void;
export function createDocFromSnapshot(originDoc: Doc, snapshot: Snapshot, newDoc?: Doc): Doc;
export function snapshotContainsUpdateV2(snapshot: Snapshot, update: Uint8Array, YDecoder?: typeof UpdateDecoderV2 | typeof UpdateDecoderV1): boolean;
export function snapshotContainsUpdate(snapshot: Snapshot, update: Uint8Array): boolean;
import { IdSetEncoderV1 } from './UpdateEncoder.js';
import { IdSetEncoderV2 } from './UpdateEncoder.js';
import { IdSetDecoderV1 } from './UpdateDecoder.js';
import { IdSetDecoderV2 } from './UpdateDecoder.js';
import { Doc } from './Doc.js';
import { UpdateDecoderV2 } from './UpdateDecoder.js';
import { UpdateDecoderV1 } from './UpdateDecoder.js';
