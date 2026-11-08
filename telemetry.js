// supabaseClient, parseSupabaseTimestamp, monitorDayStartMs, monitorTodayString
// and the formatMonitor* helpers come from supabase-config.js; requireRole
// comes from nav.js. Viewers are sent back to the dashboard; RLS on
// system_status is the real boundary.
//
// What the station sends (FMW firmware): one system_status post every
// 5 minutes (STATUS_INTERVAL_MS), retried after 60 s on failure, containing
// internet_status, gsm_signal, device_status, upload_kbps, ping_ms and
// data_used_kb. The upload speed is a probe taken every 6th post and carried
// over between probes. data_used_kb is the device's running total for its
// current day; it restarts at midnight and whenever the device reboots.
//
// OFFLINE RULE: the page is ONLINE only while the newest row's updated_at is
// no older than STALE_AFTER_MIN (two missed 5-minute posts). Otherwise the
// gauge, Ping and Jitter show zero as a DISPLAY fallback. Nothing is written
// to the database, and the real values return when a fresh row arrives.

const STALE_AFTER_MIN = 10;
const CHECK_MS = 30000;            // re-judge freshness this often
const REFRESH_MS = 60000;          // re-read the table in case a realtime event is missed
const DAY_MS = 24 * 60 * 60 * 1000;

const HISTORY_PAGE = 1000;         // Supabase returns at most this many rows per request
const HISTORY_LIMIT = 50000;       // safety cap for one range
const GAP_BREAK_MS = 15 * 60 * 1000; // 3 missed posts: break the line instead of joining across a gap

// Upload gauge scale, in Kbps. Equal arc length per stop so the low speeds
// this GSM link produces (tens to hundreds of Kbps) are easy to read.
const SPEED_STOPS = [0, 50, 100, 250, 500, 1000, 2500, 5000];
const GAUGE = { cx: 150, cy: 150, r: 104, start: 135, sweep: 270 };

const byId = id => document.getElementById(id);

function hasValue(v) {
    return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ageText(ms) {

    const m = Math.max(0, Math.floor(ms / 60000));

    if (m < 1) return "just now";
    if (m < 60) return `${plural(m, "minute")} ago`;

    const h = Math.floor(m / 60);

    if (h < 24) return `${plural(h, "hour")} ago`;

    return `${plural(Math.floor(h / 24), "day")} ago`;
}

// ---------------------------------------------------------------
// GAUGE
// ---------------------------------------------------------------
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

// Piecewise scale: equal arc length per stop.
function speedFraction(kbps) {

    const last = SPEED_STOPS.length - 1;

    if (!(kbps > 0)) return 0;
    if (kbps >= SPEED_STOPS[last]) return 1;

    for (let i = 0; i < last; i++) {
        if (kbps <= SPEED_STOPS[i + 1]) {
            const part = (kbps - SPEED_STOPS[i]) / (SPEED_STOPS[i + 1] - SPEED_STOPS[i]);
            return (i + part) / last;
        }
    }

    return 1;
}

function stopLabel(value) {
    return value >= 1000 ? (value / 1000) + "K" : String(value);
}

function buildGauge() {

    const track = byId("gaugeTrack");
    const ticks = byId("gaugeTicks");

    if (!track || !ticks) return;

    track.setAttribute("d", gaugeArc(GAUGE.r, GAUGE.start, GAUGE.start + GAUGE.sweep));

    const last = SPEED_STOPS.length - 1;
    const MINOR = 3;                         // minor ticks between two labelled stops
    let html = "";

    for (let i = 0; i <= last * (MINOR + 1); i++) {

        const major = i % (MINOR + 1) === 0;
        const deg = GAUGE.start + GAUGE.sweep * (i / (last * (MINOR + 1)));
        const [x1, y1] = gaugePoint(GAUGE.r - (major ? 22 : 17), deg);
        const [x2, y2] = gaugePoint(GAUGE.r - 12, deg);

        html += `<line class="tm-g-tick${major ? " is-major" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;

        if (major) {
            const [lx, ly] = gaugePoint(GAUGE.r + 22, deg);
            html += `<text class="tm-g-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${stopLabel(SPEED_STOPS[i / (MINOR + 1)])}</text>`;
        }
    }

    ticks.innerHTML = html;

    setGauge(0, "nodata");
}

