/**
 * event-recorder - the "proper recording system" behind Event History.
 *
 * Cron: every minute (see wrangler.toml). Each run:
 *
 *   1. CAPTURE - fetch every feed through the dashboard's own /api proxies
 *      (one base URL + one shared token; every proxy's params, transforms
 *      and caching are reused rather than re-implemented) and write ONE
 *      bundle key `evbuf:<minuteTs>` with a rolling 25 h TTL. This buffer
 *      is what makes the 12-hour lead-in possible: nothing knows an event
 *      is coming, so the recent past is always held, briefly, for all
 *      feeds.
 *
 *      CREW PRIVACY: the eroad feed is only captured when CREW_BUFFER=on.
 *      That setting means continuous recording of crew vehicle positions
 *      into the rolling buffer, auto-purged within ~25 h and only ever
 *      sealed (kept, exposed) inside a declared event's window. It is a
 *      deliberate, deploy-time relaxation of the live privacy gate -
 *      switch it off and events simply have no crew data before their
 *      declaration.
 *
 *   2. SEAL - read the shared Event Mode state. While an episode is active,
 *      every buffered minute from (declaredStart - 12 h) onward that isn't
 *      sealed yet is copied to `event:<id>:snap:<ts>` with a 2-YEAR TTL,
 *      and the index updated. Sealing happens DURING the event, not after,
 *      so a crash mid-storm loses at most a minute. When the episode ends,
 *      sealing continues for 1 h of lead-out, then a meta record is
 *      finalised.
 *
 *   3. RADAR - while sealing is active, the latest radar frame PNG is
 *      copied into R2 (`event/<id>/radar/<ts>.png`) and referenced from the
 *      bundle. Images never enter KV.
 *
 * Required bindings/vars (Cloudflare UI):
 *   KV        OUTAGE_DATA   - same namespace the dashboard uses
 *   R2        EVENT_RADAR   - bucket name: westpower-event-radar
 *   var       PAGES_BASE_URL  e.g. https://outages.example.pages.dev
 *   secret    CAPTURE_TOKEN   must equal the Pages project's EVENT_CAPTURE_TOKEN
 *                             (or its UPLOAD_TOKEN, if that is still the
 *                             only one set - see functions/_middleware.ts)
 *   var       CREW_BUFFER     "on" to enable the crew lead-in buffer
 */

const MIN = 60_000;
const BUFFER_TTL_S = 25 * 60 * 60;
const EVENT_TTL_S = 2 * 365 * 24 * 60 * 60;
const LEAD_IN_MS = 12 * 60 * 60 * 1000;
const LEAD_OUT_MS = 60 * 60 * 1000;

/** Feed name → dashboard proxy path. Add a feed here and it is archived. */
const FEEDS = {
  lightning: "/api/lightning",
  weatherAlerts: "/api/weather-alerts",
  earthquakes: "/api/earthquakes",
  roadEvents: "/api/road-events",
  loadings: "/api/loadings?format=columnar",
  transpowerNotices: "/api/transpower-notices",
  outages: "/api/outages",
  // Civil Defence zones. Near-static geometry, but a designation can be
  // escalated from Proposed to Evacuation Order mid-event - which is
  // precisely the minute worth having a record of - so it is captured per
  // minute like everything else rather than treated as reference data.
  evacuationZones: "/api/evacuation-zones",
};
const EROAD_PATH = "/api/eroad";
// The dashboard's own radar proxy. 300K is the wide range the map shows by
// default; a replay frame is a picture of the whole network area.
const RADAR_LATEST_PATH = "/api/rain-radar/image?range=300K";

/**
 * The dashboard origin, with any trailing slash removed. Pasting the URL
 * straight out of a browser leaves a trailing "/", which would make every
 * request "https://host//api/..." - a double slash that doesn't resolve,
 * and because captures fail soft, the worker would run happily and record
 * nothing. Normalising here means the variable can be set either way.
 */
function base(env) {
  return String(env.PAGES_BASE_URL || "").replace(/\/+$/, "");
}

