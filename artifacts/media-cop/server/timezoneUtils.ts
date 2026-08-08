/**
 * Determines if a given date falls within US Eastern Daylight Time (EDT).
 * US Eastern DST: 2nd Sunday of March at 2:00 AM to 1st Sunday of November at 2:00 AM.
 */
export function isEasternDST(date: Date): boolean {
  if (isNaN(date.getTime())) return false;

  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed

  // Months entirely in EST (Dec, Jan, Feb) or entirely in EDT (Apr-Oct)
  if (month < 2 || month > 10) return false; // Dec, Jan, Feb → EST
  if (month > 2 && month < 10) return true;  // Apr through Oct → EDT

  // March: DST starts on 2nd Sunday at 2:00 AM
  if (month === 2) {
    const marchFirst = new Date(year, 2, 1);
    const firstSundayOffset = (7 - marchFirst.getDay()) % 7;
    const secondSunday = 1 + firstSundayOffset + 7;
    const dstStart = new Date(year, 2, secondSunday, 2, 0, 0);
    return date >= dstStart;
  }

  // November: DST ends on 1st Sunday at 2:00 AM
  if (month === 10) {
    const novFirst = new Date(year, 10, 1);
    const firstSundayOffset = (7 - novFirst.getDay()) % 7;
    const firstSunday = 1 + firstSundayOffset;
    const dstEnd = new Date(year, 10, firstSunday, 2, 0, 0);
    return date < dstEnd;
  }

  return false;
}

/**
 * Parses a timestamp string as Eastern Time and returns a proper UTC Date.
 * Automatically determines EST vs EDT based on the date.
 */
export function parseAsEasternTime(timestampStr: string): Date | null {
  // First parse naively to determine the date for DST check
  const naiveDate = new Date(timestampStr);
  if (isNaN(naiveDate.getTime())) return null;

  const tzAbbr = isEasternDST(naiveDate) ? 'EDT' : 'EST';
  const withTz = `${timestampStr} ${tzAbbr}`;
  const parsed = new Date(withTz);

  if (!isNaN(parsed.getTime())) return parsed;

  // Fallback: try the other timezone
  const fallbackTz = tzAbbr === 'EDT' ? 'EST' : 'EDT';
  const fallback = new Date(`${timestampStr} ${fallbackTz}`);
  return isNaN(fallback.getTime()) ? null : fallback;
}
