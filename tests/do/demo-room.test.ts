/**
 * The site's public demo room (site/room): only the current UTC day's
 * room is open, and the previous day's for the first hour after midnight.
 */
import { describe, expect, it } from 'vitest';
import { isOpenDemoRoom } from '../../site/room/src/rooms';

const at = (iso: string) => Date.parse(iso);

describe('site demo room', () => {
	it("accepts today's room only, and yesterday's until 01:00 UTC", () => {
		const noon = at('2026-09-29T12:00:00Z');
		expect(isOpenDemoRoom('demo-2026-09-29', noon)).toBe(true);
		expect(isOpenDemoRoom('demo-2026-09-28', noon)).toBe(false);
		expect(isOpenDemoRoom('demo-2026-09-30', noon)).toBe(false);
		expect(isOpenDemoRoom('demo-2019-01-01', noon)).toBe(false);
		expect(isOpenDemoRoom('demo-9999-12-31', noon)).toBe(false);
		expect(isOpenDemoRoom('other', noon)).toBe(false);

		const afterMidnight = at('2026-09-30T00:30:00Z');
		expect(isOpenDemoRoom('demo-2026-09-30', afterMidnight)).toBe(true);
		expect(isOpenDemoRoom('demo-2026-09-29', afterMidnight)).toBe(true);
		expect(isOpenDemoRoom('demo-2026-09-28', afterMidnight)).toBe(false);

		const later = at('2026-09-30T01:00:00Z');
		expect(isOpenDemoRoom('demo-2026-09-29', later)).toBe(false);
	});
});
