/**
 * The Worker bindings the server examples use, as `wrangler types` writes
 * them into a project, so `pnpm check:docs` checks each example as written.
 */
interface Env {
	DOCS: R2Bucket;
}
