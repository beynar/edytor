/**
 * The room lane's waits (CC-05): `vi.waitFor` bounds how long a row waits for
 * the room, never how fast the machine is. Its default (1 s) is shorter than
 * a room round trip on a loaded runner, so the lane's default is 10 s, polled
 * every 25 ms; a row passing its own `timeout` keeps it. A wait that holds
 * returns as soon as it holds, so a green run takes no longer.
 */
import { vi } from 'vitest';

const waitFor = vi.waitFor.bind(vi);
const LANE = { timeout: 10_000, interval: 25 };

vi.waitFor = ((callback, options) =>
	waitFor(
		callback,
		typeof options === 'number' ? { ...LANE, timeout: options } : { ...LANE, ...options }
	)) as typeof vi.waitFor;
