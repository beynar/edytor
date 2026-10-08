/**
 * The engine the soak's clients run: the package's CRDT entry
 * (`createDocument`, `bindCrdt(Y).providers` — the shipped
 * `WebsocketProvider`) and its wire entry, loaded from source through
 * jiti (as `bench/room-memory.mjs`), so the soak exercises the code the
 * room is built from.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const req = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

export const loadEngine = async () => {
	const vitestDir = req.resolve('vitest/package.json', { paths: [root] });
	const { createJiti } = await import(req.resolve('jiti', { paths: [vitestDir] }));
	const jiti = createJiti(import.meta.url);
	const E = await jiti.import(`${root}src/lib/crdt/index.ts`);
	const P = await jiti.import(`${root}src/lib/crdt/protocol.ts`);
	const { Y } = await jiti.import(`${root}src/lib/crdt/engine.js`);
	return { E, P, Y, crdt: E.bindCrdt(Y) };
};
