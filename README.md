# event-recorder

**Event Recorder Worker** — cron-only, no HTTP endpoints

The recording system behind Event History. Every minute it captures every data
feed into a rolling 49-hour buffer, and while an event is declared it seals
those minutes into permanent, replayable snapshots — **including the 12 hours
before the event was declared**.

> **Architecture, how this fits with the other components, and the shared
> conventions live in the [Architecture section of the internal-outage-dashboard README](https://github.com/dfrench-tronet/internal-outage-dashboard/blob/main/westpower-outage-map/README.md#architecture).**
> Read that first if you are new to the system. This file covers running and
> deploying *this* worker only.

---

## Why the buffer exists

Nothing knows an event is coming. By the time somebody declares one, the
interesting hours — the front arriving, the first faults, the load shifting —
are already in the past and nowhere retrievable.

So **the recent past is always held, briefly, for every feed**. That is the
whole design. `evbuf:<minuteTs>` bundles roll with a 49-hour TTL and cost
nothing but write volume; when an event is declared, the lead-in is already
there to be sealed.

## What it does each minute

| Step | Action |
|---|---|
| **1. Capture** | Fetch every feed through the dashboard's own `/api/*` proxies, write one bundle key `evbuf:<minuteTs>`, TTL 49 h, and fold crew positions into the hour's `evtrack:<hourTs>` track document, TTL 50 h. |
| **1b. Health** | Write `evrec:health` with per-feed outcomes, TTL 49 h. |
| **2. Seal** | While an episode is active, copy unsealed buffered minutes to `event:<id>:snap:<ts>`, **TTL 2 years**, and update the index. |
| **3. Radar** | While sealing, copy the latest radar PNG to R2 at `event/<id>/radar/<ts>.png`. |

**Sealing happens DURING the event, not after.** A crash mid-storm loses at
most a minute. When the episode ends, sealing continues for a 1-hour lead-out
before the meta is finalised.

**Captures go through the dashboard's proxies, not to the upstream feeds.**
That reuses every proxy's params, transforms and caching rather than
re-implementing them, so what gets archived is exactly what the map was
showing.

## Feeds captured

`lightning`, `weatherAlerts`, `earthquakes`, `roadEvents`, `loadings`
(columnar), `transpowerNotices`, `outages`, `evacuationZones`, `wcrcRivers`,
`wcrcRainfall` — plus `eroad` only when `CREW_BUFFER=on`.

## Crew track store

With `CREW_BUFFER=on`, each tick also folds the crew feed into the hour's
`evtrack:<hourTs>` document (TTL 50 h): per vehicle, its identity once and
its samples as `[minute, lon, lat, speedKph, heading, status]`, a parked run
kept as its first and last sample. The dashboard reads a window of these in
one request (`/api/eroad?tracks=1&from=&to=`) for smooth crew playback and
trails. The rule is a mirror of `appendCrewSamples` in the dashboard's
`functions/_utils/crewTracks.ts`, where it is tested.

**Add a path to `FEEDS` and it is archived from the next tick.** Nothing else
needs changing.

Evacuation zones are captured per minute despite being near-static geometry,
because a designation can be escalated from Proposed to Evacuation Order
mid-event — which is precisely the minute worth having a record of.

## Crew privacy

`CREW_BUFFER=on` means **continuous recording of crew vehicle positions** into
the rolling buffer. Those positions are auto-purged within ~49 h and are only
ever sealed — kept, exposed — inside a declared event's window.

This is a deliberate, deploy-time relaxation of the live privacy gate that
[`eroad-proxy`](https://github.com/dfrench-tronet/eroad-proxy) enforces
(positions exist only while somebody is looking). Switch it off and events
simply have no crew data from before their declaration.

**Treat flipping this as a policy decision, not a config tweak**, in either
direction.

## Configuration

```bash
wrangler secret put CAPTURE_TOKEN
```

| Name | Kind | Notes |
|---|---|---|
| `OUTAGE_DATA` | KV | **The dashboard's own namespace**, shared. See below. |
| `EVENT_RADAR` | R2 | Bucket `westpower-event-radar`. Optional — without it, events have no imagery. |
| `PAGES_BASE_URL` | var | Dashboard origin. Trailing slash is stripped defensively. |
| `CREW_BUFFER` | var | `"on"` enables the crew lead-in buffer. |
| `CAPTURE_TOKEN` | secret | Must equal the Pages project's `EVENT_CAPTURE_TOKEN`. |

### Local development

`wrangler dev` on this worker **writes buffer keys into production event
history**. Create a preview namespace before running it:

```bash
wrangler kv namespace create OUTAGE_DATA --preview
```

## Reading the KV metrics

`OUTAGE_DATA` is shared with the dashboard, so **its metrics are not this
worker's metrics**. Observed: ~320,000 reads/day and ~3,600 writes/day.

The recorder's own share of the writes is predictable:

```
1440 ticks/day × 3 writes (evbuf + health + evtrack, the last only with CREW_BUFFER=on and a non-empty crew feed) = up to 4,320/day
```

against ~3,600 observed — the remainder being sealing writes and the
dashboard's own. **The reads are almost entirely the dashboard**: this worker
does roughly three reads a minute when no event is active (event-mode state, the evtrack document, plus sealing), about 4,320/day,
against 320,000 observed.

If you are ever debugging write volume here, that split is the first thing to
establish. Attributing dashboard reads to the recorder would send you looking
in the wrong worker.

## Gotchas

- **Failing soft became failing silent, and that is what the health record is
  for.** A wrong `CAPTURE_TOKEN` or `PAGES_BASE_URL` makes every feed 401 or
  404 while the worker goes on writing perfectly-formed *empty* bundles,
  sealing them, and reporting clean runs. The first anyone knows is an event
  that replays as a blank map — by which time the storm is over and the data is
  gone for good. **Check `evrec:health` after any config change.**
- **A 401 is ambiguous and the body snippet resolves it.** A 401 from the
  dashboard's own middleware is a token problem. A 401/403 carrying an HTML
  login page is Cloudflare Access sitting *in front of* Pages, which no token
  can satisfy. Opposite fixes; `looksLikeHtml` tells them apart instantly.
- **Timestamps arrive as ISO strings, not epoch ms.** The Event Mode API stores
  `startedAt`/`endedAt` as strings, so everything goes through `toMs()` and
  only numbers cross into the rest of the worker. Skipping that parse is
  silently catastrophic: string arithmetic yields `NaN`, the window collapses
  to 1 Jan 1970, and the sealing loop copies nothing while still reporting a
  clean run.
- **The sealing loop is newest-first, budgeted, and indexes every tick.** All
  three were learned the hard way and none is optional:
  - *Newest first* — the minute happening now is the one nobody can get back
    later. The lead-in backlog has been in the buffer for hours and can wait.
  - *Budgeted* — a 12-hour lead-in is 720 reads + 720 writes on the first tick,
    and an invocation gets **~1000 subrequests total**. The unbudgeted version
    blew the limit, the per-episode `catch` swallowed the throw, and because
    the index was only written *after* the loop, no progress was ever recorded.
    Every subsequent tick re-copied the same snapshots and died at the same
    wall, forever.
  - *Index every tick* — progress that isn't recorded didn't happen. Writing
    the index regardless of whether the budget ran out is what makes the
    backlog drain monotonically: ~300 minutes/tick, so a 12 h lead-in completes
    within about three minutes of declaration.

  The symptom of getting this wrong was *"the lead-in never appears"* and *"it
  keeps recording after I stop"* — both from this one loop.
- **Meta is not rewritten unconditionally.** An unconditional write races admin
  `PUT`s and can clobber a rename or window re-cut that landed between the read
  and the write. It is written on first touch, and again only to fill in
  `declaredEnd`.
- **Deletion and merging must survive the next tick.** Without the `:deleted`
  check the next tick would rebuild the meta for any episode still active or
  inside its lead-out, silently undoing the deletion. A `:mergedInto` episode
  keeps being sealed (its snapshots serve under the surviving event via
  `mergedIds`) but its meta must never be re-created, or it reappears in the
  list as a duplicate.
- **`windowEdited` protects an admin's re-cut window** from being stretched
  back out when the episode ends.
- **An active episode also appears in `history` with `endedAt: null`**, hence
  the dedupe in `sealTargets` — otherwise one episode seals twice under the
  same id.
- **Radar PNGs never enter KV.** R2 only, referenced by key. A radar failure is
  logged and skipped; it never costs the bundle.
- **Sealed snapshots are effectively permanent** (2-year TTL) and live in the
  shared namespace. Event history growth is real storage, not a rolling window.

## No HTTP endpoints

This worker exports only `scheduled()`. There is nothing to curl. To check on
it, read `evrec:health` from KV, or use the dashboard's event history UI.
