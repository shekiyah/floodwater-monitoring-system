// supabaseClient and parseSupabaseTimestamp come from
// supabase-config.js; requireRole comes from nav.js.
// Viewers are sent back to the dashboard; RLS on system_status is the
// real boundary.

function showTelemetryMessage(message, isError = false) {
    const el = document.getElementById("telemetryMessage");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
    el.classList.toggle("is-stale", Boolean(message) && isError);
}

async function loadSystemStatus() {

    const { data, error } = await supabaseClient
        .from("system_status")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(10);

    if (error) {
        console.error("Telemetry error:", error);
        const updated = document.getElementById("speedUpdated");
        if (updated) updated.textContent = "Telemetry read failed";
        showTelemetryMessage(
            `Cannot read system_status: ${error.message}. Check the SQL read policy and signed-in moderator/admin role.`,
            true
        );
        return;
    }

    if (!data || data.length === 0) {
        const updated = document.getElementById("speedUpdated");
        if (updated) updated.textContent = "No telemetry rows yet";
        showTelemetryMessage(
            "Waiting for the ESP32 to upload telemetry. Confirm the SQL fix ran and the firmware reports a successful update_system_status RPC.",
            false
        );
        return;
    }

    showTelemetryMessage("");
    updateSpeedCard(data);
}

// TELEMETRY HISTORY (speed chart)
// Default view is the most recent 48 hours. A custom date range can be
// applied to retrieve older records from system_status.
const TELEMETRY_HISTORY_PAGE_SIZE = 1000;
let activeTelemetryRange = null;
let telemetryHistoryRequestId = 0;

function showTelemetryHistoryMessage(message, isError = false) {
    const el = document.getElementById("telemetryHistoryMessage");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
    el.classList.toggle("is-stale", Boolean(message) && isError);
}

