/** Sunday = 0, matching JavaScript Date#getDay and Intl weekday numbering. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface Geofence extends Coordinates {
  radiusMeters: number;
  /** Paid custom shape. If 3+ points, this is the fence instead of the circle. */
  polygon?: Coordinates[];
}

export interface QuietWindow {
  /** Days this window applies. Overnight windows use the start day's membership. */
  days: DayOfWeek[];
  /** 24h "HH:MM" local to the venue timezone. */
  start: string;
  /** 24h "HH:MM". May be earlier than start for overnight (e.g. 22:00–06:00). */
  end: string;
}

export interface Schedule {
  /** IANA timezone, e.g. America/Chicago. */
  timezone: string;
  windows: QuietWindow[];
  /** Free spaces are always quiet — no weekly windows. */
  alwaysOn?: boolean;
}

export type SilenceReason =
  | "venue_paused"
  | "outside_geofence"
  | "outside_quiet_hours"
  | "in_quiet_zone";

export interface SilenceEvaluation {
  distanceMeters: number;
  insideGeofence: boolean;
  inQuietWindow: boolean;
  shouldSilence: boolean;
  reason: SilenceReason;
}

export interface ShouldSilenceInput {
  geofence: Geofence;
  schedule: Schedule;
  now: Date;
  location: Coordinates;
  venueActive?: boolean;
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
