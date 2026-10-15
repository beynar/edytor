/**
 * Schema generation 8: a merge claim is an item in a backing text (fork patch
 * YP21, generation 8), a text delete is its writer's hold record (fork patch
 * YP20, generation 7), and one update encoding (the engine's columnar one,
 * generation 6) on the wire and in storage. A frame, a container or a state
 * of an earlier generation is refused, never converted. The fixture
 * `fixtures/generation-4/state.v2.bin` was written by 0.1.0-next.24 (its
 * state in the columnar encoding).
 *
 * - frames and containers of generations 5 to 7 are refused before decode,
 *   as any other generation's;
 * - a state of an earlier generation is never loaded as this one's;
 * - a SyncStep2 and an Update carry the same encoding: what
 *   `encodeStateAsUpdate` and the engine's `update` event produce.
 */
// @ts-nocheck -- tests import vendored engine JS directly (excluded lane).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import { Y } from '../../../lib/crdt/engine.js';
import {
	bindCrdt,
	createDocument,
	defaultSemantics,
	loadDocument
} from '../../../lib/crdt/index.js';
import { GENERATION, GENERATION_RECORD, SCHEMA_VERSION } from '../../../lib/crdt/protocol.js';
import { isGenerationRecord, readProtocolVersion } from '../../../lib/crdt/protocols/envelope.js';

const crdt = bindCrdt(Y);
const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`../fixtures/generation-4/${name}`, import.meta.url)));
const VALUE = JSON.parse(new TextDecoder().decode(fixture('value.json')));

describe('generation 8', () => {
	it('is schema 8, wire word 14008; no other generation’s record is this one’s', () => {
		expect(SCHEMA_VERSION).toBe(8);
		expect(GENERATION).toBe(14008);
		expect(isGenerationRecord(GENERATION_RECORD)).toBe(true);
		expect(isGenerationRecord({ ...GENERATION_RECORD, schema: 7 })).toBe(false);
		expect(isGenerationRecord({ ...GENERATION_RECORD, schema: 6 })).toBe(false);
		expect(isGenerationRecord({ ...GENERATION_RECORD, schema: 5 })).toBe(false);
		expect(isGenerationRecord({ ...GENERATION_RECORD, schema: 5, storage: 'v2' })).toBe(false);
		expect(isGenerationRecord({ engine: 'yjs-v14', protocol: 14 })).toBe(false);
	});

	it('a frame of generation 5, 6 or 7 is refused before anything is decoded', () => {
		for (const word of [14005, 14006, 14007]) {
			const old = encoding.encode((e) => {
				encoding.writeVarUint(e, word);
				encoding.writeVarUint(e, 0);
			});
			expect(readProtocolVersion(decoding.createDecoder(old))).toBe(false);
		}
	});

	it('a state of an earlier generation is never loaded as this generation’s', () => {
		expect(() => loadDocument(fixture('state.v2.bin'))).toThrow(/unsupported schema version 4/);
		// A generation-7 state: its version record says 7.
		const raw = new Y.Doc();
		Y.applyUpdate(raw, Y.encodeStateAsUpdate(createDocument({ value: VALUE }).doc));
		raw.get('meta').setAttr('v', 7);
		expect(() => loadDocument(Y.encodeStateAsUpdate(raw))).toThrow(/unsupported schema version 7/);
	});
});

describe('one update encoding', () => {
	it('writeSyncStep2 writes the state as encodeStateAsUpdate does; the reader applies it', () => {
		const a = createDocument({ value: VALUE, semantics: defaultSemantics });
		const encoder = encoding.createEncoder();
		crdt.sync.writeSyncStep2(encoder, a.doc);
		const decoder = decoding.createDecoder(encoding.toUint8Array(encoder));
		expect(decoding.readVarUint(decoder)).toBe(crdt.sync.messageYjsSyncStep2);
		const payload = decoding.readVarUint8Array(decoder);
		expect(Buffer.from(payload).equals(Buffer.from(Y.encodeStateAsUpdate(a.doc)))).toBe(true);
		const b = new Y.Doc();
		crdt.sync.applyRemote(b, payload, 'remote');
		expect(
			Buffer.from(Y.encodeStateVector(b)).equals(Buffer.from(Y.encodeStateVector(a.doc)))
		).toBe(true);
		a.destroy();
	});

	it('the updates the engine emits merge and apply as a state does', () => {
		const a = createDocument({ value: VALUE, semantics: defaultSemantics });
		const b = loadDocument(Y.encodeStateAsUpdate(a.doc));
		const updates: Uint8Array[] = [];
		a.doc.on('update', (u: Uint8Array) => updates.push(u));
		const first = a.facade.toJSON().children[0].id;
		a.facade.insertText(first, 0, 'one ');
		a.facade.insertText(first, 0, 'two ');
		expect(updates).toHaveLength(2);
		Y.applyUpdate(b.doc, Y.mergeUpdates(updates), 'remote');
		expect(b.facade.toJSON()).toEqual(a.facade.toJSON());
		a.destroy();
		b.destroy();
	});
});
