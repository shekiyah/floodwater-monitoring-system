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

// Flood status thresholds, in meters. The dashboard and the history
// log both use this, and the gauge bands in style.css and
// dashboard.html are drawn from the same numbers.
function getFloodStatus(level) {

    if (level <= 2) {
        return "NORMAL";
    }

    if (level <= 4) {
        return "ALERT";
    }

    if (level <= 5.5) {
        return "CRITICAL";
    }

    return "DANGER";
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