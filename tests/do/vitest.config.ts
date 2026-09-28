import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// `pnpm test:do` — the room Durable Object fixture (tests/do/room.ts) inside
// the Workers runtime (workerd via Miniflare), SQLite storage, hibernatable
// sockets. Row size is lowered so ordinary updates exercise multi-row records.
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './tests/do/worker.ts',
			miniflare: {
				compatibilityDate: '2026-09-26',
				bindings: { EDYTOR_MAX_ROW_BYTES: '4096' },
				durableObjects: { ROOM: { className: 'Room', useSQLite: true } }
			}
		})
	],
	test: {
		include: ['tests/do/**/*.test.ts'],
		testTimeout: 20_000
	}
});
