/**
 * UW-31 (review 2026-09-29): the derived own-text writer spans the engine's
 * 53-bit clientID space, and a derivation landing on a writer that already
 * wrote in the document — a hash collision, R13's residual class — is
 * reported in DEV. The collision is forced by stubbing the hash.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { afterEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({ writer: 0 }));
vi.mock('../../../lib/crdt/rand.js', async (load) => {
	const real = await load<typeof import('../../../lib/crdt/rand.js')>();
	return { ...real, hash53: (text: string) => stub.writer || real.hash53(text) };
});

import { hash53 } from '../../../lib/crdt/rand.js';
import { Y } from '../../../lib/crdt/engine.js';
import { replica, seedUpdate } from './replica-harness.js';

afterEach(() => {
	stub.writer = 0;
	vi.restoreAllMocks();
});

describe('UW-31: a derived own-text writer is a 53-bit id', () => {
	it('hash53 spans [0, 2^53): integer, above the 32-bit range for most inputs', () => {
		const values = Array.from({ length: 256 }, (_, i) => hash53(`own|b${i}`));
		for (const v of values) {
			expect(Number.isSafeInteger(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
		}
		expect(values.filter((v) => v >= 2 ** 32).length).toBeGreaterThan(250);
		expect(Math.max(...values)).toBeGreaterThan(2 ** 52);
	});

	/**
	 * Blocks with no stream: B splits A's fresh blocks and types into each
	 * tail, then A's raw history undoes their creation — each tail outlives
	 * the text it claimed from (`stream-split-ownership`' dead boundary).
	 */
	const streamless = (tails: string[]) => {
		const seed = seedUpdate([{ id: 'x', text: 'x' }]);
		const a = replica('A', seed, 20);
		const b = replica('B', seed, 30);
		// A raw registry history (no P12 withdraw): the undo deletes the blocks outright.
		const um = new Y.UndoManager(a.doc.get('blocks'), { captureTimeout: 0 });
		tails.forEach((tail, i) =>
			a.ed.insertBlock(
				{ parent: null, index: 1 + i },
				{ id: `P${i}`, type: 'paragraph', content: [{ kind: 'text', text: 'Hello world' }] }
			)
		);
		b.receiveAll(a.log);
		tails.forEach((tail, i) => {
			b.ed.splitBlock(`P${i}`, 5, tail);
			b.ed.insertText(tail, 0, 'Q');
		});
		a.receiveAll(b.log);
		for (const _ of tails) expect(um.undo()).not.toBe(null);
		for (const tail of tails) expect(a.ed.blockText(tail)).toBe('');
		return a;
	};

	it('the first typing into a streamless block writes under a derived writer above 2^32', () => {
		const a = streamless(['u']);
		expect(a.ed.insertText('u', 0, 'a').status).toBe('applied');
		const writer = a.ed.resolveBlock('u').getAttr('content')._item.id.client;
		expect([20, 30]).not.toContain(writer);
		expect(writer).toBeGreaterThan(2 ** 32);
		a.destroy();
	});

	it('DEV reports a derivation landing on a writer another block already used', () => {
		const a = streamless(['u', 'v']);
		stub.writer = 4242;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		a.ed.insertText('u', 0, 'a');
		expect(warn).not.toHaveBeenCalled();
		a.ed.insertText('v', 0, 'b');
		expect(warn).toHaveBeenCalledWith('[edytor] own-text writer 4242 of block v collides');
		a.destroy();
	});
});
