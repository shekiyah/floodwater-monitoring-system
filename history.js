// supabaseClient, getFloodStatus, parseSupabaseTimestamp and
// escapeHtml come from supabase-config.js

// Caps how many rows one query pulls back. The table says so when a
// result hits it, so a truncated list is never mistaken for the
// whole history.
const HISTORY_ROW_LIMIT = 5000;

// Keep the currently displayed rows in memory so Realtime INSERT events can
// update the table without re-fetching thousands of rows after every snapshot.
let historyRows = [];
let activeHistoryRange = null;
let historyChannel = null;
let smsEventQueryWarning = false;

const historyBody = document.getElementById("historyBody");
const historyMeta = document.getElementById("historyMeta");

function showHistoryMessage(text) {

    historyBody.innerHTML =
        `<tr class="table-empty"><td colspan="4">${escapeHtml(text)}</td></tr>`;

    historyMeta.textContent = "";
}

// ---------------------------------------------------------------------
// SHARED DATA ACCESS — the default load, custom Search and custom
// Download all go through this one query builder.
// rangeStart / rangeEnd are optional Date objects; either or both may
// be null for an open-ended bound.
// ---------------------------------------------------------------------
async function fetchReadings(rangeStart, rangeEnd) {

    let query = supabaseClient
        .from("water_readings")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(HISTORY_ROW_LIMIT);

    if (rangeStart) {
        query = query.gte("created_at", rangeStart.toISOString());
    }

    if (rangeEnd) {
        query = query.lt("created_at", rangeEnd.toISOString());
    }

    return await query;
}

