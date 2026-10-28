/* RainLoop Webmail (c) RainLoop Team | Licensed under MIT */

export const relativeTimeFallback = (relativeTime, seconds, unit) => {
	const absolute = Math.abs(seconds),
		plural = relativeTime.plural ? relativeTime.plural(absolute) : 'other',
		unitData = relativeTime.long ? relativeTime.long[unit] : relativeTime[unit],
		period = unitData[0 > seconds ? 'past' : 'future'],
		text = 'string' === typeof period ? period : (period[plural] || period.other || period.one);
	return text.replace('{0}', absolute);
};