/**
 * Fetch one feed, recording WHY it failed if it did.
 *
 * Captures fail soft by design - one dead feed must not cost the whole
 * minute - but "fails soft" became "fails silent": a wrong CAPTURE_TOKEN or
 * PAGES_BASE_URL makes every feed 401 or 404, and the worker goes on
 * writing perfectly-formed empty bundles, sealing them, and reporting clean
 * runs. The first anyone knows is an event that replays as a blank map, by
 * which time the storm is over and the data is gone for good.
 *
 * So every outcome is reported into `outcomes`, which the caller writes to
 * a health record. Failing softly is still right; failing invisibly is not.
 */
async function fetchJson(env, path, outcomes) {
  const url = base(env) + path;
  try {
    const r = await fetch(url, {
      headers: { "X-Capture-Token": env.CAPTURE_TOKEN },
    });
    if (!r.ok) {
      // Capture a short snippet of the failure body. The status alone is
      // ambiguous - a 401 from the dashboard's own middleware is a token
      // problem, while a 401/403 carrying an HTML login page is something
      // in FRONT of Pages (Cloudflare Access), which no token can satisfy.
      // Those two need opposite fixes, and the first line of the body tells
      // them apart instantly.
      let snippet;
      try {
        const text = await r.text();
        snippet = text.slice(0, 160).replace(/\s+/g, " ").trim();
      } catch { /* body may be empty or unreadable; the status still helps */ }
      if (outcomes) {
        outcomes.push({
          path, ok: false, status: r.status, body: snippet,
          looksLikeHtml: typeof snippet === "string" && /^<(!doctype|html)/i.test(snippet),
        });
      }
      return undefined;
    }
    const body = await r.json();
    if (outcomes) outcomes.push({ path, ok: true, status: r.status });
    return body;
  } catch (e) {
    if (outcomes) outcomes.push({ path, ok: false, error: String(e && e.message ? e.message : e) });
    return undefined;
  }
}

