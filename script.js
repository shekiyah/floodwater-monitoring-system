// supabaseClient, getFloodStatus, parseSupabaseTimestamp and the
// formatMonitor* / monitorDayStartMs helpers come from supabase-config.js.
// Nav (user info, role-based menu, dropdown, logout) lives in nav.js.
// This file handles the dashboard's own data: the unified dashboard
// container (info cards + gauge), the Water-Level History chart, stats,
// and sensor connection.
//
// TWO DISPLAY MODES
//   LIVE        the container shows the newest reading and follows realtime
//               inserts (default).
//   HISTORICAL  the user clicked a real data point on the chart; the gauge,
//               value, status and timestamp show that reading. Sensor
//               Connection, Last SMS Alert, Total/Highest/Lowest always stay
//               live / system-wide. Nothing is ever written to the database.

// A sensor counts as connected while its newest reading is no older
// than this. Set it to a few multiples of how often the device posts.
// The chart also draws a visible gap when two readings are further apart.
const SENSOR_STALE_MINUTES = 30;

// Must match the 7 m scale the threshold markers in dashboard.html
// and the band edges in style.css are positioned against.
const GAUGE_SCALE_MAX = 7;

const CHART_Y_MAX = 9;              // minimum top of the vertical range, meters (grows if a reading is higher)
const CHART_QUERY_LIMIT = 50000;    // safety cap on rows loaded for one range
const CHART_PAGE_SIZE = 1000;       // Supabase returns at most this many rows per request
const CHART_ZOOM_WINDOW_RADIUS = 20;
const CHART_GAP_BREAK_MS = SENSOR_STALE_MINUTES * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_COLORS = {
    NORMAL: "#2E9E4F",
    ALERT: "#E8B93A",
    CRITICAL: "#E2711D",
    DANGER: "#D93A3A",
    UNKNOWN: "#8aa5b5"
};

const CHART_THRESHOLDS = [
    { value: 2, label: "ALERT 2.00", color: STATUS_COLORS.ALERT },
    { value: 4, label: "CRITICAL 4.00", color: STATUS_COLORS.CRITICAL },
    { value: 6.4, label: "DANGER 6.40", color: STATUS_COLORS.DANGER }
];

const byId = id => document.getElementById(id);

function setText(id, value) {
    const node = byId(id);
    if (node) node.textContent = value;
}

// ---------------------------------------------------------------
// READINGS
// A "reading" is { id, ts (ms since epoch), level (m) }.
// ---------------------------------------------------------------
function toReading(row) {

    if (!row || row.water_level === null || row.water_level === undefined || row.water_level === "") {
        return null;
    }

    const level = Number(row.water_level);
    const ts = parseSupabaseTimestamp(row.created_at).getTime();

    if (!Number.isFinite(level) || !Number.isFinite(ts)) {
        return null;
    }

    return { id: row.id ?? null, ts, level };
}

let liveReading = null;        // newest reading in the database
let selectedReading = null;    // reading picked on the chart (historical mode) or null

// ---------------------------------------------------------------
// UNIFIED DASHBOARD
// ---------------------------------------------------------------
function updateWaterDisplay(level) {

    const status = getFloodStatus(level);
    const key = status.toLowerCase();

    setText("waterLevel", level.toFixed(2) + " m");

    ["status", "gaugeStatus"].forEach(id => {
        const node = byId(id);
        if (node) {
            node.textContent = status;
            node.className = "status-badge " + key;
        }
    });

    const fillElement = byId("waterFill");

    if (fillElement) {
        const fillPercent = Math.max(0, Math.min((level / GAUGE_SCALE_MAX) * 100, 100));
        fillElement.style.height = fillPercent + "%";
        fillElement.className = "fill " + key;
    }

    const root = byId("unifiedDashboard");

    if (root) {
        root.dataset.status = key;
    }
}

// The warning banner always reflects the LIVE reading, even while a
// historical point is shown in the container.
function updateAlertBox(level) {

    const alertBox = byId("alertBox");

    if (!alertBox) return;

    const status = getFloodStatus(level);

    const alertClass = {
        ALERT: "alert-warning",
        CRITICAL: "alert-critical",
        DANGER: "alert-danger"
    }[status];

    if (alertClass) {
        alertBox.className = "alert-box " + alertClass;
        alertBox.textContent = "⚠️ Flood warning: " + status;
    } else {
        alertBox.className = "alert-box";
        alertBox.textContent = "";
    }
}

