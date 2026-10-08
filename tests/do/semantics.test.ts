/**
 * UW-10 — the room knows the bundled plugins' block roles
 * (`defaultSemantics`): a server edit refuses what no view could produce —
 * a merge into a divider, a split of a void image, a code line moved out of
 * its island, a paragraph moved directly into a columns layout — so every
 * client can still render what the room stores.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { AttachedDocument, DocumentRoom as Room } from '../../src/lib/cloudflare/index.js';
import type { BlockSpec, EdytorDoc } from '../../src/lib/crdt/index.js';
import type { LockedRoom, PlainObject } from './worker';
import { E, RawClient } from './client';

declare global {
	namespace Cloudflare {
		interface Env {
			ROOM: DurableObjectNamespace<Room>;
			PLAIN: DurableObjectNamespace<PlainObject>;
			LOCKED: DurableObjectNamespace<LockedRoom>;
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
	},
	{ id: 'q', type: 'paragraph', content: [{ kind: 'text', text: 'beside' }] },
	{
		id: 'cols',
		type: 'columns',
		children: [
			{ id: 'k1', type: 'column', children: [{ id: 'l', type: 'paragraph' }] },
			{ id: 'k2', type: 'column', children: [{ id: 'r', type: 'paragraph' }] }
		]
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
		edit((facade) => facade.mergeBlocks('item', 'list')),
		// C5: the layout rows are in `defaultSemantics` — a layout holds only its columns.
		edit((facade) => facade.moveBlock('q', { parent: 'cols', index: 0 }))
	];
};

const REFUSED = ['applied', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused'];

describe('the room adopts defaultSemantics', () => {
	it('DocumentRoom.transact refuses edits no view could produce', async () => {
		const statuses = await runInDurableObject(env.ROOM.getByName('semantics-room'), (r: Room) =>
			attempt(r)
		);
		expect(statuses).toEqual(REFUSED);
	});

	it('attachRoom in any Durable Object does too', async () => {
		const statuses = await runInDurableObject(
			env.PLAIN.getByName('plain-semantics'),
			(o: PlainObject) => attempt(o.document)
		);
		expect(statuses).toEqual(REFUSED);
	});
});

/**
 * WU-12 — the dev-time check: a document advertises its roles' digest in
 * its presence (`semantics`, development builds), and the room logs the
 * kinds it reads otherwise (`{ edytor: 'semantics', user, kinds }`), once
 * per digest a client advertises. Nothing is refused: it is a diagnosis.
 */
describe('the room logs a client whose roles differ (semantics digest)', () => {
	const SLOW = { timeout: 10_000, interval: 25 };
	const semanticsLog = (room: string) =>
		runInDurableObject(env.LOCKED.getByName(room), (r: LockedRoom) =>
			r.logged.filter((entry) => entry.edytor === 'semantics')
		);

	it('names the kinds, once per advertised digest; an agreeing client logs nothing', async () => {
		const room = 'locked-semantics-digest';
		const ada = await RawClient.connect(room, undefined, { user: 'ada', replica: 101 });
		const bob = await RawClient.connect(room, undefined, { user: 'bob', replica: 202 });
		await vi.waitFor(() => expect(ada.synced && bob.synced).toBe(true), SLOW);
		const agreeing = E.semanticsDigest(E.defaultSemantics);
		const embed = E.semanticsDigest(
			E.mergeSemantics(E.defaultSemantics, E.semanticsOf({ widget: { void: true } }))
		);
		bob.setPresence(202, 1, { semantics: agreeing });
		ada.setPresence(101, 1, { semantics: embed });
		ada.setPresence(101, 2, { semantics: embed, selections: {} });
		await vi.waitFor(() => expect(ada.presence.get(101)?.clock).toBe(2), SLOW);
		await vi.waitFor(() => expect(bob.presence.get(101)?.clock).toBe(2), SLOW);
		expect(await semanticsLog(room)).toEqual([
			{ edytor: 'semantics', user: 'ada', kinds: ['widget'] }
		]);
		expect(ada.closed).toBeNull();
		for (const client of [ada, bob]) client.close();
	});
});
