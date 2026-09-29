/**
 * UW-42 (adversarial review 2026-09-29) — the websocket sync takes the names
 * `<Edytor>` uses, `{ server, room }`; `{ serverUrl, roomName }` stay as
 * deprecated aliases naming the same target and local store.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindProviders } from '../../../lib/crdt/providers/index.js';

const { createWebsocketSync } = bindProviders(Y);

describe('createWebsocketSync options', () => {
	it('{ server, room } names the room on the server and the local store', () => {
		const sync = createWebsocketSync({ server: 'wss://sync.example/rooms/', room: 'notes' });
		expect(sync.target).toBe('websocket:wss://sync.example/rooms/notes');
		expect(sync.persistName).toBe('edytor:wss://sync.example/rooms/notes');
	});

	it('the deprecated { serverUrl, roomName } name the same target', () => {
		const sync = createWebsocketSync({ serverUrl: 'wss://sync.example/rooms', roomName: 'notes' });
		expect(sync.target).toBe('websocket:wss://sync.example/rooms/notes');
		expect(sync.persistName).toBe('edytor:wss://sync.example/rooms/notes');
	});
});