function renderDashboard() {

    const shown = selectedReading || liveReading;
    const historical = Boolean(selectedReading);

    const root = byId("unifiedDashboard");

    if (root) {
        root.classList.toggle("is-historical", historical);
    }

    const badge = byId("modeBadge");

    if (badge) {
        badge.textContent = historical ? "SELECTED HISTORICAL READING" : "LATEST LIVE READING";
    }

    setText("statusTitle", historical ? "Selected Status" : "Current Status");
    setText("dateTitle", historical ? "Selected Reading" : "Last Reading");

    const returnBtn = byId("returnLatestBtn");

    if (returnBtn) {
        returnBtn.disabled = !historical;
    }

    if (!shown) return;

    updateWaterDisplay(shown.level);

    const dateText = formatMonitorDate(shown.ts);
    const timeText = formatMonitorTime(shown.ts, true);

    const dateNode = byId("date");

    if (dateNode) {
        dateNode.innerHTML =
            `<span class="u-date-main">${timeText}</span><span class="u-date-sub">${dateText}</span>`;
    }

    setText("gaugeDate", dateText);
    setText("gaugeTime", timeText);
}

function setLiveReading(reading, createdAt) {

    liveReading = reading;

    updateAlertBox(reading.level);
    noteReadingTime(createdAt);
    renderDashboard();
}

// Called when a real data point on the chart is clicked.
function selectReading(reading) {

    selectedReading = { id: reading.id, ts: reading.ts, level: reading.level };

    renderDashboard();

    if (waterChartInstance) {
        waterChartInstance.update("none");
    }
}

// "RETURN TO LATEST READING" button.
function returnToLatestReading() {

    selectedReading = null;

    renderDashboard();

    if (waterChartInstance) {
        waterChartInstance.update("none");
    }
}

// SENSOR CONNECTION
// Derived from how recent the newest reading is, so the card can't
// claim "Connected" when the device has gone quiet. Always live.

let lastReadingMs = null;

function noteReadingTime(createdAt) {

    lastReadingMs = parseSupabaseTimestamp(createdAt).getTime();

    renderSensorConnection();
}

function renderSensorConnection() {

    const element = byId("sensorConnection");

    if (!element || lastReadingMs === null) {
        return;
    }

    const isFresh = (Date.now() - lastReadingMs) <= SENSOR_STALE_MINUTES * 60 * 1000;

    element.className = isFresh ? "connected" : "disconnected";

    // Lets the CSS tint the Sensor Connection card green or red.
    const sensorTile = element.closest(".u-tile");

    if (sensorTile) {
        sensorTile.dataset.state = isFresh ? "ok" : "bad";
    }

    element.innerHTML = isFresh
        ? '<span class="live-dot" aria-hidden="true"></span> Connected'
        : '<span class="live-dot live-dot--off" aria-hidden="true"></span> No recent data';
}

setInterval(renderSensorConnection, 60 * 1000);

async function getWaterReading() {

    const { data, error } = await supabaseClient
        .from("water_readings")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1);

    if (error) {
        console.error("Latest reading error:", error);
        return;
    }

    const latestRow = data[0];

    if (!latestRow) {
        const sensor = byId("sensorConnection");
        if (sensor) sensor.textContent = "Waiting for first reading";
        return;
    }

    const reading = toReading(latestRow);

    if (reading) {
        setLiveReading(reading, latestRow.created_at);
    }
}

// ---------------------------------------------------------------
// WATER-LEVEL HISTORY CHART
// X axis = time of day (Asia/Manila) on a linear millisecond scale, so a
// selected day always spans 12:00 AM to 12:00 AM and real gaps stay gaps.
// Only actual readings are plotted: no smoothing, no interpolation, and
// the line is broken wherever two readings are further apart than
// CHART_GAP_BREAK_MS.
// ---------------------------------------------------------------
let waterChartInstance = null;

let chartReadings = [];          // loaded readings, chronological
let chartPoints = [];       // chart data: readings plus null "gap" markers
let readingPointIndex = []; // chartReadings[i] -> index inside chartPoints
let pointBaseRadius = 3;
let chartLoadToken = 0;

// Current range state.
let chartPeriodIsLive = true;      // true = range includes "now" and keeps growing
let chartRangeStartMs = 0;
let chartRangeEndMs = 0;

// Zoom slider state (index into `readings`).
let zoomedPointIndex = -1;
let isZoomedView = false;

// Axis formatting state read by the tick callback.
let axisStepMs = 3 * 60 * 60 * 1000;
let axisSpanMs = DAY_MS;