function getTelemetryCustomRange() {

    const startInput = document.getElementById("telemetryCustomStart");
    const endInput = document.getElementById("telemetryCustomEnd");

    if (!startInput?.value || !endInput?.value) {
        alert("Choose both a start and an end date.");
        return null;
    }

    // The date fields use Philippine calendar dates (UTC+08:00).
    // The end boundary is exclusive, so the selected end date is included.
    const start = new Date(`${startInput.value}T00:00:00+08:00`);
    const end = new Date(`${endInput.value}T00:00:00+08:00`);
    end.setTime(end.getTime() + 24 * 60 * 60 * 1000);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
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

function applyTelemetryDateRange() {

    const range = getTelemetryCustomRange();
    if (!range) return;

    activeTelemetryRange = range;
    loadTelemetryHistory(range);
}

async function fetchTelemetryHistoryRows(range) {

    const defaultStart = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const rows = [];
    let offset = 0;

    // Fetch in pages so longer date ranges are not silently limited to the
    // first page of records returned by Supabase.
    while (true) {

        let query = supabaseClient
            .from("system_status")
            .select("updated_at, upload_kbps, ping_ms");

        if (range) {
            query = query
                .gte("updated_at", range.start.toISOString())
                .lt("updated_at", range.end.toISOString());
        } else {
            query = query.gte("updated_at", defaultStart.toISOString());
        }

        const { data, error } = await query
            .order("updated_at", { ascending: true })
            .range(offset, offset + TELEMETRY_HISTORY_PAGE_SIZE - 1);

        if (error) {
            return { data: null, error };
        }

        const page = data || [];
        rows.push(...page);

        if (page.length < TELEMETRY_HISTORY_PAGE_SIZE) {
            break;
        }

        offset += TELEMETRY_HISTORY_PAGE_SIZE;
    }

    return { data: rows, error: null };
}

async function loadTelemetryHistory(range = activeTelemetryRange) {

    const requestId = ++telemetryHistoryRequestId;
    const heading = document.getElementById("telemetryChartHeading");

    if (heading) {
        heading.textContent = range
            ? `Upload Speed & Ping (${range.startLabel} to ${range.endLabel})`
            : "Upload Speed & Ping (48h)";
    }

    showTelemetryHistoryMessage(
        range ? "Loading telemetry for the selected dates…" : "Loading the latest 48 hours…"
    );

    const { data, error } = await fetchTelemetryHistoryRows(range);

    // Ignore an older response if the user applied another date range while
    // the previous request was still running.
    if (requestId !== telemetryHistoryRequestId) return;

    if (error) {
        console.error("Telemetry history error:", error);
        if (telemetrySpeedChartInstance) {
            telemetrySpeedChartInstance.destroy();
            telemetrySpeedChartInstance = null;
        }
        showTelemetryHistoryMessage(`Telemetry history failed to load: ${error.message}`, true);
        return;
    }

    if (!data || data.length === 0) {
        if (telemetrySpeedChartInstance) {
            telemetrySpeedChartInstance.destroy();
            telemetrySpeedChartInstance = null;
        }
        showTelemetryHistoryMessage(
            range
                ? "No telemetry records found for the selected dates."
                : "No telemetry records found in the last 48 hours."
        );
        return;
    }

    const labels = data.map(row => parseSupabaseTimestamp(row.updated_at).toLocaleString());

    renderSpeedChart(
        labels,
        data.map(row => hasValue(row.upload_kbps) ? Number(row.upload_kbps) / 1000 : null),
        data.map(row => hasValue(row.ping_ms) ? Number(row.ping_ms) : null)
    );

    showTelemetryHistoryMessage("");
}

// Two-line tick labels (date over time) so they fit on a phone.
function compactTick(value) {

    const label = this.getLabelForValue(value);

    return String(label).split(", ");
}

const timeAxis = {
    grid: { display: false },
    ticks: { maxTicksLimit: 5, maxRotation: 0, autoSkip: true, callback: compactTick }
};

// ---------------------------------------------------------------
// CONNECTION SPEED CARD (Speedtest-style gauge)
// Reads upload_kbps, ping_ms and data_used_kb from system_status.
// Missing columns or null values simply show "—".
// ---------------------------------------------------------------
const SPEED_STOPS = [0, 0.1, 0.5, 1, 2, 5, 10];   // Mbps, A7670C is Cat-1
const GAUGE = { cx: 150, cy: 150, r: 112, start: 135, sweep: 270 };
const STALE_AFTER_MIN = 10;

function hasValue(v) {
    return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

function gaugePoint(radius, deg) {
    const a = deg * Math.PI / 180;
    return [GAUGE.cx + radius * Math.cos(a), GAUGE.cy + radius * Math.sin(a)];
}

function gaugeArc(radius, fromDeg, toDeg) {
    const [x1, y1] = gaugePoint(radius, fromDeg);
    const [x2, y2] = gaugePoint(radius, toDeg);
    const large = (toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

// Piecewise scale: equal arc length per stop, like the Speedtest dial.
function speedFraction(mbps) {

    const last = SPEED_STOPS.length - 1;

    if (!(mbps > 0)) return 0;
    if (mbps >= SPEED_STOPS[last]) return 1;

    for (let i = 0; i < last; i++) {
        if (mbps <= SPEED_STOPS[i + 1]) {
            const part = (mbps - SPEED_STOPS[i]) / (SPEED_STOPS[i + 1] - SPEED_STOPS[i]);
            return (i + part) / last;
        }
    }

    return 1;
}

function buildGauge() {

    const track = document.getElementById("gaugeTrack");
    const ticks = document.getElementById("gaugeTicks");

    if (!track || !ticks) return;

    track.setAttribute("d", gaugeArc(GAUGE.r, GAUGE.start, GAUGE.start + GAUGE.sweep));

    const last = SPEED_STOPS.length - 1;
    let html = "";

    SPEED_STOPS.forEach((value, i) => {
        const deg = GAUGE.start + GAUGE.sweep * (i / last);
        const [x, y] = gaugePoint(GAUGE.r - 30, deg);
        html += `<text class="gauge-tick" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${value}</text>`;
    });

    ticks.innerHTML = html;

    setGauge(0, false);
}

function setGauge(mbps, hasData = true) {

    const progress = document.getElementById("gaugeProgress");
    const needle = document.getElementById("gaugeNeedle");
    const valueText = document.getElementById("gaugeValue");

    if (!progress || !needle || !valueText) return;

    const f = Math.max(speedFraction(mbps), 0.004);
    const deg = GAUGE.start + GAUGE.sweep * f;

    progress.setAttribute("d", gaugeArc(GAUGE.r, GAUGE.start, deg));
    needle.style.transform = `rotate(${GAUGE.start + GAUGE.sweep * speedFraction(mbps)}deg)`;
    valueText.textContent = hasData ? mbps.toFixed(2) : "—";
}

function formatAge(date) {

    const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));

    if (mins < 1) return { text: "Updated just now", stale: false };
    if (mins < 60) return { text: `Updated ${mins} min ago`, stale: mins > STALE_AFTER_MIN };

    const hrs = Math.round(mins / 60);
    return { text: `Updated ${hrs} h ago`, stale: true };
}

function updateSpeedCard(rows) {

    if (!rows || rows.length === 0) return;

    const latest = rows[0];

    const hasSpeed = hasValue(latest.upload_kbps);
    setGauge(hasSpeed ? Number(latest.upload_kbps) / 1000 : 0, hasSpeed);

    const pingEl = document.getElementById("speedPing");
    const jitterEl = document.getElementById("speedJitter");
    const dataEl = document.getElementById("speedData");
    const updatedEl = document.getElementById("speedUpdated");

    pingEl.innerHTML = hasValue(latest.ping_ms)
        ? `${Math.round(Number(latest.ping_ms))}<small>ms</small>` : "—";

    // Jitter = average change between consecutive ping readings.
    const pings = rows.filter(r => hasValue(r.ping_ms)).map(r => Number(r.ping_ms));

    if (pings.length >= 2) {
        let sum = 0;
        for (let i = 1; i < pings.length; i++) sum += Math.abs(pings[i] - pings[i - 1]);
        jitterEl.innerHTML = `${Math.round(sum / (pings.length - 1))}<small>ms</small>`;
    } else {
        jitterEl.textContent = "—";
    }

    dataEl.innerHTML = hasValue(latest.data_used_kb)
        ? `${(Number(latest.data_used_kb) / 1024).toFixed(2)}<small>MB</small>` : "—";

    if (latest.updated_at) {
        const age = formatAge(parseSupabaseTimestamp(latest.updated_at));
        updatedEl.textContent = age.text;
        updatedEl.classList.toggle("is-stale", age.stale);
    }
}

let telemetrySpeedChartInstance = null;

function renderSpeedChart(labels, uploadMbps, pingMs) {

    const ctx = document.getElementById("telemetrySpeedChart");

    if (!ctx) return;

    if (telemetrySpeedChartInstance) {
        telemetrySpeedChartInstance.destroy();
    }

    const light = "#9aa0c8";
    const gridColor = "rgba(255, 255, 255, 0.06)";

    telemetrySpeedChartInstance = new Chart(ctx, {

        type: "line",

        data: {
            labels: labels,
            datasets: [
                {
                    label: "Upload (Mbps)",
                    data: uploadMbps,
                    yAxisID: "y",
                    borderColor: "#b57bff",
                    backgroundColor: "rgba(181, 123, 255, 0.15)",
                    fill: true,
                    borderWidth: 2,
                    tension: 0.25,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true
                },
                {
                    label: "Ping (ms)",
                    data: pingMs,
                    yAxisID: "y1",
                    borderColor: "#5fe3ff",
                    borderWidth: 2,
                    tension: 0.25,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    spanGaps: true
                }
            ]
        },

        options: {
            responsive: true,
            interaction: { mode: "index", intersect: false },
            plugins: { legend: { labels: { color: light } } },
            scales: {
                x: { ...timeAxis, ticks: { ...timeAxis.ticks, color: light } },
                y: {
                    beginAtZero: true,
                    position: "left",
                    ticks: { color: light },
                    grid: { color: gridColor },
                    title: { display: true, text: "Mbps", color: light }
                },
                y1: {
                    beginAtZero: true,
                    position: "right",
                    ticks: { color: light },
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: "ms", color: light }
                }
            }
        }
    });
}

let telemetryStatusChannel = null;

async function init() {

    if (!(await requireRole("moderator"))) {
        return;
    }

    buildGauge();
    loadSystemStatus();
    loadTelemetryHistory();

    // Live telemetry: re-fetch the readout and both charts whenever
    // the device writes a new system_status row.
    telemetryStatusChannel = supabaseClient
        .channel("system-status-updates")
        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "system_status"
            },
            () => {
                loadSystemStatus();
                loadTelemetryHistory();
            }
        )
        .subscribe((status) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                console.warn("Telemetry Realtime status:", status, "; periodic refresh remains enabled.");
            }
        });

    // Fallback refresh: keeps telemetry updating even if Realtime is unavailable.
    // The Realtime listener still provides faster updates when it is connected.
    window.setInterval(() => {
        loadSystemStatus();
        loadTelemetryHistory();
    }, 60000);
}

init();