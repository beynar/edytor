import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

/**
 * Pending-scenario lane (U02): lists the §8 registry rows that require
 * not-yet-built model machinery as `it.todo` entries. Deliberately NOT part of
 * `pnpm test:crdt` — pending entries can never weaken a green gate. Run with
 * `pnpm test:crdt:pending`.
 */
export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/tests/crdt-pending/**/*.test.{js,ts}'],
		testTimeout: 60000
	}
});
