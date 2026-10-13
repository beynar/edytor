/**
 * A `date` property: stored as ISO `YYYY-MM-DD`, shown in the editor's
 * locale ("Oct 13, 2026"). The locale and the time zone (UTC, the day as
 * stored) are given, never the runtime's own, so the server and the browser
 * write the same text and the page hydrates without a mismatch.
 */

/** Whether `text` is an ISO calendar date (`2026-10-13`) that exists. */
export const isoDate = (text: string): boolean => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (!match) return false;
	const [, year, month, day] = match.map(Number);
	const date = new Date(Date.UTC(year!, month! - 1, day!));
	return date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
};

const formats = new Map<string, Intl.DateTimeFormat>();

/** `iso` in `locale`, medium style (`Oct 13, 2026`); the text itself when it is no ISO date. */
export const formatDate = (iso: string, locale: string): string => {
	if (!isoDate(iso)) return iso;
	let format = formats.get(locale);
	if (!format) {
		format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
		formats.set(locale, format);
	}
	const [year, month, day] = iso.split('-').map(Number);
	return format.format(Date.UTC(year!, month! - 1, day!));
};
