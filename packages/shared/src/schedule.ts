import type { DayOfWeek, QuietWindow, Schedule } from "./types";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHm(value: string): number {
  const match = TIME_RE.exec(value);
  if (!match) {
    throw new Error(`Invalid HH:MM time: ${value}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: DayOfWeek;
  minutesOfDay: number;
}

/** Calendar parts of `date` in an IANA timezone. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const weekdayMap: Record<string, DayOfWeek> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayMap[parts.weekday];
  if (weekday === undefined) {
    throw new Error(`Could not resolve weekday in ${timeZone}`);
  }
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute,
    weekday,
    minutesOfDay: hour * 60 + minute,
  };
}

function yesterday(day: DayOfWeek): DayOfWeek {
  return ((day + 6) % 7) as DayOfWeek;
}

export function isWindowActive(
  window: QuietWindow,
  parts: ZonedParts,
): boolean {
  const start = parseHm(window.start);
  const end = parseHm(window.end);
  const { minutesOfDay, weekday } = parts;

  if (start === end) {
    return window.days.includes(weekday);
  }

  if (start < end) {
    return (
      window.days.includes(weekday) &&
      minutesOfDay >= start &&
      minutesOfDay < end
    );
  }

  // Overnight: 22:00–06:00 belongs to the start day.
  if (minutesOfDay >= start) {
    return window.days.includes(weekday);
  }
  if (minutesOfDay < end) {
    return window.days.includes(yesterday(weekday));
  }
  return false;
}

export function isInQuietWindow(schedule: Schedule, now: Date): boolean {
  if (schedule.alwaysOn) return true;
  if (!schedule.windows.length) return false;
  const parts = zonedParts(now, schedule.timezone);
  return schedule.windows.some((window) => isWindowActive(window, parts));
}
