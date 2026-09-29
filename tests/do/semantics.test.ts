/**
 * UW-10 — the room knows the bundled plugins' block roles
 * (`defaultSemantics`): a server edit refuses what no view could produce —
 * a merge into a divider, a split of a void image, a code line moved out of
 * its island — so every client can still render what the room stores.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AttachedDocument, DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { BlockSpec, EdytorDoc } from '../../src/lib/crdt/index.js';
import type { PlainObject } from './worker';

declare global {
	namespace Cloudflare {
		interface Env {
			ROOM: DurableObjectNamespace<Room>;
			PLAIN: DurableObjectNamespace<PlainObject>;
		}
	}
}

const blocks: BlockSpec[] = [
	{ id: 'hr', type: 'divider' },
	{ id: 'p', type: 'paragraph', content: [{ kind: 'text', text: 'after' }] },
	{
		id: 'img',
		type: 'image',
		data: { src: 'https://example.com/a.png' },
		content: [{ kind: 'text', text: 'cap' }]
	},
	{
		id: 'code',
		type: 'code',
		children: [{ id: 'line', type: 'codeLine', content: [{ kind: 'text', text: 'a' }] }]
	},
	{
		id: 'list',
		type: 'unordered-list',
		children: [{ id: 'item', type: 'list-item', content: [{ kind: 'text', text: 'b' }] }]
	}
];

/** Seed the fixture, then attempt the three edits, each in its own server transaction. */
const attempt = (room: Pick<AttachedDocument, 'transact'>) => {
	const edit = (fn: (facade: EdytorDoc) => { status: string }) => room.transact(fn).status;
	const seeded = edit((facade) => facade.insertBlocks({ parent: null, index: 0 }, blocks));
	return [
		seeded,
		edit((facade) => facade.mergeBackward('p')),
		edit((facade) => facade.splitBlock('img', 1, 'img2')),
		edit((facade) => facade.moveBlock('line', { parent: null, index: 0 })),
		// XW-12: a code block renders no content — its first line never merges into it.
		edit((facade) => facade.mergeBackward('line')),
		// DR-crdt-2: nor does a list — its first item never merges into it
		// (Backspace there lifts the item out instead, YW-02).
		edit((facade) => facade.mergeBlocks('item', 'list'))
	];
};

const REFUSED = ['applied', 'refused', 'refused', 'refused', 'refused', 'refused'];

describe('the room adopts defaultSemantics', () => {
	it('DocumentRoom.transact refuses edits no view could produce', async () => {
		const statuses = await runInDurableObject(env.ROOM.getByName('semantics-room'), (r: Room) =>
			attempt(r)
		);
		expect(statuses).toEqual(REFUSED);
	});

	it('attachDocument in any Durable Object does too', async () => {
		const statuses = await runInDurableObject(
			env.PLAIN.getByName('plain-semantics'),
			(o: PlainObject) => attempt(o.document)
		);
		expect(statuses).toEqual(REFUSED);
	});
});
