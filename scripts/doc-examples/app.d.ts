/**
 * The functions the docs leave to the reader (`// your backend`, `// your
 * storage`), declared once so `pnpm check:docs` checks the rest of each
 * example as written. Values a component reads (the editor, a block, a
 * token) are not here: a component or module declares, imports or binds
 * them; fragments get them from `fragments.d.ts`.
 */
import type { JSONDoc } from '$lib/index.js';

declare global {
	/** Fetch a fresh session token from your backend. */
	function getToken(): Promise<string>;
	/** Upload a file to your storage and resolve with its URL. */
	function upload(file: File): Promise<string>;
	/** getting-started/sveltekit: load a note's JSON from your storage. */
	function loadNote(id: string): Promise<JSONDoc>;
	/** getting-started/sveltekit: read a document's stored update. */
	function readStoredUpdate(id: string): Promise<Uint8Array>;
}

export {};
