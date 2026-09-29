/**
 * The arguments `EdytorDocument`'s public listeners receive: `onReady`
 * listeners are called with none, `onSyncRefused` listeners with the
 * refusal alone — a variadic listener (`console.log`, rest args) sees
 * exactly that.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { attachDocument, SyncRefusedError, type EdytorSync } from '../../../lib/crdt/index.js';

describe('EdytorDocument listener arguments', () => {
	it('calls an onReady listener with no arguments', () => {
		const document = attachDocument(new Y.Doc());
		const calls: unknown[][] = [];
		document.onReady((...args: unknown[]) => void calls.push(args));
		document.sync();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(0);
		document.destroy();
	});

	it('calls an onSyncRefused listener with the refusal only', () => {
		const document = attachDocument(new Y.Doc());
		const calls: unknown[][] = [];
		document.onSyncRefused((...args: unknown[]) => void calls.push(args));
		let fail: ((error: unknown) => void) | undefined;
		const sync: EdytorSync = ({ failed }) => {
			fail = failed;
		};
		document.attachSync(sync);
		const refusal = new SyncRefusedError(4403, 'document access denied');
		fail?.(refusal);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(1);
		expect(calls[0][0]).toBe(refusal);
		document.destroy();
	});
});
