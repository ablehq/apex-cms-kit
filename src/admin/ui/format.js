// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// The two clocks the prototype's chrome shows and nothing else does: "3 days ago"
// in a list's UPDATED column, and "11:04 am" beside the word Saved. Both are
// presentation, both are used by more than one screen, and neither belongs inside
// a component.

/**
 * The prototype's UPDATED column: "Just now" / "Today, 11:04 am" / "Yesterday" /
 * "3 days ago" / "Last week" / an absolute date once it is old enough that a
 * relative one stops meaning anything.
 *
 * @param {string | number | Date | null | undefined} value
 * @param {Date} [now]
 */
export function relativeTime(value, now = new Date()) {
	if (!value) return '—';
	const then = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(then.getTime())) return '—';

	const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
	if (seconds < 90) return 'Just now';
	if (seconds < 3600) {
		const minutes = Math.round(seconds / 60);
		return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	}

	const sameDay = then.toDateString() === now.toDateString();
	if (sameDay) return `Today, ${clockTime(then)}`;

	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (then.toDateString() === yesterday.toDateString()) return 'Yesterday';

	const days = Math.round(seconds / 86400);
	if (days < 7) return `${days} days ago`;
	if (days < 14) return 'Last week';
	if (days < 60) return `${Math.round(days / 7)} weeks ago`;
	return then.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The prototype's "Saved 11:04 am" — lowercase, no seconds.
 *
 * @param {string | number | Date | null | undefined} value
 */
export function clockTime(value) {
	if (!value) return '';
	const at = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(at.getTime())) return '';
	return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

/** A page's public address, as the site serves it. The home page's slug is "/". */
export function publicPath(slug) {
	const value = `${slug ?? ''}`.trim();
	if (!value || value === '/') return '/';
	return `/${value.replace(/^\/+/u, '')}`;
}
