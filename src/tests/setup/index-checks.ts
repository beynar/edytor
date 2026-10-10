/**
 * Test lanes check the document index after every fold (`indexChecks` in
 * `src/lib/crdt/text/index/shared.ts`): each fact it maintains incrementally
 * must equal its rebuild from the replicated state (the checker:
 * `src/tests/oracles/index-checks.ts`). Installed before each file's tests,
 * once the file has loaded, so its module mocks apply to what the checker
 * imports too. `EDYTOR_INDEX_CHECKS=0` leaves them off.
 */
import { beforeAll } from 'vitest';

beforeAll(async () => {
	if (process.env.EDYTOR_INDEX_CHECKS === '0') return;
	const [{ indexChecks }, { indexSelfChecks }] = await Promise.all([
		import('../../lib/crdt/text/index/shared.js'),
		import('../oracles/index-checks.js')
	]);
	indexChecks.of = indexSelfChecks;
	indexChecks.on = true;
});
