/**
 * Names the docs leave to the reader (`// your storage`, the editor a page
 * already bound), declared once so `pnpm check:docs` checks the rest of each
 * example as written. A block that declares one of these names itself
 * shadows the global.
 */
import type { Block, EdytorDocument, EdytorInstance, InlineBlock, JSONDoc } from '$lib/index.js';

declare global {
	/** The editor instance a page bound with `bind:edytor` (`edytor.*` snippets). */
	const edytor: EdytorInstance;
	/** A document's facade, `document.facade` or `edytor.facade` (`facade.*` snippets). */
	const facade: EdytorDocument['facade'];
	/** A block handle, as `edytor.idToBlock.get(id)` returns it (`block.*` snippets). */
	const block: Block;
	/** An inline block handle (`atom.*` snippets). */
	const atom: InlineBlock;
	/** A block's id (`blockId` in snippets). */
	const blockId: string;
	/** The signed-in user's id, the document's id and a session token your app holds. */
	const userId: string;
	const documentId: string;
	const token: string;
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
