// Shared Supabase client and helpers — loaded once, used by every
// authenticated page. Load this AFTER the @supabase/supabase-js CDN
// script and BEFORE any page script.
//
// The key below is a *publishable* key, so it's safe to ship in the
// browser. What it can read or change is decided by the Row Level
// Security policies in Supabase, not by anything in this front end.

const SUPABASE_URL = "https://gkelvwfblefvpgyawnpx.supabase.co";
const SUPABASE_KEY = "sb_publishable_38ibJ1U_DQKhO1Cg7Mfy6A_xto-x2UF";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Supabase/Postgres timestamps come back either as full UTC
// ("...Z" or "...+00:00") or, if a column is `timestamp` WITHOUT
// time zone, as a bare "YYYY-MM-DDTHH:mm:ss" with no zone marker.
// JavaScript treats a zone-less string as already being in the
// browser's local time, which is wrong here: the stored value is
// UTC. That mismatch shows up as readings appearing at the wrong
// time of day.
//
// This treats any zone-less timestamp as UTC before handing it to
// Date. Use it instead of `new Date(row.created_at)` anywhere a
// Supabase timestamp is parsed.
function parseSupabaseTimestamp(value) {

    if (typeof value !== "string") {
        return new Date(value);
    }

    const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(value);

    return new Date(hasZone ? value : value + "Z");
}

// Flood status thresholds, in meters. The dashboard, the history log
// and the gauge all use this, and the gauge bands in style.css and
// dashboard.html are drawn from the same numbers:
//
//   below 2.00            NORMAL
//   2.00  to below 4.00   ALERT
//   4.00  to below 6.40   CRITICAL
//   6.40 and above        DANGER
//
// A missing or non-numeric level is UNKNOWN rather than being
// silently classified.
function getFloodStatus(level) {

    if (level === null || level === undefined || level === "") {
        return "UNKNOWN";
    }

    const meters = Number(level);

    if (!Number.isFinite(meters)) {
        return "UNKNOWN";
    }

    if (meters < 2) {
        return "NORMAL";
    }

    if (meters < 4) {
        return "ALERT";
    }

    if (meters < 6.4) {
        return "CRITICAL";
    }

    return "DANGER";
}

// ---------------------------------------------------------------
// MONITORING-SYSTEM TIME ZONE
// The station is in the Philippines. Day boundaries and every time
// shown on the dashboard use Asia/Manila (UTC+8, no daylight saving)
// no matter what time zone the viewer's device is set to.
// ---------------------------------------------------------------
const MONITOR_TIMEZONE = "Asia/Manila";
const MONITOR_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

// "YYYY-MM-DD" (a <input type="date"> value) -> the UTC millisecond
// instant of 00:00:00.000 on that calendar day in Manila.
function monitorDayStartMs(ymd) {

    const [year, month, day] = String(ymd).split("-").map(Number);

    return Date.UTC(year, month - 1, day) - MONITOR_UTC_OFFSET_MS;
}

// Today's calendar date in Manila, as "YYYY-MM-DD".
function monitorTodayString(nowMs = Date.now()) {

    return new Date(nowMs + MONITOR_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

const MONITOR_FORMATS = {
    date: new Intl.DateTimeFormat("en-US", { timeZone: MONITOR_TIMEZONE, year: "numeric", month: "short", day: "numeric" }),
    shortDate: new Intl.DateTimeFormat("en-US", { timeZone: MONITOR_TIMEZONE, month: "short", day: "numeric" }),
    time: new Intl.DateTimeFormat("en-US", { timeZone: MONITOR_TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true }),
    timeSeconds: new Intl.DateTimeFormat("en-US", { timeZone: MONITOR_TIMEZONE, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
};

function formatMonitorDate(ms) { return MONITOR_FORMATS.date.format(ms); }
function formatMonitorShortDate(ms) { return MONITOR_FORMATS.shortDate.format(ms); }
function formatMonitorTime(ms, withSeconds = false) {
    return (withSeconds ? MONITOR_FORMATS.timeSeconds : MONITOR_FORMATS.time).format(ms);
}
function formatMonitorDateTime(ms, withSeconds = false) {
    return formatMonitorDate(ms) + ", " + formatMonitorTime(ms, withSeconds);
}

// Escape text before putting it into an innerHTML template string.
// Anything that came from a user or a device (names, notes, device
// IDs) goes through this so it can't inject markup.
function escapeHtml(value) {

    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[char]));
}