# Phone Silent API

Facility accounts manage their own quiet spaces at `/admin/venues`. Visitor counts are not part of that API.

Site-wide listing and visitor counts are only on `/site-admin`, for emails in `SITE_ADMIN_EMAILS` (default `mattoceancc@gmail.com` when the variable is unset or blank). Send the facility session token as `Authorization: Bearer <token>` or the `ps_session` cookie.

## `GET /site-admin/venues`

Lists every quiet space, across all owners. Optional `q` filters by space name, address, or owner email (case-insensitive). Omit `q` for the full list. `totals` matches the spaces in that response.

Unauthenticated requests return **401** `{ "error": "Sign in required" }` and no space data. A signed-in account that is not a site admin returns **403** and no space data.

```json
{
  "venues": [
    {
      "id": "ven_…",
      "name": "Main sanctuary",
      "address": "123 Main St, Austin, TX",
      "lat": 30.2672,
      "lng": -97.7431,
      "plan": "free",
      "active": true,
      "ownerEmailVerified": true,
      "claimReleased": false,
      "ownerId": "adm_…",
      "ownerName": "Ada Owner",
      "ownerEmail": "ada@example.com",
      "createdAt": "2026-10-06T20:00:00.000Z",
      "updatedAt": "2026-10-06T20:00:00.000Z",
      "visitorCounts": { "joins": 1, "silences": 2 }
    }
  ],
  "totals": { "spaces": 1, "joins": 1, "silences": 2 }
}
```

`active` is whether the space is on. `ownerEmailVerified` is whether that owner has confirmed their email. `visitorCounts.joins` counts legacy check-ins. `visitorCounts.silences` counts anonymous times a phone was silenced inside the space. Both are all-time totals. Reset and reassign responses use this same space object.

## `GET /site-admin/venues/:id/metrics`

Same auth as the list. **404** when the space does not exist.

`metrics.totals` matches `visitorCounts` on the list. `metrics.days` is the recent per-day series (at most 60 day/kind groups, newest first) and can be shorter than the all-time totals. `anonymous: true` means these are aggregate events, not identified people.

```json
{
  "venueId": "ven_…",
  "anonymous": true,
  "metrics": {
    "days": [{ "day": "2026-10-06", "joins": 1, "silences": 2 }],
    "totals": { "joins": 1, "silences": 2 }
  }
}
```

## Owner and public APIs

`GET /admin/venues/:id/metrics` returns **404** `{ "error": "Not found" }` for everyone, including the owning paid account. It does not return counts.

`GET /admin/venues`, `GET /admin/venues/:id`, `GET /venues/public`, join, and evaluate responses do not include `visitorCounts`, `joins`, `silences`, or `metrics`.
