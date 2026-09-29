/**
 * Names the docs leave to the reader (`// your storage`), declared once so
 * `pnpm check:docs` checks the rest of each example as written.
 */
import type { JSONDoc } from '$lib/index.js';

declare global {
	/** getting-started/sveltekit: load a note's JSON from your storage. */
	function loadNote(id: string): Promise<JSONDoc>;
	/** getting-started/sveltekit: read a document's stored update. */
	function readStoredUpdate(id: string): Promise<Uint8Array>;
}

export {};
