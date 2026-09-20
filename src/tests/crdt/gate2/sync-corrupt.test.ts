// @ts-nocheck
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindIndexeddbProvider } from '../../../lib/crdt/providers/indexeddb.js';
import * as encoding from 'lib0-v14/encoding';
import * as bc from 'lib0-v14/broadcastchannel';
import { writeProtocolVersion, generationDbName } from '../../../lib/crdt/protocols/envelope.js';

const providers = bindIndexeddbProvider(Y);
test('corrupt update payload inside a valid v14 envelope', async () => {
	const doc = new Y.Doc();
	const p = new providers.IndexeddbPersistence('corrupt-payload-x', doc);
	await p.whenSynced;
	const events = { mismatch: 0, msgErr: 0 };
	p.on('protocol-mismatch', () => events.mismatch++);
	p.on('message-error', () => events.msgErr++);
	const errors = [];
	const origErr = console.error;
	console.error = (...a) => {
		errors.push(a);
	};
	const e = encoding.createEncoder();
	writeProtocolVersion(e);
	encoding.writeVarUint(e, 0); // messageSync
	encoding.writeVarUint(e, 2); // syncUpdate
	encoding.writeVarUint8Array(e, new Uint8Array([9, 9, 9, 9, 9])); // garbage update
	bc.publish(generationDbName('corrupt-payload-x'), encoding.toUint8Array(e).slice().buffer, 'x');
	await new Promise((r) => setTimeout(r, 30));
	console.error = origErr;
	console.log('events:', JSON.stringify(events), 'console.error calls:', errors.length);
	// CONTRACT: a corrupt payload inside a VALID v14 envelope is a
	// per-message failure → 'message-error'. Today readSyncStep2's catch
	// writes console.error only (sync.ts:61-74) — no provider event, so a
	// consumer cannot observe, count, or alarm on corrupt sync traffic.
	expect(events.msgErr + events.mismatch).toBeGreaterThan(0); // ← fails: swallowed
	expect(errors.length).toBeGreaterThan(0); // evidence: logged-only
	await p.destroy();
});
