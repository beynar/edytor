/**
 * Test lanes check the document index after every fold (`indexChecks` in
 * `src/lib/crdt/text/runs.ts`): each fact it maintains incrementally must
 * equal its rebuild from the replicated state. A flag, not an import, so a
 * test file's module mocks still apply to the index's dependencies.
 */
(globalThis as { __EDYTOR_INDEX_CHECKS__?: boolean }).__EDYTOR_INDEX_CHECKS__ =
	process.env.EDYTOR_INDEX_CHECKS !== '0';