async function readEventState(env) {
  try {
    const raw = await env.OUTAGE_DATA.get("event-mode", "json");
    if (!raw) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Episodes needing sealing right now: active, or ended within lead-out.
 *
 * The Event Mode API stores startedAt/endedAt as ISO STRINGS, not epoch
 * milliseconds, so every timestamp is parsed here and only numbers cross
 * into the rest of this worker. Skipping that parse is silently
 * catastrophic: string arithmetic yields NaN, the window collapses to
 * 1 Jan 1970, and the sealing loop copies nothing while still reporting
 * a clean run.
 */
function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function sealTargets(state, now) {
  if (!state) return [];
  const out = [];
  if (state.active) {
    const startedAt = toMs(state.startedAt);
    if (startedAt !== null) {
      out.push({ id: startedAt, startedAt, endedAt: null,
        startedBy: state.startedBy, trigger: state.trigger });
    }
  }
  for (const ep of state.history ?? []) {
    const startedAt = toMs(ep.startedAt);
    const endedAt = toMs(ep.endedAt);
    if (startedAt === null || endedAt === null) continue;
    if (now - endedAt <= LEAD_OUT_MS + 2 * MIN) {
      out.push({ id: startedAt, startedAt, endedAt,
        startedBy: ep.startedBy, trigger: ep.trigger });
    }
  }
  // An active episode also appears in history with endedAt null; dedupe so a
  // single episode isn't sealed twice under the same id.
  const seen = new Set();
  return out.filter((ep) => (seen.has(ep.id) ? false : (seen.add(ep.id), true)));
}

function defaultEventName(startedAt) {
  const d = new Date(startedAt);
  return `Event · ${d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}`;
}

async function loadIndex(env, id) {
  return (await env.OUTAGE_DATA.get(`event:${id}:index`, "json")) ?? [];
}

async function sealEpisode(env, ep, minuteTs, budget) {
  const kv = env.OUTAGE_DATA;
  // An admin deleted this event. Respect that permanently: without this
  // check the next tick would rebuild the meta for any episode still active
  // or inside its lead-out, and the deletion would silently undo itself.
  if (await kv.get(`event:${ep.id}:deleted`)) return;
  // An admin merged this episode into another event. Its snapshots must
  // keep being sealed (they serve under the surviving event via mergedIds),
  // but its own meta must never be re-created, or the merged event would
  // reappear in the list as a duplicate.
  const mergedInto = await kv.get(`event:${ep.id}:mergedInto`);

  // Read the meta whether or not it will be written: its window is what
  // decides how far back to seal, and an admin may have widened it.
  const metaKey = `event:${ep.id}:meta`;
  let meta = await kv.get(metaKey, "json");
  const now = Date.now();

  if (!mergedInto) {
    // Meta: create on first touch, keep declaredEnd fresh.
    if (!meta) {
      meta = {
        id: ep.id,
        name: defaultEventName(ep.id),
        description: "",
        windowStart: ep.startedAt - LEAD_IN_MS,
        windowEnd: (ep.endedAt ?? now) + LEAD_OUT_MS,
        declaredStart: ep.startedAt,
        declaredEnd: ep.endedAt,
        startedBy: ep.startedBy,
        trigger: ep.trigger,
        mergedIds: [],
        createdAt: now,
        updatedAt: now,
      };
      await kv.put(metaKey, JSON.stringify(meta)); // no TTL: metas are permanent
    } else if (meta.declaredEnd == null && ep.endedAt != null) {
      meta.declaredEnd = ep.endedAt;
      // Only stretch the auto window if the admin hasn't already re-cut it
      // (windowEdited is set by the edit/split paths in the events API).
      if (!meta.windowEdited) {
        meta.windowEnd = Math.max(meta.windowEnd, ep.endedAt + LEAD_OUT_MS);
      }
      meta.updatedAt = now;
      await kv.put(metaKey, JSON.stringify(meta));
    }
    // Otherwise: meta exists and needs no recorder-side change. Do NOT
    // write it back - an unconditional rewrite races admin PUTs and can
    // clobber a rename/re-cut that landed between our read and write.
  }

  // Copy every buffered minute in the sealing range that isn't sealed yet.
  //
  // The range is the WIDER of the automatic lead-in/lead-out and the meta's
  // own window (see the widening notes above), bounded by the buffer's 25 h
  // reach.
  //
  // HOW THIS LOOP MUST BEHAVE - learned the hard way:
  //
  //   1. NEWEST FIRST. The minute happening right now is the one nobody can
  //      get back later; the lead-in backlog has been sitting in the buffer
  //      for hours and can wait a few more ticks. Oldest-first meant the
  //      backlog could starve the present.
  //
  //   2. BUDGETED. A 12-hour lead-in is 720 reads + 720 writes on the first
  //      tick after declaration - and a Worker invocation gets ~1000
  //      subrequests TOTAL. The unbudgeted version blew that limit, the
  //      per-episode catch swallowed the throw, and because the index was
  //      only written after the loop, NO progress was ever recorded: every
  //      subsequent tick re-copied the same snapshots and died at the same
  //      wall, forever. The symptom upstairs was "the lead-in never
  //      appears" and "it keeps recording after I stop" - both this one
  //      loop.
  //
  //   3. INDEX EVERY TICK. Progress that isn't recorded didn't happen, as
  //      far as the next tick and the replay are concerned. The index write
  //      happens whether or not the budget ran out, so each tick's work
  //      sticks and the backlog drains monotonically (~300 minutes/tick, a
  //      12 h lead-in completes within about 3 minutes of declaration).
  const index = await loadIndex(env, ep.id);
  const sealed = new Set(index);
  const autoFrom = ep.startedAt - LEAD_IN_MS;
  const metaFrom = meta && Number.isFinite(meta.windowStart) ? meta.windowStart : autoFrom;
  const bufferFloor = minuteTs - BUFFER_TTL_S * 1000;
  const from = Math.max(Math.min(autoFrom, metaFrom), bufferFloor);
  const autoTo = ep.endedAt ? Math.min(minuteTs, ep.endedAt + LEAD_OUT_MS) : minuteTs;
  const metaTo = meta && Number.isFinite(meta.windowEnd) ? meta.windowEnd : autoTo;
  const to = Math.min(Math.max(autoTo, metaTo), minuteTs);

  let dirty = false;
  for (let t = Math.floor(to / MIN) * MIN; t >= Math.ceil(from / MIN) * MIN; t -= MIN) {
    if (sealed.has(t)) continue;
    if (budget.ops >= budget.max) break;   // rest of the backlog next tick
    budget.ops++;
    const bundle = await kv.get(`evbuf:${t}`);
    if (bundle === null) continue; // before the buffer existed, or expired
    budget.ops++;
    await kv.put(`event:${ep.id}:snap:${t}`, bundle, { expirationTtl: EVENT_TTL_S });
    index.push(t);
    dirty = true;
  }
  if (dirty) {
    index.sort((a, b) => a - b);
    await kv.put(`event:${ep.id}:index`, JSON.stringify(index), { expirationTtl: EVENT_TTL_S });
  }
}

async function captureRadar(env, minuteTs, activeIds) {
  if (!env.EVENT_RADAR) return undefined;
  try {
    const r = await fetch(base(env) + RADAR_LATEST_PATH, {
      headers: { "X-Capture-Token": env.CAPTURE_TOKEN },
    });
    if (!r.ok) {
      console.warn(`event-recorder: radar capture failed (HTTP ${r.status})`);
      return undefined;
    }
    const png = await r.arrayBuffer();
    let key;
    for (const id of activeIds) {
      key = `event/${id}/radar/${minuteTs}.png`;
      await env.EVENT_RADAR.put(key, png, { httpMetadata: { contentType: "image/png" } });
    }
    return key;
  } catch {
    return undefined;
  }
}

export default {
  async scheduled(_controller, env, _ctx) {
    if (!env.PAGES_BASE_URL || !env.CAPTURE_TOKEN) {
      console.error("event-recorder: PAGES_BASE_URL / CAPTURE_TOKEN not configured");
      return;
    }
    const minuteTs = Math.floor(Date.now() / MIN) * MIN;

    // ---- 1. capture the bundle ----
    const bundle = { ts: minuteTs };
    const outcomes = [];
    await Promise.all(Object.entries(FEEDS).map(async ([name, path]) => {
      const data = await fetchJson(env, path, outcomes);
      if (data !== undefined) bundle[name] = data;
    }));
    if (env.CREW_BUFFER === "on") {
      const eroad = await fetchJson(env, EROAD_PATH, outcomes);
      if (eroad !== undefined) bundle.eroad = eroad;
    }

    // ---- 1b. health record ----
    // Written every tick, TTL'd so it can only ever describe the recent
    // past. A run where nothing was captured is called out explicitly,
    // because that is the failure mode that otherwise hides for weeks.
    const failed = outcomes.filter((o) => !o.ok);
    const captured = outcomes.length - failed.length;
    if (captured === 0) {
      console.error(
        `event-recorder: EVERY feed failed this run (${failed.length} feeds). `
        + `Check PAGES_BASE_URL (${base(env) || "unset"}) and that CAPTURE_TOKEN `
        + `matches the Pages project's EVENT_CAPTURE_TOKEN. Sealed snapshots will be empty.`,
        failed.slice(0, 4),
      );
    } else if (failed.length > 0) {
      console.warn(`event-recorder: ${failed.length}/${outcomes.length} feeds failed`, failed.slice(0, 4));
    }
    try {
      await env.OUTAGE_DATA.put("evrec:health", JSON.stringify({
        ts: minuteTs,
        baseUrl: base(env),
        crewBuffer: env.CREW_BUFFER === "on",
        radarConfigured: !!env.EVENT_RADAR,
        captured,
        total: outcomes.length,
        feeds: outcomes.sort((a, b) => a.path.localeCompare(b.path)),
      }), { expirationTtl: BUFFER_TTL_S });
    } catch { /* health reporting must never break a capture */ }

    // ---- 2/3. seal + radar for any episode needing it ----
    const state = await readEventState(env);
    const targets = sealTargets(state, minuteTs);
    if (targets.length > 0) {
      const radarKey = await captureRadar(env, minuteTs, targets.map((t) => t.id));
      if (radarKey) bundle.radarKey = radarKey;
    }

    await env.OUTAGE_DATA.put(`evbuf:${minuteTs}`, JSON.stringify(bundle), {
      expirationTtl: BUFFER_TTL_S,
    });

    // One sealing budget shared across every episode needing work this tick.
    // ~15 ops are already spent on captures/health/radar/state; 600 leaves
    // generous headroom under the ~1000-subrequest ceiling while still
    // draining a 12-hour backlog in about three ticks.
    const budget = { ops: 0, max: 600 };
    for (const ep of targets) {
      try { await sealEpisode(env, ep, minuteTs, budget); }
      catch (e) { console.error(`event-recorder: seal failed for ${ep.id}`, e); }
    }
  },
};