// Default range: today in Manila, 12:00 AM to 12:00 AM (next day).
function getTodayRange() {

    const start = new Date(monitorDayStartMs(monitorTodayString()));
    const end = new Date(start.getTime() + DAY_MS);

    return { start, end, isLive: true };
}

function initChartDateInputs() {

    const today = monitorTodayString();
    const startInput = byId("chartCustomStart");
    const endInput = byId("chartCustomEnd");

    if (startInput && !startInput.value) startInput.value = today;
    if (endInput && !endInput.value) endInput.value = today;
}

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

function applyAxis(minMs, maxMs) {

    const x = waterChartInstance.options.scales.x;

    axisSpanMs = maxMs - minMs;
    axisStepMs = pickAxisStep(axisSpanMs);

    x.min = minMs;
    x.max = maxMs;
    x.ticks.stepSize = axisStepMs;
}

function axisTickLabel(value) {

    if (axisStepMs >= DAY_MS) {
        return formatMonitorShortDate(value);
    }

    const time = formatMonitorTime(value, axisStepMs < 60e3);

    return axisSpanMs > DAY_MS ? [formatMonitorShortDate(value), time] : time;
}

function buildPoints(list) {

    const points = [];
    const index = [];
    let previous = null;

    for (const reading of list) {

        // A null point breaks the line across a real data gap.
        if (previous && reading.ts - previous.ts > CHART_GAP_BREAK_MS) {
            points.push({ x: previous.ts + (reading.ts - previous.ts) / 2, y: null });
        }

        points.push({ x: reading.ts, y: reading.level, r: reading });
        index.push(points.length - 1);
        previous = reading;
    }

    return { points, index };
}

function chartYMax(list) {

    let highest = 0;

    for (const reading of list) {
        if (reading.level > highest) highest = reading.level;
    }

    return Math.max(CHART_Y_MAX, Math.ceil(highest + 0.2));
}

function baseRadiusFor(count) {
    return count <= 300 ? 3 : count <= 2000 ? 2 : 1;
}

// Dashed guide lines at the exact status thresholds.
const thresholdLinesPlugin = {
    id: "thresholdLines",
    beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.y) return;

        ctx.save();
        ctx.font = "600 10px 'IBM Plex Mono', monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";

        CHART_THRESHOLDS.forEach(t => {
            const y = scales.y.getPixelForValue(t.value);
            if (y < chartArea.top || y > chartArea.bottom) return;

            ctx.strokeStyle = t.color;
            ctx.globalAlpha = 0.45;
            ctx.setLineDash([5, 5]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(chartArea.left, y);
            ctx.lineTo(chartArea.right, y);
            ctx.stroke();

            ctx.globalAlpha = 0.9;
            ctx.setLineDash([]);
            ctx.fillStyle = t.color;
            ctx.fillText(t.label, chartArea.right - 4, y - 2);
        });

        ctx.restore();
    }
};

// Ring + filled dot drawn on top of everything for the selected reading.
const selectedMarkerPlugin = {
    id: "selectedMarker",
    afterDatasetsDraw(chart) {
        if (!selectedReading) return;

        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.x || !scales.y) return;

        const px = scales.x.getPixelForValue(selectedReading.ts);
        const py = scales.y.getPixelForValue(selectedReading.level);

        if (px < chartArea.left || px > chartArea.right || py < chartArea.top || py > chartArea.bottom) return;

        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = STATUS_COLORS[getFloodStatus(selectedReading.level)];
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.restore();
    }
};

