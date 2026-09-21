import { describe, expect, it } from "vitest";
import { coveringCircle, distanceMeters } from "./geo";
import { evaluateSilence, shouldSilence } from "./silence";
import type { Geofence, Schedule } from "./types";

const GRACE: Geofence = {
  lat: 30.2776,
  lng: -97.7437,
  radiusMeters: 120,
};

const SUNDAY_MORNING: Schedule = {
  timezone: "America/Chicago",
  windows: [{ days: [0], start: "09:00", end: "12:00" }],
};

const WEDNESDAY_EVENING: Schedule = {
  timezone: "America/Chicago",
  windows: [{ days: [3], start: "18:30", end: "20:00" }],
};

const OVERNIGHT: Schedule = {
  timezone: "America/Chicago",
  windows: [{ days: [5], start: "22:00", end: "06:00" }],
};

/** Instant that is `wall` in America/Chicago. */
function chicago(isoLocal: string): Date {
  // isoLocal like 2026-09-20T10:00:00 — interpret as Chicago wall time.
  const naive = new Date(`${isoLocal}-05:00`);
  // Chicago is CDT (UTC-5) on 2026-09-20, CST (UTC-6) in January.
  return naive;
}

function janChicago(isoLocal: string): Date {
  return new Date(`${isoLocal}-06:00`);
}

const inside = { lat: GRACE.lat, lng: GRACE.lng };
const outside = { lat: GRACE.lat + 0.02, lng: GRACE.lng };

describe("distanceMeters", () => {
  it("is ~0 at the same point", () => {
    expect(distanceMeters(inside, inside)).toBeLessThan(0.5);
  });

  it("grows with separation", () => {
    const nearby = { lat: GRACE.lat + 0.001, lng: GRACE.lng };
    const far = { lat: GRACE.lat + 0.01, lng: GRACE.lng };
    expect(distanceMeters(GRACE, far)).toBeGreaterThan(
      distanceMeters(GRACE, nearby),
    );
  });
});