// state: "live" (real measurement), "nodata" (online but no speed yet),
// "offline" (stale telemetry: needle at zero, 0.00).
function setGauge(kbps, state) {

    const progress = byId("gaugeProgress");
    const needle = byId("gaugeNeedle");
    const valueText = byId("gaugeValue");

    if (!progress || !needle || !valueText) return;

    const live = state === "live";
    const f = live ? speedFraction(kbps) : 0;

    progress.setAttribute("d", gaugeArc(GAUGE.r, GAUGE.start, GAUGE.start + GAUGE.sweep * Math.max(f, 0.004)));
    progress.style.opacity = live ? "1" : "0";

    needle.style.transform = `rotate(${GAUGE.start + GAUGE.sweep * f}deg)`;

    valueText.textContent = state === "live" ? kbps.toFixed(2)
        : state === "offline" ? "0.00"
        : "—";
}

// ---------------------------------------------------------------
// LIVE READOUT (gauge, ping, jitter, status, updated text)
// ---------------------------------------------------------------
let statusRows = [];        // newest system_status rows, newest first

function setNumber(id, text) {
    const node = byId(id);
    if (node) node.textContent = text;
}

function jitterOf(rows) {

    // Jitter = average change between consecutive ping readings.
    const pings = rows.filter(r => hasValue(r.ping_ms)).map(r => Number(r.ping_ms));

    if (pings.length < 2) return null;

    let sum = 0;
    for (let i = 1; i < pings.length; i++) sum += Math.abs(pings[i] - pings[i - 1]);

    return Math.round(sum / (pings.length - 1));
}

function renderTelemetry() {

    const panel = byId("tmPanel");

    if (!panel) return;

    const latest = statusRows[0];
    const updatedEl = byId("speedUpdated");

    let ts = null;

    if (latest && latest.updated_at) {
        ts = parseSupabaseTimestamp(latest.updated_at);
    }

    const valid = ts && !Number.isNaN(ts.getTime());
    const ageMs = valid ? Date.now() - ts.getTime() : Infinity;
    const fresh = ageMs <= STALE_AFTER_MIN * 60000;
    const internetOk = !latest || latest.internet_status === null || latest.internet_status === undefined ||
        /online|connected|active|up|true|^1$/i.test(String(latest.internet_status));
    const online = fresh && internetOk;

    panel.dataset.state = online ? "online" : "offline";

    setNumber("tmConnText", online ? "ONLINE" : "OFFLINE");
    setNumber("gaugeState", online ? "ONLINE" : "OFFLINE");

    if (!fresh) {
        setGauge(0, "offline");
        setNumber("speedPing", "0");
        setNumber("speedJitter", "0");

        updatedEl.textContent = "NO RECENT TELEMETRY";
        updatedEl.title = valid
            ? `Last successful update: ${formatMonitorDateTime(ts.getTime(), true)} (${ageText(ageMs)})`
            : "No telemetry received yet";
        updatedEl.classList.add("is-offline");
        return;
    }

    updatedEl.classList.remove("is-offline");

    const hasSpeed = hasValue(latest.upload_kbps);
    setGauge(hasSpeed ? Number(latest.upload_kbps) : 0, hasSpeed ? "live" : "nodata");

    setNumber("speedPing", hasValue(latest.ping_ms) ? String(Math.round(Number(latest.ping_ms))) : "—");

    const jitter = jitterOf(statusRows);
    setNumber("speedJitter", jitter === null ? "—" : String(jitter));

    updatedEl.textContent = `Updated ${ageText(ageMs)}`;
    updatedEl.title = `Last successful update: ${formatMonitorDateTime(ts.getTime(), true)}`;
}

async function loadSystemStatus() {

    const { data, error } = await supabaseClient
        .from("system_status")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(10);

    if (error) {
        console.error("Telemetry error:", error);
        return;
    }

    statusRows = data || [];
    renderTelemetry();
}