// The ESP32 already records the exact SMS text in alert_events. Read those
// events and extract the water level from the message rather than inserting a
// second water_readings row that could trigger another database alert.
async function fetchSmsAlertEvents(rangeStart, rangeEnd) {

    let query = supabaseClient
        .from("alert_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(HISTORY_ROW_LIMIT);

    if (rangeStart) {
        query = query.gte("created_at", rangeStart.toISOString());
    }

    if (rangeEnd) {
        query = query.lt("created_at", rangeEnd.toISOString());
    }

    return await query;
}

function normalizeSmsAlertEvent(event) {

    const message = String(event?.message ?? "");
    const waterMatch = message.match(/\bWater:\s*(-?\d+(?:\.\d+)?)\s*m\b/i);
    const statusMatch = message.match(/\bFLOOD(?:\s+UPDATE)?\s*:?\s*(ALERT|CRITICAL|DANGER)\b/i);

    if (!waterMatch || !statusMatch || !event?.created_at) {
        return null;
    }

    const level = Number(waterMatch[1]);
    if (!Number.isFinite(level)) {
        return null;
    }

    return {
        id: `sms-alert-${event.id ?? `${event.device_id || "device"}-${event.created_at}-${level}`}`,
        created_at: event.created_at,
        water_level: level,
        status: statusMatch[1].toUpperCase(),
        device_id: event.device_id || "-",
        source: "sms_alert",
        message
    };
}

async function fetchCombinedHistory(rangeStart, rangeEnd) {

    const [readingsResult, smsResult] = await Promise.all([
        fetchReadings(rangeStart, rangeEnd),
        fetchSmsAlertEvents(rangeStart, rangeEnd)
    ]);

    if (readingsResult.error) {
        return {
            data: null,
            error: readingsResult.error,
            smsEventError: smsResult.error || null
        };
    }

    const readings = readingsResult.data || [];
    const smsRows = smsResult.error
        ? []
        : (smsResult.data || []).map(normalizeSmsAlertEvent).filter(Boolean);

    const combined = [...readings, ...smsRows].sort(
        (a, b) => parseSupabaseTimestamp(b.created_at) - parseSupabaseTimestamp(a.created_at)
    );

    return {
        data: combined.slice(0, HISTORY_ROW_LIMIT),
        error: null,
        smsEventError: smsResult.error || null
    };
}

// With no argument, loads the most recent readings (the default view
// for every role). With a range from the admin/moderator custom-range
// Search button, it's scoped to that range instead.
async function loadHistory(customRange) {

    activeHistoryRange = customRange || null;
    showHistoryMessage("Loading readings…");

    const { data, error, smsEventError } = await fetchCombinedHistory(
        activeHistoryRange ? activeHistoryRange.start : null,
        activeHistoryRange ? activeHistoryRange.end : null
    );

    smsEventQueryWarning = Boolean(smsEventError);

    if (smsEventError) {
        console.warn(
            "SMS alert history could not be loaded from alert_events. Check SELECT permissions and Realtime publication for this table:",
            smsEventError
        );
    }

    if (error) {
        console.error("History log query failed:", error);
        historyRows = [];
        showHistoryMessage(`Could not load readings: ${error.message}`);
        return;
    }

    historyRows = data || [];
    renderHistoryTable(historyRows, activeHistoryRange);
}

// ---------------------------------------------------------------------
// SHARED CUSTOM RANGE (admin/moderator only — #historyCustomRange).
// One pair of date inputs feeds Search, Download and Delete. The dates
// are local calendar dates (a date input has no time zone) and the
// range is end-exclusive so the chosen end date is fully included.
// Delete is admin-only: its button carries data-min-role="admin".
// ---------------------------------------------------------------------
function getCustomDateRange() {

    const startInput = document.getElementById("historyCustomStart");
    const endInput = document.getElementById("historyCustomEnd");

    if (!startInput.value || !endInput.value) {
        alert("Choose both a start and an end date.");
        return null;
    }

    const [startYear, startMonth, startDay] = startInput.value.split("-").map(Number);
    const [endYear, endMonth, endDay] = endInput.value.split("-").map(Number);

    const start = new Date(startYear, startMonth - 1, startDay);
    const end = new Date(endYear, endMonth - 1, endDay + 1);

    if (start >= end) {
        alert("The start date must be on or before the end date.");
        return null;
    }

    return {
        start,
        end,
        startLabel: startInput.value,
        endLabel: endInput.value
    };
}

function searchCustomRange() {

    const range = getCustomDateRange();

    if (range) {
        loadHistory(range);
    }
}

function getHistoryStatus(row) {

    if (row.status) return String(row.status).toUpperCase();

    if (row.water_level === null || row.water_level === undefined || row.water_level === "") {
        return "SENSOR_FAULT";
    }

    return getFloodStatus(Number(row.water_level));
}

function renderHistoryTable(data, customRange) {

    if (!data || data.length === 0) {
        showHistoryMessage(
            customRange
                ? "No readings in that date range."
                : "No readings recorded yet."
        );
        if (smsEventQueryWarning) {
            historyMeta.textContent =
                "SMS alert rows could not be loaded. Check the SELECT policy for public.alert_events in Supabase.";
        }
        return;
    }

    // One innerHTML write for the whole table; appending row by row
    // re-parses the table on every row and crawls at a few thousand.
    historyBody.innerHTML = data.map(row => {

        // Prefer the status saved by the ESP32. This preserves the exact
        // device decision at boundary values and correctly labels SENSOR_FAULT.
        const status = getHistoryStatus(row);

        const statusClass = ({
            NORMAL: "normal",
            ALERT: "alert",
            CRITICAL: "critical",
            DANGER: "danger",
            SENSOR_FAULT: "sensor-fault",
            UNKNOWN: "unknown"
        })[status] || "unknown";

        const hasWaterLevel = row.water_level !== null &&
            row.water_level !== undefined && row.water_level !== "" &&
            Number.isFinite(Number(row.water_level));
        const waterLevelText = hasWaterLevel ? `${Number(row.water_level).toFixed(2)} m` : "—";

        return `
            <tr>
                <td>${escapeHtml(parseSupabaseTimestamp(row.created_at).toLocaleString())}</td>
                <td>${escapeHtml(waterLevelText)}</td>
                <td><span class="pill pill--${statusClass}">${escapeHtml(row.source === "sms_alert" ? `${status} · SMS` : status)}</span></td>
                <td>${escapeHtml(row.device_id || "-")}</td>
            </tr>
        `;
    }).join("");

    const shown = data.length.toLocaleString();
    const smsCount = data.filter(row => row.source === "sms_alert").length;
    const sensorCount = data.length - smsCount;

    historyMeta.textContent = data.length >= HISTORY_ROW_LIMIT
        ? `Showing the most recent ${shown} records. Choose a date range to see older ones.`
        : `${sensorCount} sensor reading${sensorCount === 1 ? "" : "s"} and ${smsCount} SMS alert record${smsCount === 1 ? "" : "s"}.`;

    if (smsEventQueryWarning) {
        historyMeta.textContent += " SMS alert records may be missing because alert_events could not be read; check Supabase SELECT permissions.";
    }
}

// Admin-only. Permanently removes every water_readings row in the
// shared custom date range. The UI gating is a convenience; the
// DELETE policy on water_readings is what actually restricts this.
async function deleteCustomRangeData() {

    const range = getCustomDateRange();

    if (!range) {
        return;
    }

    const rangeLabel = `${range.startLabel} to ${range.endLabel}`;

    // Count first so the confirmation (and the "nothing to delete"
    // case) reflect what's actually there.
    const { count, error: countError } = await supabaseClient
        .from("water_readings")
        .select("*", { count: "exact", head: true })
        .gte("created_at", range.start.toISOString())
        .lt("created_at", range.end.toISOString());

    if (countError) {
        alert("Could not check how many readings would be deleted: " + countError.message);
        return;
    }

    if (!count) {
        alert(`No readings found for ${rangeLabel}.`);
        return;
    }

    const confirmed = confirm(
        `Delete all ${count} reading(s) from ${rangeLabel}?\n\nThis cannot be undone.`
    );

    if (!confirmed) {
        return;
    }

    const { data: deletedRows, error: deleteError } = await supabaseClient
        .from("water_readings")
        .delete()
        .gte("created_at", range.start.toISOString())
        .lt("created_at", range.end.toISOString())
        .select("id"); // returning rows tells a real delete from a silent RLS block

    if (deleteError) {
        alert("Delete failed: " + deleteError.message);
        return;
    }

    const deletedCount = deletedRows ? deletedRows.length : 0;

    // Supabase does NOT return an error when Row Level Security
    // silently blocks a delete; it reports 0 rows affected as if the
    // query had succeeded. That is almost always a missing DELETE
    // policy on water_readings (Database > Policies), not a bug here.
    if (deletedCount === 0) {
        alert(
            `${count} reading(s) matched ${rangeLabel}, but 0 were actually deleted.\n\n` +
            `Row Level Security on water_readings is silently blocking the delete for ` +
            `your account. Check Database > Policies for water_readings in Supabase and ` +
            `make sure a DELETE policy allows admins.`
        );
        return;
    }

    alert(`Deleted ${deletedCount} reading(s) from ${rangeLabel}.`);

    loadHistory();
}

// ---------------------------------------------------------------------
// EXCEL EXPORT — the custom-range "Download" button.
// ---------------------------------------------------------------------
async function exportReadingsToExcel(rangeStart, rangeEnd, filename) {

    const { data, error, smsEventError } = await fetchCombinedHistory(rangeStart, rangeEnd);

    if (smsEventError) {
        console.warn("Excel export could not include SMS alert events because alert_events was not readable:", smsEventError);
    }

    if (error) {
        alert("Could not load data to export: " + error.message);
        return;
    }

    if (!data || data.length === 0) {
        alert("There are no readings to export for that date range.");
        return;
    }

    const rows = data.slice().reverse().map(row => ({
        Date: parseSupabaseTimestamp(row.created_at).toLocaleString(),
        "Water Level (m)": row.water_level ?? "",
        Status: getHistoryStatus(row),
        Source: row.source === "sms_alert" ? "SMS alert" : "Sensor reading",
        Device: row.device_id || "-"
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Flood History");

    XLSX.writeFile(workbook, filename);
}

async function downloadCustomRange() {

    const range = getCustomDateRange();

    if (!range) {
        return;
    }

    await exportReadingsToExcel(
        range.start,
        range.end,
        `Flood_History_Custom_${range.startLabel}_to_${range.endLabel}.xlsx`
    );
}

// Keep History Logs live while the page is open. The dashboard already
// subscribes to this same table; this gives the history table the same behavior.
function rowIsInsideActiveRange(row) {

    if (!activeHistoryRange) return true;
    if (!row.created_at) return false;

    const timestamp = parseSupabaseTimestamp(row.created_at).getTime();
    return timestamp >= activeHistoryRange.start.getTime() &&
           timestamp < activeHistoryRange.end.getTime();
}

function handleHistoryInsert(payload) {

    const row = payload && payload.new;
    if (!row || !row.created_at || !rowIsInsideActiveRange(row)) return;

    const duplicate = historyRows.some(existing =>
        (row.id !== undefined && row.id !== null && existing.id === row.id) ||
        (existing.created_at === row.created_at &&
         existing.water_level === row.water_level &&
         existing.device_id === row.device_id)
    );

    if (duplicate) return;

    historyRows = [row, ...historyRows]
        .sort((a, b) => parseSupabaseTimestamp(b.created_at) - parseSupabaseTimestamp(a.created_at))
        .slice(0, HISTORY_ROW_LIMIT);

    renderHistoryTable(historyRows, activeHistoryRange);
}

function handleSmsAlertInsert(payload) {

    const row = normalizeSmsAlertEvent(payload && payload.new);
    if (!row || !rowIsInsideActiveRange(row)) return;

    const duplicate = historyRows.some(existing =>
        existing.source === "sms_alert" && existing.id === row.id
    );

    if (duplicate) return;

    historyRows = [row, ...historyRows]
        .sort((a, b) => parseSupabaseTimestamp(b.created_at) - parseSupabaseTimestamp(a.created_at))
        .slice(0, HISTORY_ROW_LIMIT);

    renderHistoryTable(historyRows, activeHistoryRange);
}

function subscribeToHistoryUpdates() {

    historyChannel = supabaseClient
        .channel("history-water-reading-updates")
        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "water_readings"
            },
            handleHistoryInsert
        )
        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "alert_events"
            },
            handleSmsAlertInsert
        )
        .subscribe(status => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                console.warn("History Realtime subscription status:", status);
            }
        });
}

subscribeToHistoryUpdates();
loadHistory();