describe("shouldSilence", () => {
  it("silences inside the geofence during a quiet window", () => {
    const now = chicago("2026-09-20T10:00:00"); // Sunday
    expect(now.getUTCDay()).toBe(0);
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: SUNDAY_MORNING,
        now,
        location: inside,
      }),
    ).toBe(true);
  });

  it("does not silence inside the geofence outside the window", () => {
    const now = chicago("2026-09-20T14:00:00");
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: SUNDAY_MORNING,
        now,
        location: inside,
      }),
    ).toBe(false);
  });

  it("does not silence outside the geofence during a quiet window", () => {
    const now = chicago("2026-09-20T10:00:00");
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: SUNDAY_MORNING,
        now,
        location: outside,
      }),
    ).toBe(false);
  });

  it("does not silence when the venue is paused", () => {
    const now = chicago("2026-09-20T10:00:00");
    const result = evaluateSilence({
      geofence: GRACE,
      schedule: SUNDAY_MORNING,
      now,
      location: inside,
      venueActive: false,
    });
    expect(result.shouldSilence).toBe(false);
    expect(result.reason).toBe("venue_paused");
  });

  it("treats the radius as inclusive", () => {
    const now = chicago("2026-09-20T10:00:00");
    // ~111m north per 0.001 deg latitude → 0.00108 deg ≈ 120m
    const onEdge = { lat: GRACE.lat + 120 / 111_320, lng: GRACE.lng };
    const result = evaluateSilence({
      geofence: GRACE,
      schedule: SUNDAY_MORNING,
      now,
      location: onEdge,
    });
    expect(result.distanceMeters).toBeLessThanOrEqual(GRACE.radiusMeters + 2);
    expect(result.insideGeofence).toBe(true);
    expect(result.shouldSilence).toBe(true);
  });

  it("excludes a point just beyond the radius", () => {
    const now = chicago("2026-09-20T10:00:00");
    const justOutside = { lat: GRACE.lat + 140 / 111_320, lng: GRACE.lng };
    const result = evaluateSilence({
      geofence: GRACE,
      schedule: SUNDAY_MORNING,
      now,
      location: justOutside,
    });
    expect(result.insideGeofence).toBe(false);
    expect(result.reason).toBe("outside_geofence");
    expect(result.shouldSilence).toBe(false);
  });

  it("matches a midweek evening window", () => {
    const now = chicago("2026-09-23T19:00:00"); // Wednesday
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: WEDNESDAY_EVENING,
        now,
        location: inside,
      }),
    ).toBe(true);
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: WEDNESDAY_EVENING,
        now: chicago("2026-09-23T18:00:00"),
        location: inside,
      }),
    ).toBe(false);
  });

  it("handles overnight windows belonging to the start day", () => {
    // Friday 22:00 – Saturday 06:00, listed as Friday.
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: OVERNIGHT,
        now: chicago("2026-09-25T23:00:00"), // Friday
        location: inside,
      }),
    ).toBe(true);
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: OVERNIGHT,
        now: chicago("2026-09-26T01:00:00"), // Saturday morning
        location: inside,
      }),
    ).toBe(true);
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: OVERNIGHT,
        now: chicago("2026-09-26T07:00:00"),
        location: inside,
      }),
    ).toBe(false);
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: OVERNIGHT,
        now: chicago("2026-09-25T21:00:00"),
        location: inside,
      }),
    ).toBe(false);
  });

  it("uses the venue timezone, not the host timezone", () => {
    const winterSunday10amChicago = janChicago("2026-01-11T10:00:00");
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: SUNDAY_MORNING,
        now: winterSunday10amChicago,
        location: inside,
      }),
    ).toBe(true);

    // Same instant is 16:00 UTC — still Sunday 10:00 Chicago.
    const asUtc = new Date("2026-01-11T16:00:00Z");
    expect(asUtc.toISOString()).toBe(winterSunday10amChicago.toISOString());
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: SUNDAY_MORNING,
        now: asUtc,
        location: inside,
      }),
    ).toBe(true);
  });

  it("does not silence when no windows are configured", () => {
    const now = chicago("2026-09-20T10:00:00");
    const result = evaluateSilence({
      geofence: GRACE,
      schedule: { timezone: "America/Chicago", windows: [] },
      now,
      location: inside,
    });
    expect(result.shouldSilence).toBe(false);
    expect(result.reason).toBe("outside_quiet_hours");
  });

  it("matches any of multiple windows", () => {
    const schedule: Schedule = {
      timezone: "America/Chicago",
      windows: [
        { days: [0], start: "09:00", end: "12:00" },
        { days: [3], start: "18:30", end: "20:00" },
      ],
    };
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule,
        now: chicago("2026-09-23T19:15:00"),
        location: inside,
      }),
    ).toBe(true);
  });

  it("reports a structured reason for enter vs exit", () => {
    const enter = evaluateSilence({
      geofence: GRACE,
      schedule: SUNDAY_MORNING,
      now: chicago("2026-09-20T10:00:00"),
      location: inside,
    });
    expect(enter).toMatchObject({
      shouldSilence: true,
      insideGeofence: true,
      inQuietWindow: true,
      reason: "in_quiet_zone",
    });

    const exit = evaluateSilence({
      geofence: GRACE,
      schedule: SUNDAY_MORNING,
      now: chicago("2026-09-20T10:00:00"),
      location: outside,
    });
    expect(exit.reason).toBe("outside_geofence");
    expect(exit.shouldSilence).toBe(false);
  });

  it("treats always-on (free) spaces as in-window at any hour", () => {
    const now = chicago("2026-09-22T15:00:00"); // Tuesday afternoon
    expect(
      shouldSilence({
        geofence: GRACE,
        schedule: { timezone: "America/Chicago", windows: [], alwaysOn: true },
        now,
        location: inside,
      }),
    ).toBe(true);
  });

  it("builds a covering circle after a walk", () => {
    const points = [
      { lat: 30.277, lng: -97.744 },
      { lat: 30.278, lng: -97.744 },
      { lat: 30.278, lng: -97.743 },
      { lat: 30.277, lng: -97.743 },
    ];
    const circle = coveringCircle(points);
    expect(circle.lat).toBeGreaterThan(30.277);
    expect(circle.lat).toBeLessThan(30.278);
    expect(circle.radiusMeters).toBeGreaterThan(40);
    for (const point of points) {
      expect(distanceMeters(circle, point)).toBeLessThanOrEqual(circle.radiusMeters + 0.01);
    }
  });

  it("uses a polygon fence when provided", () => {
    const now = chicago("2026-09-20T10:00:00");
    const square: Geofence = {
      lat: 30.2776,
      lng: -97.7437,
      radiusMeters: 5000,
      polygon: [
        { lat: 30.278, lng: -97.7442 },
        { lat: 30.278, lng: -97.7432 },
        { lat: 30.2772, lng: -97.7432 },
        { lat: 30.2772, lng: -97.7442 },
      ],
    };
    expect(
      shouldSilence({
        geofence: square,
        schedule: SUNDAY_MORNING,
        now,
        location: inside,
      }),
    ).toBe(true);
    expect(
      shouldSilence({
        geofence: square,
        schedule: SUNDAY_MORNING,
        now,
        location: { lat: 30.28, lng: -97.7437 },
      }),
    ).toBe(false);
  });
});
