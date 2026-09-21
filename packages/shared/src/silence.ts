import { distanceMeters, isInsideGeofence } from "./geo";
import { isInQuietWindow } from "./schedule";
import type { ShouldSilenceInput, SilenceEvaluation } from "./types";

/**
 * Pure enter/exit evaluation: inside the geofence AND inside a quiet window,
 * on an active space, means the phone should be silent.
 */
export function shouldSilence(input: ShouldSilenceInput): boolean {
  return evaluateSilence(input).shouldSilence;
}

export function evaluateSilence(input: ShouldSilenceInput): SilenceEvaluation {
  const { geofence, schedule, now, location } = input;
  const venueActive = input.venueActive !== false;
  const distance = distanceMeters(geofence, location);
  const insideGeofence = isInsideGeofence(geofence, location);
  const inQuietWindow = isInQuietWindow(schedule, now);

  if (!venueActive) {
    return {
      distanceMeters: distance,
      insideGeofence,
      inQuietWindow,
      shouldSilence: false,
      reason: "venue_paused",
    };
  }
  if (!insideGeofence) {
    return {
      distanceMeters: distance,
      insideGeofence,
      inQuietWindow,
      shouldSilence: false,
      reason: "outside_geofence",
    };
  }
  if (!inQuietWindow) {
    return {
      distanceMeters: distance,
      insideGeofence,
      inQuietWindow,
      shouldSilence: false,
      reason: "outside_quiet_hours",
    };
  }
  return {
    distanceMeters: distance,
    insideGeofence,
    inQuietWindow,
    shouldSilence: true,
    reason: "in_quiet_zone",
  };
}

export function reasonCopy(reason: SilenceEvaluation["reason"]): string {
  switch (reason) {
    case "venue_paused":
      return "This space has paused quiet hours.";
    case "outside_geofence":
      return "You are outside the quiet zone.";
    case "outside_quiet_hours":
      return "You are in the zone, but it is outside quiet hours.";
    case "in_quiet_zone":
      return "Inside the quiet zone.";
  }
}
