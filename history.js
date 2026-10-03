// supabaseClient, getFloodStatus, parseSupabaseTimestamp and
// escapeHtml come from supabase-config.js

// Caps how many rows one query pulls back. The table says so when a
// result hits it, so a truncated list is never mistaken for the
// whole history.
const HISTORY_ROW_LIMIT = 5000;

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

// With no argument, loads the most recent readings (the default view
// for every role). With a range from the admin/moderator custom-range
// Search button, it's scoped to that range instead.
async function loadHistory(customRange) {

    showHistoryMessage("Loading readings…");

    const { data, error } = await fetchReadings(
        customRange ? customRange.start : null,
        customRange ? customRange.end : null
    );

    if (error) {
        console.error(error);
        showHistoryMessage("Could not load readings. Refresh the page to try again.");
        return;
    }

    renderHistoryTable(data, customRange);
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

function renderHistoryTable(data, customRange) {

    if (!data || data.length === 0) {
        showHistoryMessage(
            customRange
                ? "No readings in that date range."
                : "No readings recorded yet."
        );
        return;
    }

    // One innerHTML write for the whole table; appending row by row
    // re-parses the table on every row and crawls at a few thousand.
    historyBody.innerHTML = data.map(row => {

        const status = getFloodStatus(row.water_level);

        return `
            <tr>
                <td>${escapeHtml(parseSupabaseTimestamp(row.created_at).toLocaleString())}</td>
                <td>${escapeHtml(row.water_level)} m</td>
                <td><span class="pill pill--${status.toLowerCase()}">${status}</span></td>
                <td>${escapeHtml(row.device_id || "-")}</td>
            </tr>
        `;
    }).join("");

    const shown = data.length.toLocaleString();

    historyMeta.textContent = data.length >= HISTORY_ROW_LIMIT
        ? `Showing the most recent ${shown} readings. Choose a date range to see older ones.`
        : `${shown} reading${data.length === 1 ? "" : "s"}.`;
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

    const { data, error } = await fetchReadings(rangeStart, rangeEnd);

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
        "Water Level (m)": row.water_level,
        Status: getFloodStatus(row.water_level),
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

loadHistory();