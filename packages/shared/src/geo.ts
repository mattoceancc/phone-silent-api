import type { Coordinates, Geofence } from "./types";

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in meters (haversine). */
export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function isInsideGeofence(
  geofence: Geofence,
  location: Coordinates,
): boolean {
  if (geofence.polygon && geofence.polygon.length >= 3) {
    return isInsidePolygon(location, geofence.polygon);
  }
  return distanceMeters(geofence, location) <= geofence.radiusMeters;
}

/** Ray-casting point-in-polygon. The last vertex need not repeat the first. */
export function isInsidePolygon(
  point: Coordinates,
  polygon: Coordinates[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersect =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng <
        ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat + Number.EPSILON) +
          a.lng;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Centroid + farthest-point radius, used after a walk-to-set fence. */
export function coveringCircle(points: Coordinates[]): Geofence {
  if (!points.length) {
    throw new Error("Need at least one GPS point");
  }
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  const center = { lat, lng };
  const radiusMeters = Math.max(
    15,
    ...points.map((point) => distanceMeters(center, point)),
  );
  return { lat, lng, radiusMeters };
}
