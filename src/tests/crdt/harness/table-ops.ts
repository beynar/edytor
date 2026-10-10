/** The table plugin's ops (`plugins/table/ops.ts`), applied on a document: `tables(doc).insertTableRow('T', 0)`. */
import * as ops from '../../../lib/plugins/table/ops.js';
import type { OpResult } from '../../../lib/crdt/index.js';

type Doc = Parameters<typeof ops.insertTableRow>[0];
type Rest<F> = F extends (doc: Doc, ...args: infer A) => unknown ? A : never;
export type TableOps = { [K in keyof typeof ops]: (...args: Rest<(typeof ops)[K]>) => OpResult };

export const tables = (doc: Doc): TableOps =>
	Object.fromEntries(
		Object.entries(ops).map(([name, op]) => [
			name,
			(...args: unknown[]) => doc.apply((op as (d: Doc, ...a: unknown[]) => never)(doc, ...args))
		])
	) as TableOps;