// ---------------------------------------------------------------
// DATA USED TODAY
// Total of today's (Asia/Manila) posts. The device counter restarts at
// midnight and on reboot, so a drop between two rows starts a new segment and
// the segments are added together. No rows today = 0.00 MB.
// ---------------------------------------------------------------
let dataUsedKb = 0;

function sumDailyUsage(rows) {

    let total = 0;
    let segmentMax = 0;
    let previous = null;

    for (const row of rows) {

        if (!hasValue(row.data_used_kb)) continue;

        const value = Number(row.data_used_kb);

        if (previous !== null && value < previous) {
            total += segmentMax;
            segmentMax = 0;
        }

        if (value > segmentMax) segmentMax = value;
        previous = value;
    }

    return total + segmentMax;
}

function renderDataUsed() {
    setNumber("speedData", (dataUsedKb / 1024).toFixed(2));
}

async function loadDataUsedToday() {

    const startMs = monitorDayStartMs(monitorTodayString());

    const { data, error } = await supabaseClient
        .from("system_status")
        .select("updated_at, data_used_kb")
        .gte("updated_at", new Date(startMs).toISOString())
        .order("updated_at", { ascending: true })
        .limit(HISTORY_PAGE);

    if (error) {
        console.error("Data usage error:", error);
        return;
    }

    dataUsedKb = sumDailyUsage(data || []);
    renderDataUsed();
}

// ---------------------------------------------------------------
// HISTORY CHART
// X axis = real timestamps (Asia/Manila) on a linear millisecond scale.
// Only actual rows are plotted: no smoothing, and the line breaks wherever
// two rows are more than GAP_BREAK_MS apart.
// ---------------------------------------------------------------
let telemetrySpeedChartInstance = null;
let historyToken = 0;

let historyIsDefault = true;       // last 48 hours, rolling
let historyIsLive = true;          // range reaches "now": reload on new telemetry
let activeRange = null;            // the applied custom range, or null for the default 48 h

let axisStepMs = 6 * 60 * 60 * 1000;
let axisSpanMs = 48 * 60 * 60 * 1000;

const AXIS_STEPS_MS = [
    60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
    3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3,
    DAY_MS, 2 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS
];

function pickAxisStep(spanMs) {

    for (const step of AXIS_STEPS_MS) {
        if (spanMs / step <= 8) return step;
    }

    return AXIS_STEPS_MS[AXIS_STEPS_MS.length - 1];
}

function axisTickLabel(value) {

    if (axisStepMs >= DAY_MS) return formatMonitorShortDate(value);

    const time = formatMonitorTime(value);

    return axisSpanMs > DAY_MS ? [formatMonitorShortDate(value), time] : time;
}

// Ticks on whole hours / days of Manila time rather than at odd offsets
// from the start of the window.
function alignedTicks(scale) {

    const step = axisStepMs;
    const offset = MONITOR_UTC_OFFSET_MS;
    const ticks = [];

    for (let v = Math.ceil((scale.min + offset) / step) * step - offset; v <= scale.max; v += step) {
        ticks.push({ value: v });
    }

    scale.ticks = ticks;
}

function applyTelemetryAxis(minMs, maxMs) {

    const x = telemetrySpeedChartInstance.options.scales.x;

    axisSpanMs = maxMs - minMs;
    axisStepMs = pickAxisStep(axisSpanMs);

    x.min = minMs;
    x.max = maxMs;
}

