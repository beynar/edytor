import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// `pnpm test:do` — the shipped room Durable Object (`edytor/cloudflare`,
// src/lib/cloudflare) inside the Workers runtime (workerd via Miniflare),
// SQLite storage, hibernatable sockets. Row size, frame limit and compaction
// threshold are lowered so ordinary documents exercise multi-row records,
// chunked catch-up and automatic compaction.
export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './tests/do/worker.ts',
			miniflare: {
				compatibilityDate: '2026-09-26',
				bindings: {
					EDYTOR_MAX_ROW_BYTES: '4096',
					EDYTOR_MAX_FRAME_BYTES: '16384',
					EDYTOR_COMPACT_AFTER: '40',
					EDYTOR_LOG: 'off'
				},
				durableObjects: {
					ROOM: { className: 'DocumentRoom', useSQLite: true },
					HOOKED: { className: 'HookedRoom', useSQLite: true },
					PLAIN: { className: 'PlainObject', useSQLite: true },
					HOST: { className: 'HostObject', useSQLite: true },
					FIELDS: { className: 'FieldRoom', useSQLite: true },
					QUOTA: { className: 'QuotaRoom', useSQLite: true },
					LOCKED: { className: 'LockedRoom', useSQLite: true },
					TIMED: { className: 'TimedRoom', useSQLite: true },
					// The site's demo room class (site/room), its history in a real (Miniflare) KV.
					DEMO: { className: 'DemoRoom', useSQLite: true }
				},
				kvNamespaces: ['HISTORY']
			}
		})
	],
	resolve: {
		// The site's demo room (site/room) imports the package: read it from source.
		alias: {
			'edytor/cloudflare': decodeURIComponent(
				new URL('../../src/lib/cloudflare/index.ts', import.meta.url).pathname
			)
		}
	},
	test: {
		include: ['tests/do/**/*.test.ts'],
		testTimeout: 20_000
	}
});
