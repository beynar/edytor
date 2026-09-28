/**
 * Type-check-only shim (NOT shipped: outside `src/lib`) for the Workers
 * runtime names `src/lib/cloudflare` uses, so `pnpm check` can check that
 * module inside the DOM-typed app program. The names mirror
 * `@cloudflare/workers-types`, which Worker programs (`tests/do`, a
 * consumer's Worker) resolve instead — keep the subset structural and
 * compatible with it.
 */
declare module 'cloudflare:workers' {
	export abstract class DurableObject<Env = unknown> {
		protected ctx: DurableObjectState;
		protected env: Env;
		constructor(ctx: DurableObjectState, env: Env);
	}
}

type SqlStorageValue = ArrayBuffer | string | number | null;

interface SqlStorageCursor<T extends Record<string, SqlStorageValue>> extends Iterable<T> {
	toArray(): T[];
	one(): T;
}

interface SqlStorage {
	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): SqlStorageCursor<T>;
}

interface DurableObjectState {
	readonly id: { toString(): string };
	readonly storage: { readonly sql: SqlStorage; transactionSync<T>(closure: () => T): T };
	acceptWebSocket(ws: WebSocket, tags?: string[]): void;
	getWebSockets(tag?: string): WebSocket[];
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectNamespace<T = undefined> {
	getByName(name: string): { fetch(request: Request): Promise<Response>; __type?: T };
}

declare class WebSocketPair {
	0: WebSocket;
	1: WebSocket;
}

interface WebSocket {
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
}

interface ResponseInit {
	webSocket?: WebSocket | null;
}