function ensureTelemetryChart() {

    if (telemetrySpeedChartInstance) return telemetrySpeedChartInstance;

    const ctx = byId("telemetrySpeedChart");

    if (!ctx || typeof Chart === "undefined") return null;

    Chart.defaults.font.family = '"Inter", system-ui, sans-serif';

    const light = "#9db7c6";
    const gridColor = "rgba(255, 255, 255, 0.06)";

    telemetrySpeedChartInstance = new Chart(ctx, {

        type: "line",

        data: {
            datasets: [
                {
                    label: "Upload (Kbps)",
                    data: [],
                    yAxisID: "y",
                    borderColor: "#b57bff",
                    backgroundColor: "rgba(181, 123, 255, 0.15)",
                    pointBackgroundColor: "#b57bff",
                    fill: true,
                    borderWidth: 2,
                    tension: 0,
                    spanGaps: false,
                    pointRadius: 2,
                    pointHoverRadius: 5
                },
                {
                    label: "Ping (ms)",
                    data: [],
                    yAxisID: "y1",
                    borderColor: "#5fe3ff",
                    pointBackgroundColor: "#5fe3ff",
                    borderWidth: 2,
                    tension: 0,
                    spanGaps: false,
                    pointRadius: 2,
                    pointHoverRadius: 5
                }
            ]
        },

        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "index", axis: "x", intersect: false },
            plugins: {
                legend: { labels: { color: light, usePointStyle: true, boxWidth: 8 } },
                tooltip: {
                    filter: item => item.raw && item.raw.y !== null && item.raw.y !== undefined,
                    callbacks: {
                        title: items => items.length ? formatMonitorDateTime(items[0].raw.x, true) : "",
                        label: item => item.datasetIndex === 0
                            ? `Upload: ${item.raw.y.toFixed(2)} Kbps`
                            : `Ping: ${Math.round(item.raw.y)} ms`
                    }
                }
            },
            scales: {
                x: {
                    type: "linear",
                    min: 0,
                    max: 1,
                    grid: { display: false },
                    afterBuildTicks: alignedTicks,
                    ticks: { color: light, maxRotation: 0, autoSkip: false, callback: value => axisTickLabel(value) }
                },
                y: {
                    beginAtZero: true,
                    position: "left",
                    ticks: { color: "#c9a8ff" },
                    grid: { color: gridColor },
                    title: { display: true, text: "Upload (Kbps)", color: "#c9a8ff" }
                },
                y1: {
                    beginAtZero: true,
                    position: "right",
                    ticks: { color: "#5fe3ff" },
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: "Ping (ms)", color: "#5fe3ff" }
                }
            }
        }
    });

    return telemetrySpeedChartInstance;
}

// Loads every system_status row in [startMs, endMs), oldest first, paging
// past Supabase's per-request row cap.
async function fetchTelemetryBetween(startMs, endMs) {

    const rows = [];
    let truncated = false;

    for (let from = 0; ; from += HISTORY_PAGE) {

        if (from >= HISTORY_LIMIT) {
            truncated = true;
            break;
        }

        const { data, error } = await supabaseClient
            .from("system_status")
            .select("*")
            .gte("updated_at", new Date(startMs).toISOString())
            .lt("updated_at", new Date(endMs).toISOString())
            .order("updated_at", { ascending: true })
            .range(from, from + HISTORY_PAGE - 1);

        if (error) return { error };

        rows.push(...data);

        if (data.length < HISTORY_PAGE) break;
    }

    return { rows, truncated };
}

function buildTelemetrySeries(rows) {

    const upload = [];
    const ping = [];
    let previousMs = null;

    for (const row of rows) {

        const x = parseSupabaseTimestamp(row.updated_at).getTime();

        if (!Number.isFinite(x)) continue;

        // A null point in both series breaks the line across a real gap.
        if (previousMs !== null && x - previousMs > GAP_BREAK_MS) {
            const mid = previousMs + (x - previousMs) / 2;
            upload.push({ x: mid, y: null });
            ping.push({ x: mid, y: null });
        }

        upload.push({ x, y: hasValue(row.upload_kbps) ? Number(row.upload_kbps) : null });
        ping.push({ x, y: hasValue(row.ping_ms) ? Number(row.ping_ms) : null });
        previousMs = x;
    }

    return { upload, ping };
}

function setHistoryText(title, meta, emptyShown) {

    setNumber("tmChartTitle", title);
    setNumber("tmChartMeta", meta);

    const empty = byId("tmChartEmpty");

    if (empty) empty.hidden = !emptyShown;
}