function ensureChart() {

    if (waterChartInstance) return waterChartInstance;

    const ctx = byId("waterChart");

    if (!ctx || typeof Chart === "undefined") return null;

    const tickColor = "#9db7c6";
    const gridColor = "rgba(140, 190, 215, 0.12)";

    waterChartInstance = new Chart(ctx, {

        type: "line",

        data: {
            datasets: [{
                label: "Water level (m)",
                data: [],
                borderColor: "#4cc3e8",
                backgroundColor: "rgba(76, 195, 232, 0.12)",
                fill: true,
                borderWidth: 2,
                tension: 0,
                spanGaps: false,
                pointRadius: () => pointBaseRadius,
                pointHoverRadius: () => pointBaseRadius + 3,
                pointHitRadius: 10,
                pointBorderWidth: 0,
                pointBackgroundColor: c => (c.raw && c.raw.y !== null && c.raw.y !== undefined)
                    ? STATUS_COLORS[getFloodStatus(c.raw.y)]
                    : "transparent"
            }]
        },

        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "nearest", intersect: true },

            // Only a click that lands on an actual recorded point selects it.
            onClick(evt, _active, chart) {
                const hits = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
                if (!hits.length) return;
                const point = chart.data.datasets[0].data[hits[0].index];
                if (point && point.r) selectReading(point.r);
            },

            onHover(evt, active, chart) {
                chart.canvas.style.cursor = active.length ? "pointer" : "default";
            },

            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => items.length ? formatMonitorDateTime(items[0].raw.x, true) : "",
                        label: item => `${item.raw.y.toFixed(2)} m — ${getFloodStatus(item.raw.y)}`,
                        footer: () => "Click to show on dashboard"
                    }
                }
            },

            scales: {
                x: {
                    type: "linear",
                    min: 0,
                    max: 1,
                    grid: { color: gridColor },
                    ticks: {
                        color: tickColor,
                        maxRotation: 0,
                        autoSkip: true,
                        includeBounds: true,
                        stepSize: axisStepMs,
                        callback: value => axisTickLabel(value)
                    },
                    title: { display: true, text: "Time of day (Asia/Manila)", color: tickColor }
                },
                y: {
                    min: 0,
                    max: CHART_Y_MAX,
                    grid: { color: gridColor },
                    ticks: { color: tickColor },
                    title: { display: true, text: "Water level (m)", color: tickColor }
                }
            }
        },

        plugins: [thresholdLinesPlugin, selectedMarkerPlugin]
    });

    return waterChartInstance;
}

function setChartMeta(text) { setText("chartMeta", text); }

function rangeLabel() {

    const first = formatMonitorDate(chartRangeStartMs);
    const last = formatMonitorDate(chartRangeEndMs - 1);

    return first === last ? first : `${first} – ${last}`;
}

function updateChartStatusText(truncated) {

    const empty = byId("chartEmpty");

    if (chartReadings.length === 0) {
        if (empty) {
            empty.textContent = `No readings recorded for ${rangeLabel()}.`;
            empty.hidden = false;
        }
        setChartMeta(`0 readings · ${rangeLabel()}`);
        return;
    }

    if (empty) empty.hidden = true;

    const n = chartReadings.length.toLocaleString();
    let text = `${n} reading${chartReadings.length === 1 ? "" : "s"} · ${rangeLabel()} · click a data point to show it on the dashboard`;

    if (truncated) {
        text = `Showing the first ${n} readings of this range. Choose a shorter range to see the rest.`;
    }

    setChartMeta(text);
}

// Loads every reading in [range.start, range.end), oldest first, paging
// past Supabase's per-request row cap.
async function fetchReadingsBetween(startMs, endMs) {

    const rows = [];
    let truncated = false;

    for (let from = 0; ; from += CHART_PAGE_SIZE) {

        if (from >= CHART_QUERY_LIMIT) {
            truncated = true;
            break;
        }

        const { data, error } = await supabaseClient
            .from("water_readings")
            .select("*")
            .gte("created_at", new Date(startMs).toISOString())
            .lt("created_at", new Date(endMs).toISOString())
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, from + CHART_PAGE_SIZE - 1);

        if (error) {
            return { error };
        }

        rows.push(...data);

        if (data.length < CHART_PAGE_SIZE) break;
    }

    return { rows, truncated };
}

// "Apply" button. The date inputs are Manila calendar dates; the range is
// the whole of each day (00:00:00 up to, not including, the next midnight),
// so both the start and end days are fully included.
function selectCustomChartRange() {

    const startInput = byId("chartCustomStart");
    const endInput = byId("chartCustomEnd");

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

    loadWaterChart({
        start: new Date(startMs),
        end: new Date(endMs),
        isLive: endMs > Date.now()
    });
}

async function loadWaterChart(range) {

    range = range || getTodayRange();

    const chart = ensureChart();

    if (!chart) return;

    const token = ++chartLoadToken;

    chartRangeStartMs = range.start.getTime();
    chartRangeEndMs = range.end.getTime();
    chartPeriodIsLive = range.isLive;

    setChartMeta("Loading readings…");

    const result = await fetchReadingsBetween(chartRangeStartMs, chartRangeEndMs);

    if (token !== chartLoadToken) return;   // a newer Apply superseded this one

    if (result.error) {
        console.error("Chart Error:", result.error);
        setChartMeta("Could not load readings. Press Apply to try again.");
        return;
    }

    chartReadings = result.rows.map(toReading).filter(Boolean);

    const built = buildPoints(chartReadings);
    chartPoints = built.points;
    readingPointIndex = built.index;

    isZoomedView = false;
    zoomedPointIndex = -1;
    pointBaseRadius = baseRadiusFor(chartReadings.length);

    chart.data.datasets[0].data = chartPoints;
    chart.options.scales.y.max = chartYMax(chartReadings);
    applyAxis(chartRangeStartMs, chartRangeEndMs);
    chart.update("none");

    updateChartStatusText(result.truncated);
    updateZoomSliderUI();
}

