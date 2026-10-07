/**
 * The Worker bindings the server examples use, as `wrangler types` writes
 * them into a project, and the names they leave to the reader (`// your
 * storage`), so `pnpm check:docs` checks each example as written.
 */
interface Env {
	DOCS: R2Bucket;
	DOCS_KV: KVNamespace;
	DB: D1Database;
	HISTORY: KVNamespace;
	VERSIONS: R2Bucket;
	ROOMS: DurableObjectNamespace;
	NOTES: DurableObjectNamespace;
}

/** server/authorization: the `authorize` a Worker passes to `routeDocumentSocket`. */
declare const authorize: import('edytor/cloudflare').AuthorizeDocumentSocket;
/** server/extending: read and write a document in your own store. */
declare function loadFromMyStore(
	name: string
): Promise<import('edytor/cloudflare').LoadedDocument | undefined>;
declare function saveToMyStore(
	name: string,
	saved: Pick<import('edytor/cloudflare').SavedDocument, 'update' | 'replicas'>
): Promise<void>;