async function loadTelemetryHistory(range) {

    const chart = ensureTelemetryChart();

    if (!chart) return;

    activeRange = range || null;

    // Default: rolling last 48 hours. Otherwise the chosen whole days.
    const nowMs = Date.now();
    const useDefault = !range;
    const startMs = useDefault ? nowMs - 48 * 60 * 60 * 1000 : range.startMs;
    const endMs = useDefault ? nowMs : range.endMs;

    historyIsDefault = useDefault;
    historyIsLive = useDefault || endMs > nowMs;

    // Download Image reads this so the image matches what is on screen.
    window.telemetryChartRange = useDefault ? null : { from: new Date(startMs), to: new Date(Math.min(endMs - 1, nowMs)) };

    const label = useDefault
        ? "Last 48 hours"
        : (formatMonitorDate(startMs) === formatMonitorDate(endMs - 1)
            ? formatMonitorDate(startMs)
            : `${formatMonitorDate(startMs)} – ${formatMonitorDate(endMs - 1)}`);

    const title = useDefault ? "Upload speed & ping (48 h)" : `Upload speed & ping · ${label}`;

    const token = ++historyToken;

    const result = await fetchTelemetryBetween(startMs, useDefault ? endMs + 1 : endMs);

    if (token !== historyToken) return;   // a newer request superseded this one

    if (result.error) {
        console.error("Telemetry history error:", result.error);
        setHistoryText(title, "Could not load telemetry history. Try again.", false);
        return;
    }

    const series = buildTelemetrySeries(result.rows);
    const count = result.rows.length;

    chart.data.datasets[0].data = series.upload;
    chart.data.datasets[1].data = series.ping;

    const radius = count <= 300 ? 3 : count <= 2000 ? 2 : 0;
    chart.data.datasets.forEach(d => { d.pointRadius = radius; });

    applyTelemetryAxis(startMs, endMs);
    chart.update("none");

    if (count === 0) {
        setHistoryText(title, `0 records · ${label}`, true);
        return;
    }

    const n = count.toLocaleString();

    setHistoryText(
        title,
        result.truncated
            ? `Showing the first ${n} records of this range. Choose a shorter range to see the rest.`
            : `${n} record${count === 1 ? "" : "s"} · ${label}`,
        false
    );
}

// "Apply": whole Manila calendar days, start day 00:00:00 up to (not
// including) the day after the end date, so both days are fully included.
function selectTelemetryRange() {

    const startInput = byId("telemetryCustomStart");
    const endInput = byId("telemetryCustomEnd");

    if (!startInput || !endInput || !startInput.value || !endInput.value) {
        alert("Please choose both a start and end date.");
        return;
    }

    const startMs = monitorDayStartMs(startInput.value);
    const endMs = monitorDayStartMs(endInput.value) + DAY_MS;

    if (startMs >= endMs) {
        alert("Start date must be on or before the end date.");
        return;
    }

    loadTelemetryHistory({ startMs, endMs });
}

function resetTelemetryRange() {

    const startInput = byId("telemetryCustomStart");
    const endInput = byId("telemetryCustomEnd");

    if (startInput) startInput.value = "";
    if (endInput) endInput.value = "";

    loadTelemetryHistory();
}

// ---------------------------------------------------------------
// START-UP
// ---------------------------------------------------------------
let telemetryStatusChannel = null;
let refreshTimer = null;

// A new status row refreshes everything, at most once every 2 seconds.
function onTelemetryEvent() {

    if (refreshTimer) return;

    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        loadSystemStatus();
        loadDataUsedToday();
        if (historyIsLive) loadTelemetryHistory(currentRange());
    }, 2000);
}

function currentRange() {
    return historyIsDefault ? undefined : activeRange;
}

async function init() {

    if (!(await requireRole("moderator"))) {
        return;
    }

    buildGauge();
    loadSystemStatus();
    loadDataUsedToday();
    loadTelemetryHistory();

    // Judge freshness on a timer so the page flips to OFFLINE by itself when the
    // station goes quiet; re-read the data in case a realtime event is missed.
    setInterval(renderTelemetry, CHECK_MS);
    setInterval(() => {
        loadSystemStatus();
        loadDataUsedToday();
        if (historyIsLive) loadTelemetryHistory(currentRange());
    }, REFRESH_MS);

    // "*" so it also fires if the station's RPC updates a row in place.
    telemetryStatusChannel = supabaseClient
        .channel("system-status-updates")
        .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "system_status" },
            onTelemetryEvent
        )
        .subscribe();
}

init();