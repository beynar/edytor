/**
 * Local opaque-relay WebSocket server for the v14 browser proof
 * (docs/crdt-v14-providers.md §server compatibility classification).
 *
 * An OPAQUE relay is the supported websocket topology: it groups connections
 * into rooms (URL path) and forwards binary payloads VERBATIM to the other
 * members — it never decodes the envelope (`varuint GENERATION | type | payload`),
 * never merges state, and never answers sync itself. NOTE: upstream
 * `y-websocket`'s `setupWSConnection` is NOT this — even with no persistence
 * hook it creates a server-side doc, decodes `varuint messageType`, and runs
 * the sync handshake, so our enveloped frames arrive there as unhandled
 * message type `14001` and are dropped (never relayed). THIS file is the
 * reference implementation of the only proven-compatible server class.
 *
 * This is a dependency-free RFC6455 implementation (~150 lines of wire
 * mechanics): HTTP upgrade → Sec-WebSocket-Accept, masked client-frame
 * decode, unmasked server-frame encode, ping/pong, close, and fragmented-
 * message reassembly. It runs inside the Playwright worker process, so specs
 * drive it programmatically (no side channel).
 *
 * Harness hooks are DELIBERATE relay-level faults — `hold`/`release` with
 * `permute`/`duplicates`, `setLatency`, `dropNext`, `killRoom`, `stop`/`start`.
 * They are NOT claims about transport: TCP on a live connection preserves
 * order and does not duplicate; the point of the harness faults is to prove
 * the v14 sync protocol converges under adversarial delivery anyway
 * (idempotent update application + state-vector re-handshake), and to let
 * two clients produce genuinely concurrent ops before release.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODES = { CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 } as const;

type Connection = {
	socket: Socket;
	room: string;
	buffer: Buffer;
	/** Accumulated payloads of a fragmented message (opcode 0 continuation). */
	fragments: Buffer[];
	fragmented: boolean;
	closed: boolean;
};

type HeldFrame = { from: Connection; data: Buffer };

type RoomState = {
	held: boolean;
	queue: HeldFrame[];
	latencyMs: number;
	dropBudget: number;
};

export type ReleaseOptions = {
	/**
	 * Deliver the held batch in a deliberately permuted order. This is a
	 * HARNESS replay/permutation — real TCP keeps order; the point is that
	 * v14 update application is order-insensitive and must still converge.
	 */
	permute?: boolean;
	/** Deliver every held frame this many times (duplicate delivery must be a no-op). */
	duplicates?: number;
};

export type OpaqueRelay = {
	/** `ws://127.0.0.1:<port>` — pass as `wsserver` to the collab route. */
	url: string;
	port: number;
	/** Frames the relay forwarded (per direction), for envelope assertions. */
	forwarded: Uint8Array[];
	socketCount: (room?: string) => number;
	hold: (room: string) => void;
	release: (room: string, options?: ReleaseOptions) => number;
	pendingCount: (room: string) => number;
	setLatency: (room: string, ms: number) => void;
	/** Deliberately drop the next `count` forwarded frames (harness loss). */
	dropNext: (room: string, count: number) => void;
	/** Destroy every socket in a room — a severed-connection partition. */
	killRoom: (room: string) => void;
	/** Kill the relay entirely: sockets destroyed, listener closed. */
	stop: () => Promise<void>;
	/** Re-listen on the same port after `stop()` — the relay "restarts". */
	start: () => Promise<void>;
	close: () => Promise<void>;
};

const encodeFrame = (payload: Buffer | Uint8Array, opcode: number = OPCODES.BINARY): Buffer => {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
};

const acceptKey = (key: string) =>
	createHash('sha1')
		.update(key + WS_GUID)
		.digest('base64');

