/** The demo room of the UTC day holding `time` (`demo-YYYY-MM-DD`). */
export const demoRoomAt = (time: number): string =>
	`demo-${new Date(time).toISOString().slice(0, 10)}`;

const HOUR = 60 * 60 * 1000;

/**
 * Is `room` open at `now`? Today's room (UTC) is; yesterday's stays open
 * for the first hour after midnight, so a page opened just before it
 * reconnects to the document it was editing.
 */
export const isOpenDemoRoom = (room: string, now = Date.now()): boolean =>
	room === demoRoomAt(now) || room === demoRoomAt(now - HOUR);
