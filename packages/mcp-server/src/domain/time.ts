const DAY_MS = 86_400_000;

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

/** yyyy-mm-dd in the given time zone. */
export function isoDate(d: Date, timeZone = "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Whole calendar days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string | Date, to: string | Date): number {
  const a = Date.parse(typeof from === "string" ? from.slice(0, 10) : isoDate(from));
  const b = Date.parse(typeof to === "string" ? to.slice(0, 10) : isoDate(to));
  return Math.round((b - a) / DAY_MS);
}

export function hourIn(d: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(d));
}

/** "Tuesday, October 13" */
export function spokenDate(d: Date | string, timeZone = "America/Chicago"): string {
  const date = typeof d === "string" ? new Date(d.length === 10 ? `${d}T12:00:00Z` : d) : d;
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(date);
}

/** "Tue Oct 13" */
export function shortDate(d: Date | string, timeZone = "America/Chicago"): string {
  const date = typeof d === "string" ? new Date(d.length === 10 ? `${d}T12:00:00Z` : d) : d;
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
}

/** "today" / "tomorrow" / "Tuesday" (within a week) / "Tuesday, October 20". */
export function relativeDay(target: Date | string, now: Date, timeZone = "America/Chicago"): string {
  const t = typeof target === "string" ? new Date(target.length === 10 ? `${target}T12:00:00Z` : target) : target;
  const diff = daysBetween(isoDate(now, timeZone), isoDate(t, timeZone));
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(t);
  return spokenDate(t, timeZone);
}

export function spokenTime(d: Date | string, timeZone = "America/Chicago"): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(date)
    .replace(":00", "");
}

/** A Date for local wall-clock `hour` on the calendar day `dayOffset` days from `now`, in `timeZone`. */
export function localDateAt(now: Date, dayOffset: number, hour: number, timeZone: string): Date {
  const day = isoDate(addDays(now, dayOffset), timeZone);
  // Find the UTC offset for that day by formatting noon UTC in the zone.
  const probe = new Date(`${day}T12:00:00Z`);
  const localHour = hourIn(probe, timeZone);
  const offsetHours = localHour - 12;
  return new Date(Date.parse(`${day}T00:00:00Z`) + (hour - offsetHours) * 3_600_000);
}