// Adds a freshly inserted reading to the chart if it belongs to the
// range currently shown.
function appendReadingToChart(reading) {

    if (!waterChartInstance) return;

    const inRange = reading.ts >= chartRangeStartMs &&
        (chartPeriodIsLive || reading.ts < chartRangeEndMs);

    if (!inRange) return;

    const last = chartReadings[chartReadings.length - 1];

    if (last && last.id === reading.id && last.ts === reading.ts) return;

    if (last && reading.ts - last.ts > CHART_GAP_BREAK_MS) {
        chartPoints.push({ x: last.ts + (reading.ts - last.ts) / 2, y: null });
    }

    chartReadings.push(reading);
    chartPoints.push({ x: reading.ts, y: reading.level, r: reading });
    readingPointIndex.push(chartPoints.length - 1);

    pointBaseRadius = baseRadiusFor(chartReadings.length);

    const needed = chartYMax([reading]);

    if (needed > waterChartInstance.options.scales.y.max) {
        waterChartInstance.options.scales.y.max = needed;
    }

    waterChartInstance.update("none");

    updateChartStatusText(false);
    updateZoomSliderUI();
}

// ---------------------------------------------------------------
// ZOOM SLIDER (unchanged behaviour: slide to a reading to spread its
// neighbours out; "Show Full Range" backs out). It only zooms and
// highlights a tooltip; it does not change the dashboard. Clicking the
// point does.
// ---------------------------------------------------------------
function renderZoomWindow(index) {

    if (!waterChartInstance || chartReadings.length === 0) return;

    zoomedPointIndex = Math.max(0, Math.min(index, chartReadings.length - 1));

    const first = Math.max(0, zoomedPointIndex - CHART_ZOOM_WINDOW_RADIUS);
    const last = Math.min(chartReadings.length - 1, zoomedPointIndex + CHART_ZOOM_WINDOW_RADIUS);

    let minMs = chartReadings[first].ts;
    let maxMs = chartReadings[last].ts;
    const pad = Math.max((maxMs - minMs) * 0.05, 30e3);

    applyAxis(minMs - pad, maxMs + pad);
    waterChartInstance.update("none");

    const pointIndex = readingPointIndex[zoomedPointIndex];
    const element = waterChartInstance.getDatasetMeta(0).data[pointIndex];

    if (element) {
        const active = [{ datasetIndex: 0, index: pointIndex }];
        waterChartInstance.setActiveElements(active);
        waterChartInstance.tooltip.setActiveElements(active, { x: element.x, y: element.y });
        waterChartInstance.update("none");
    }

    updateZoomSliderUI();
}

function onChartZoomSlide(value) {

    if (chartReadings.length === 0) return;

    isZoomedView = true;
    renderZoomWindow(Number(value));
}

function resetChartZoom() {

    if (!waterChartInstance) return;

    isZoomedView = false;

    applyAxis(chartRangeStartMs, chartRangeEndMs);
    waterChartInstance.setActiveElements([]);
    waterChartInstance.tooltip.setActiveElements([], { x: 0, y: 0 });
    waterChartInstance.update("none");

    updateZoomSliderUI();
}

function updateZoomSliderUI() {

    const slider = byId("chartZoomSlider");
    const label = byId("chartZoomLabel");
    const resetBtn = byId("chartZoomReset");

    if (!slider || !label) return;

    const maxIndex = Math.max(0, chartReadings.length - 1);
    slider.max = String(maxIndex);

    if (chartReadings.length === 0) {
        slider.value = "0";
        slider.disabled = true;
        label.textContent = "No data";
        if (resetBtn) resetBtn.disabled = true;
        return;
    }

    slider.disabled = false;

    if (isZoomedView) {
        const r = chartReadings[zoomedPointIndex];
        slider.value = String(zoomedPointIndex);
        label.textContent =
            `${formatMonitorDateTime(r.ts, true)} — ${r.level.toFixed(2)} m ` +
            `(${zoomedPointIndex + 1} of ${chartReadings.length})`;
        if (resetBtn) resetBtn.disabled = false;
    } else {
        slider.value = String(maxIndex);
        label.textContent = `Showing full range (${chartReadings.length} readings)`;
        if (resetBtn) resetBtn.disabled = true;
    }
}