export const startOpaqueRelay = async (): Promise<OpaqueRelay> => {
	const connections = new Set<Connection>();
	const rooms = new Map<string, RoomState>();
	const forwarded: Uint8Array[] = [];
	let closed = false;

	const roomState = (room: string): RoomState => {
		let state = rooms.get(room);
		if (!state) {
			state = { held: false, queue: [], latencyMs: 0, dropBudget: 0 };
			rooms.set(room, state);
		}
		return state;
	};

	const server: Server = createServer((_req, res) => {
		// The relay speaks websocket only — plain HTTP gets a cheap 200 so
		// `page.request.get(relay.url)` health checks don't hang.
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('edytor opaque ws relay\n');
	});

	const deliver = (from: Connection, data: Buffer) => {
		const state = roomState(from.room);
		if (state.dropBudget > 0) {
			state.dropBudget--;
			return;
		}
		const frame = encodeFrame(data);
		for (const peer of connections) {
			if (peer.room === from.room && peer !== from && !peer.closed && !peer.socket.destroyed) {
				forwarded.push(new Uint8Array(data));
				if (state.latencyMs > 0) {
					const target = peer;
					setTimeout(() => {
						if (!target.closed && !target.socket.destroyed) target.socket.write(frame);
					}, state.latencyMs);
				} else {
					peer.socket.write(frame);
				}
			}
		}
	};

	const routeMessage = (conn: Connection, data: Buffer) => {
		const state = roomState(conn.room);
		if (state.held) {
			state.queue.push({ from: conn, data });
			return;
		}
		deliver(conn, data);
	};

	const handleFrame = (conn: Connection, fin: boolean, opcode: number, payload: Buffer) => {
		if (opcode === OPCODES.CLOSE) {
			// Echo the close handshake then drop the TCP side.
			if (!conn.closed) {
				conn.closed = true;
				try {
					conn.socket.end(encodeFrame(payload, OPCODES.CLOSE));
				} catch {
					conn.socket.destroy();
				}
			}
			connections.delete(conn);
			return;
		}
		if (opcode === OPCODES.PING) {
			conn.socket.write(encodeFrame(payload, OPCODES.PONG));
			return;
		}
		if (opcode === OPCODES.PONG) {
			return;
		}
		// Data frames: reassemble fragmented messages, then route the whole
		// payload as one binary message (the receiver sees identical bytes).
		if (opcode === OPCODES.CONTINUATION) {
			conn.fragments.push(payload);
		} else {
			conn.fragments = [payload];
			conn.fragmented = !fin;
		}
		if (fin) {
			const message =
				conn.fragments.length === 1 ? conn.fragments[0] : Buffer.concat(conn.fragments);
			conn.fragments = [];
			conn.fragmented = false;
			routeMessage(conn, message);
		}
	};

	const readFrames = (conn: Connection, chunk: Buffer) => {
		conn.buffer = conn.buffer.length === 0 ? chunk : Buffer.concat([conn.buffer, chunk]);
		for (;;) {
			const buf = conn.buffer;
			if (buf.length < 2) return;
			const b0 = buf[0];
			const b1 = buf[1];
			const fin = (b0 & 0x80) !== 0;
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			let length = b1 & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (buf.length < 4) return;
				length = buf.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buf.length < 10) return;
				length = Number(buf.readBigUInt64BE(2));
				offset = 10;
			}
			const maskBytes = masked ? 4 : 0;
			if (buf.length < offset + maskBytes + length) return;
			let payload: Buffer = buf.subarray(offset + maskBytes, offset + maskBytes + length);
			if (masked) {
				const mask = buf.subarray(offset, offset + 4);
				const unmasked = Buffer.allocUnsafe(length);
				for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ mask[i & 3];
				payload = unmasked;
			}
			conn.buffer = buf.subarray(offset + maskBytes + length);
			handleFrame(conn, fin, opcode, payload);
		}
	};

	server.on('upgrade', (req, socket: Socket, head) => {
		const key = req.headers['sec-websocket-key'];
		if (!key) {
			socket.destroy();
			return;
		}
		// Provider URL is `serverUrl + '/' + roomname` → path `/roomname`;
		// normalize to the bare room name so `hold('room')` etc. match.
		const room = new URL(req.url ?? '/', 'ws://relay.invalid').pathname.replace(/^\//, '');
		const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',')[0]?.trim();
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
				(offered ? `Sec-WebSocket-Protocol: ${offered}\r\n` : '') +
				'\r\n'
		);
		socket.setNoDelay(true);

		const conn: Connection = {
			socket,
			room,
			buffer: head?.length ? Buffer.from(head) : Buffer.alloc(0),
			fragments: [],
			fragmented: false,
			closed: false
		};
		connections.add(conn);
		socket.on('data', (chunk) => {
			try {
				readFrames(conn, chunk);
			} catch {
				connections.delete(conn);
				socket.destroy();
			}
		});
		socket.on('close', () => {
			conn.closed = true;
			connections.delete(conn);
		});
		socket.on('error', () => {
			conn.closed = true;
			connections.delete(conn);
		});
		if (conn.buffer.length > 0) {
			readFrames(conn, conn.buffer);
		}
	});

	const listen = (port: number) =>
		new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server.once('error', onError);
			server.listen(port, '127.0.0.1', () => {
				server.off('error', onError);
				resolve();
			});
		});

	await listen(0);
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;

	const destroyAllSockets = () => {
		for (const conn of connections) {
			conn.closed = true;
			conn.socket.destroy();
		}
		connections.clear();
	};

	const relay: OpaqueRelay = {
		url: `ws://127.0.0.1:${port}`,
		port,
		forwarded,
		socketCount: (room) =>
			[...connections].filter((c) => room === undefined || c.room === room).length,
		hold: (room) => {
			roomState(room).held = true;
		},
		release: (room, { permute = false, duplicates = 1 } = {}) => {
			const state = roomState(room);
			state.held = false;
			const batch = state.queue.splice(0);
			if (permute) {
				// Deterministic permutation — reverse + rotate halves so both
				// senders' frames interleave non-trivially.
				batch.reverse();
				const half = Math.floor(batch.length / 2);
				batch.unshift(...batch.splice(half));
			}
			let delivered = 0;
			for (const entry of batch) {
				for (let i = 0; i < duplicates; i++) {
					deliver(entry.from, entry.data);
					delivered++;
				}
			}
			return delivered;
		},
		pendingCount: (room) => roomState(room).queue.length,
		setLatency: (room, ms) => {
			roomState(room).latencyMs = ms;
		},
		dropNext: (room, count) => {
			roomState(room).dropBudget += count;
		},
		killRoom: (room) => {
			for (const conn of [...connections]) {
				if (conn.room === room) {
					conn.closed = true;
					conn.socket.destroy();
					connections.delete(conn);
				}
			}
		},
		stop: async () => {
			destroyAllSockets();
			rooms.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
		start: async () => {
			await listen(port);
		},
		close: async () => {
			if (closed) return;
			closed = true;
			destroyAllSockets();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};

	return relay;
};
