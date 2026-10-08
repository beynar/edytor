/**
 * The websocket sync takes the names `<Edytor>` uses, `{ server, room }`.
 * `{ serverUrl, roomName }`, their deprecated aliases, are gone: given
 * them, the factory throws a `TypeError` naming the new ones.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';

const { createWebsocketSync, prefetch } = bindProviders(Y);

describe('createWebsocketSync options', () => {
	it('{ server, room } names the room on the server and the local store', () => {
		const sync = createWebsocketSync({ server: 'wss://sync.example/rooms/', room: 'notes' });
		expect(sync.target).toBe('websocket:wss://sync.example/rooms/notes');
		expect(sync.persistName).toBe('edytor:wss://sync.example/rooms/notes');
	});

	it('the retired { serverUrl, roomName } are refused by name', () => {
		const retired = { serverUrl: 'wss://sync.example/rooms', roomName: 'notes' } as never;
		expect(() => createWebsocketSync(retired)).toThrow(TypeError);
		expect(() => createWebsocketSync(retired)).toThrow(/`server` and `room`/);
		expect(() => prefetch(retired)).toThrow(/`server` and `room`/);
	});
});