// ---------------------------------------------------------------
// SYSTEM-WIDE STATISTICS (never affected by a historical selection)
// ---------------------------------------------------------------
async function loadStatistics() {

    // Total readings — count only, doesn't download any rows.
    const { count, error: countError } = await supabaseClient
        .from("water_readings")
        .select("*", { count: "exact", head: true });

    if (countError) {
        console.log(countError);
        return;
    }

    setText("totalReadings", (count || 0).toLocaleString());

    if (!count) {
        console.log("No statistics available");
        return;
    }

    // Highest — sort descending, take 1 row instead of the whole table.
    const { data: highestRow, error: highestError } = await supabaseClient
        .from("water_readings")
        .select("water_level")
        .order("water_level", { ascending: false })
        .limit(1)
        .single();

    if (highestError) {
        console.log(highestError);
    } else {
        setText("highestLevel", Number(highestRow.water_level).toFixed(2) + " m");
    }

    // Lowest — same idea, ascending.
    const { data: lowestRow, error: lowestError } = await supabaseClient
        .from("water_readings")
        .select("water_level")
        .order("water_level", { ascending: true })
        .limit(1)
        .single();

    if (lowestError) {
        console.log(lowestError);
    } else {
        setText("lowestLevel", Number(lowestRow.water_level).toFixed(2) + " m");
    }
}

// ---------------------------------------------------------------
// LAST SMS ALERT
// UNVERIFIED: reads the newest row of public.sms_queue. The column names
// below (water_level / level / reading, sent_at / created_at) are a best
// guess because sms_queue's schema wasn't provided. If your live page
// already has its own Last SMS Alert code, keep that and delete this
// block and the Last SMS tile's ids. Does nothing if #smsLevel is absent.
// ---------------------------------------------------------------
function firstNumber(...values) {

    for (const v of values) {
        if (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))) {
            return Number(v);
        }
    }

    return null;
}

function renderSms(levelText, status, timeText) {

    setText("smsLevel", levelText);
    setText("smsTime", timeText);

    const badge = byId("smsStatus");

    if (badge) {
        badge.hidden = !status;
        badge.textContent = status || "";
        badge.className = "status-badge " + (status ? status.toLowerCase() : "unknown");
    }
}

async function loadLastSms() {

    if (!byId("smsLevel")) return;

    const { data, error } = await supabaseClient
        .from("sms_queue")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1);

    if (error) {
        console.warn("Last SMS alert not available:", error.message);
        renderSms("—", "", "");
        return;
    }

    if (!data || !data.length) {
        renderSms("No alerts yet", "", "");
        return;
    }

    const row = data[0];
    const level = firstNumber(row.water_level, row.level, row.reading);
    const when = row.sent_at || row.created_at;

    renderSms(
        level === null ? "Alert sent" : level.toFixed(2) + " m",
        level === null ? "" : getFloodStatus(level),
        when ? formatMonitorDateTime(parseSupabaseTimestamp(when).getTime(), true) : ""
    );
}

// Statistics need several queries. A busy device could trigger them on
// every insert, so refresh at most once every 15 seconds.
let statisticsTimer = null;

function scheduleStatisticsRefresh() {

    if (statisticsTimer) return;

    statisticsTimer = setTimeout(() => {
        statisticsTimer = null;
        loadStatistics();
        loadLastSms();
    }, 15000);
}

// ---------------------------------------------------------------
// START-UP
// ---------------------------------------------------------------
initChartDateInputs();
renderDashboard();
getWaterReading();
loadWaterChart();
loadStatistics();
loadLastSms();

// REALTIME WATER LEVEL UPDATE

supabaseClient
    .channel("water-updates")
    .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "water_readings" },
        payload => {

            const reading = toReading(payload.new);

            if (reading) {
                // While a historical point is selected the container keeps
                // showing it; only the live record, banner and connection
                // status move.
                setLiveReading(reading, payload.new.created_at);
                appendReadingToChart(reading);
            }

            // Flood alerts (SMS/email) are handled server-side by a
            // Postgres trigger on water_readings inserts — see
            // rls-and-alert-trigger.sql. Nothing here sends or changes them.

            scheduleStatisticsRefresh();
        }
    )
    .subscribe();