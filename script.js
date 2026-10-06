// supabaseClient, getFloodStatus and parseSupabaseTimestamp come from
// supabase-config.js. Nav (user info, role-based menu, dropdown, logout)
// lives in nav.js. This file only handles the dashboard's own data: the
// gauge, chart, stats, and sensor connection.

// A sensor counts as connected while its newest reading is no older
// than this. Set it to a few multiples of how often the device posts.
const SENSOR_STALE_MINUTES = 30;

// Must match the 6.5 m scale the threshold markers in dashboard.html
// and the band edges in style.css are positioned against.
const GAUGE_SCALE_MAX = 6.5;

function updateWaterDisplay(level){

    const status = getFloodStatus(level);

    document.getElementById("waterLevel").textContent = level.toFixed(2) + " m";

    const statusElement = document.getElementById("status");

    statusElement.textContent = status;
    statusElement.className = "status-badge " + status.toLowerCase();

    const fillElement = document.getElementById("waterFill");

    const fillPercent = Math.max(0, Math.min((level / GAUGE_SCALE_MAX) * 100, 100));

    fillElement.style.height = fillPercent + "%";
    fillElement.className = "fill " + status.toLowerCase();

    const alertBox = document.getElementById("alertBox");

    const alertClass = {
        ALERT: "alert-warning",
        CRITICAL: "alert-critical",
        DANGER: "alert-danger"
    }[status];

    if(alertClass){

        alertBox.className = "alert-box " + alertClass;
        alertBox.textContent = "⚠️ Flood warning: " + status;

    }
    else{

        alertBox.className = "alert-box";
        alertBox.textContent = "";

    }

}

// SENSOR CONNECTION
// Derived from how recent the newest reading is, so the card can't
// claim "Connected" when the device has gone quiet.

let lastReadingMs = null;

function noteReadingTime(createdAt){

    lastReadingMs = parseSupabaseTimestamp(createdAt).getTime();

    renderSensorConnection();

}

function renderSensorConnection(){

    const element = document.getElementById("sensorConnection");

    if(!element || lastReadingMs === null){
        return;
    }

    const isFresh = (Date.now() - lastReadingMs) <= SENSOR_STALE_MINUTES * 60 * 1000;

    element.className = isFresh ? "connected" : "disconnected";

    element.innerHTML = isFresh
        ? '<span class="live-dot" aria-hidden="true"></span> Connected'
        : '<span class="live-dot live-dot--off" aria-hidden="true"></span> No recent data';

}

setInterval(renderSensorConnection, 60 * 1000);

async function getWaterReading(){

    const { data, error } = await supabaseClient
    .from("water_readings")
    .select("*")
    .order("created_at", { ascending:false })
    .limit(1);

    if(error){

        console.error("Latest reading error:", error);
        return;

    }

    const latest = data[0];

    if(!latest){

        document.getElementById("sensorConnection").textContent = "Waiting for first reading";

        return;

    }

    updateWaterDisplay(Number(latest.water_level));

    noteReadingTime(latest.created_at);

}

getWaterReading();

// The chart displays the full dataset for whichever period is
// currently loaded, or — while the zoom slider below it is being
// used — a windowed view around one specific reading. It defaults
// to today's data; admin/moderator users (gated in nav.js) also
// get a custom date-range picker to load a different range on
// demand.

let waterChartInstance = null;

// Full underlying dataset for whichever period is currently loaded.
// `fullLabels`/`fullLevels` stay parallel to each other;
// `fullTimestamps` is the raw time for each point.
let fullLabels = [];
let fullLevels = [];
let fullTimestamps = [];

// Caps how many points we keep in memory for a live (still-growing)
// period, so a page left open for a long time doesn't grow
// unboundedly.
const CHART_MAX_LIVE_POINTS = 5000;

// Caps how many rows a single period query pulls back. We always
// fetch the most recent CHART_QUERY_LIMIT rows within the period
// (descending, then reversed to chronological order), so a period
// with more data than the cap still shows its most recent portion
// rather than silently getting cut off at the oldest end.
const CHART_QUERY_LIMIT = 5000;

const CHART_Y_MAX = 8; // top of the vertical range, meters

// Current range state.
let chartPeriodIsLive = true;      // true = range includes "now" and keeps growing
let chartRangeStartMs = 0;
let chartRangeEndMs = 0;           // only meaningful for non-live (completed) ranges

// Index into fullLabels/fullLevels of the reading currently selected
// via the zoom slider under the chart, and whether the chart is
// currently showing a zoomed-in window around that reading (rather
// than the full period). -1 / false = no selection, full range shown.
let zoomedPointIndex = -1;
let isZoomedView = false;

// How many readings are shown on each side of the selected point
// when zoomed in — wide enough to make individual readings (and
// their line-chart points) easy to read instead of blurring
// together like they do across a whole day/week/month.
const CHART_ZOOM_WINDOW_RADIUS = 20;

// Default range shown on load: today, start of day up to right now,
// still growing as new readings arrive. (Custom ranges bypass this —
// see selectCustomChartRange — this is only used for the initial
// "today" view.)
function getTodayRange(){

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    return { start, end: now, isLive:true };

}

// Pushes the current view onto the already-rendered chart: the full
// dataset normally, or — while the zoom slider is active — just the
// window of readings around the selected point.
function applyChartData(){

    if(!waterChartInstance){
        return;
    }

    if (isZoomedView && fullLabels.length > 0) {
        renderZoomWindow(zoomedPointIndex);
        return;
    }

    waterChartInstance.data.labels = fullLabels;
    waterChartInstance.data.datasets[0].data = fullLevels;

    waterChartInstance.update();

    updateZoomSliderUI();

}

// Renders just a window of CHART_ZOOM_WINDOW_RADIUS readings on
// either side of `index`, and highlights that exact reading via
// Chart.js's tooltip API — this is the "zoom in" effect the slider
// drives: sliding to a moment in time spreads its nearby readings
// out so each one is individually visible.
function renderZoomWindow(index) {

    if (!waterChartInstance || fullLabels.length === 0) {
        return;
    }

    zoomedPointIndex = Math.max(0, Math.min(index, fullLabels.length - 1));

    const start = Math.max(0, zoomedPointIndex - CHART_ZOOM_WINDOW_RADIUS);
    const end = Math.min(fullLabels.length, zoomedPointIndex + CHART_ZOOM_WINDOW_RADIUS + 1);

    waterChartInstance.data.labels = fullLabels.slice(start, end);
    waterChartInstance.data.datasets[0].data = fullLevels.slice(start, end);

    waterChartInstance.update();

    const indexInWindow = zoomedPointIndex - start;

    waterChartInstance.setActiveElements([
        { datasetIndex: 0, index: indexInWindow }
    ]);

    waterChartInstance.tooltip.setActiveElements(
        [{ datasetIndex: 0, index: indexInWindow }],
        { x: 0, y: 0 }
    );

    waterChartInstance.update();

    updateZoomSliderUI();

}

// Called on every "input" event as the user drags the slider.
function onChartZoomSlide(value) {

    if (fullLabels.length === 0) {
        return;
    }

    isZoomedView = true;
    renderZoomWindow(Number(value));

}

// Called by the "Show Full Range" button to back out of the zoomed
// window and see the whole loaded period again.
function resetChartZoom() {

    isZoomedView = false;

    waterChartInstance.data.labels = fullLabels;
    waterChartInstance.data.datasets[0].data = fullLevels;
    waterChartInstance.update();

    updateZoomSliderUI();

}

// Keeps the slider's range/handle position and the label under it
// ("<time> — <level> m" while zoomed, "Showing full range"
// otherwise) in sync with the current state.
function updateZoomSliderUI() {

    const slider = document.getElementById("chartZoomSlider");
    const label = document.getElementById("chartZoomLabel");
    const resetBtn = document.getElementById("chartZoomReset");

    if (!slider || !label) {
        return;
    }

    const maxIndex = Math.max(0, fullLabels.length - 1);
    slider.max = String(maxIndex);

    if (fullLabels.length === 0) {
        slider.value = "0";
        slider.disabled = true;
        label.textContent = "No data";
        if (resetBtn) resetBtn.disabled = true;
        return;
    }

    slider.disabled = false;

    if (isZoomedView) {
        slider.value = String(zoomedPointIndex);
        label.textContent =
            `${fullLabels[zoomedPointIndex]} — ${fullLevels[zoomedPointIndex]} m ` +
            `(${zoomedPointIndex + 1} of ${fullLabels.length})`;
        if (resetBtn) resetBtn.disabled = false;
    } else {
        slider.value = String(maxIndex);
        label.textContent = `Showing full range (${fullLabels.length} readings)`;
        if (resetBtn) resetBtn.disabled = true;
    }

}

// Called by the "Apply" button next to the custom date-range
// inputs. Reads two plain <input type="date"> values, treats them
// as local calendar dates (not UTC — a date input's value has no
// time zone of its own), and loads that range end-to-end inclusive
// of the chosen end date. If the end date is today or in the
// future, the range is treated as live and keeps growing with new
// readings; otherwise it's a fixed, completed range.
function selectCustomChartRange(){

    const startInput = document.getElementById("chartCustomStart");
    const endInput = document.getElementById("chartCustomEnd");

    if(!startInput || !endInput || !startInput.value || !endInput.value){
        alert("Please choose both a start and end date.");
        return;
    }

    const [startYear, startMonth, startDay] = startInput.value.split("-").map(Number);
    const [endYear, endMonth, endDay] = endInput.value.split("-").map(Number);

    const start = new Date(startYear, startMonth - 1, startDay);

    // Upper bound is exclusive — the day AFTER the chosen end date —
    // so the selected end date's readings are fully included.
    const end = new Date(endYear, endMonth - 1, endDay + 1);

    if(start >= end){
        alert("Start date must be before the end date.");
        return;
    }

    loadWaterChart({ start, end, isLive: end.getTime() > Date.now() });

}

async function loadWaterChart(range){

range = range || getTodayRange();

chartRangeStartMs = range.start.getTime();
chartRangeEndMs = range.end.getTime();
chartPeriodIsLive = range.isLive;

// Fetch the most recent CHART_QUERY_LIMIT readings within the
// period (descending, then reversed to chronological order) so a
// period with more data than the cap still shows its most recent
// portion instead of getting cut off at the oldest end.

let query = supabaseClient
    .from("water_readings")
    .select("*")
    .gte("created_at", range.start.toISOString())
    .order("created_at", { ascending:false })
    .limit(CHART_QUERY_LIMIT);

if(!range.isLive){
    query = query.lt("created_at", range.end.toISOString());
}

const { data, error } = await query;

if(error){

console.log("Chart Error:", error);
return;

}

const chronological = data.slice().reverse();


// Full dataset for the currently loaded period.

fullLabels = chronological.map(item => parseSupabaseTimestamp(item.created_at).toLocaleString());

fullLevels = chronological.map(item => item.water_level);

fullTimestamps = chronological.map(item => parseSupabaseTimestamp(item.created_at).getTime());


// Create the chart the first time; on later period switches, just
// reuse the existing instance.

if(!waterChartInstance){

    const ctx = document.getElementById("waterChart");

    waterChartInstance = new Chart(ctx, {

        type:"line",

        data:{

            labels: [],

            datasets:[{

                label:"Water level (m)",

                data: [],

                borderColor:"#4cc3e8",

                backgroundColor:"rgba(76, 195, 232, 0.14)",

                fill:true,

                borderWidth:2.5,

                tension:0.25,

                pointRadius:0,

                pointHoverRadius:5,

                pointHitRadius:12

            }]

        },

        options:{

            responsive:true,

            maintainAspectRatio:false,

            interaction:{ mode:"index", intersect:false },

            plugins:{ legend:{ display:false } },

            scales:{

                x:{

                    grid:{ display:false },

                    ticks:{

                        maxTicksLimit:6,

                        maxRotation:0,

                        autoSkip:true,

                        // Two-line labels (date over time) so they fit on a phone.
                        callback:function(value){
                            return String(this.getLabelForValue(value)).split(", ");
                        }

                    }

                },

                y:{

                    min: 0,

                    max: CHART_Y_MAX,

                    title:{

                        display:true,

                        text:"Meters"

                    }

                }

            }

        }

    });

}


// A freshly loaded period always starts showing its full range;
// the zoom slider defaults to the latest reading.
isZoomedView = false;

applyChartData();


}


loadWaterChart();

// Pushes a freshly-inserted reading straight into the already-rendered
// chart, instead of waiting for a full page reload. Only applies it
// if the reading falls within the period currently loaded — a new
// reading today shouldn't appear while browsing "Last Month", for
// example. Also caps memory growth for long-running live periods,
// then re-renders the chart with the full updated dataset.
function appendReadingToChart(row){

    if(!waterChartInstance){

        return;

    }

    const timestamp = parseSupabaseTimestamp(row.created_at).getTime();

    const inRange = chartPeriodIsLive
        ? timestamp >= chartRangeStartMs
        : (timestamp >= chartRangeStartMs && timestamp < chartRangeEndMs);

    if(!inRange){
        return;
    }

    // If a reading gets trimmed off the front once CHART_MAX_LIVE_POINTS
    // is exceeded, shift the zoom slider's selected index down with it
    // so it keeps pointing at the same reading rather than silently
    // drifting to a different one.
    const label = parseSupabaseTimestamp(row.created_at).toLocaleString();

    fullLabels.push(label);
    fullLevels.push(Number(row.water_level));
    fullTimestamps.push(timestamp);

    while(fullTimestamps.length > CHART_MAX_LIVE_POINTS){

        fullTimestamps.shift();
        fullLabels.shift();
        fullLevels.shift();

        if (zoomedPointIndex > 0) {
            zoomedPointIndex--;
        }

    }

    applyChartData();

}

async function loadStatistics(){

// Total readings — count only, doesn't download any rows.
const { count, error: countError } = await supabaseClient

.from("water_readings")

.select("*", { count: "exact", head: true });


if(countError){

console.log(countError);
return;

}


document.getElementById("totalReadings").textContent =
count || 0;


if(!count){

    console.log("No statistics available");

    return;

}


// Highest — sort descending, take 1 row instead of the whole table.

const { data: highestRow, error: highestError } = await supabaseClient

.from("water_readings")

.select("water_level")

.order("water_level", { ascending:false })

.limit(1)

.single();


if(highestError){

console.log(highestError);

}

else{

document.getElementById("highestLevel").textContent =
highestRow.water_level + " m";

}


// Lowest — same idea, ascending.

const { data: lowestRow, error: lowestError } = await supabaseClient

.from("water_readings")

.select("water_level")

.order("water_level", { ascending:true })

.limit(1)

.single();


if(lowestError){

console.log(lowestError);

}

else{

document.getElementById("lowestLevel").textContent =
lowestRow.water_level + " m";

}


// Latest timestamp — most recent single row.

const { data: latestRow, error: latestError } = await supabaseClient

.from("water_readings")

.select("created_at")

.order("created_at", { ascending:false })

.limit(1)

.single();


if(latestError){

console.log(latestError);

return;

}


let date = parseSupabaseTimestamp(latestRow.created_at);


document.getElementById("date").textContent =
date.toLocaleString();


}


loadStatistics();



// Statistics need four queries. A busy device could trigger them on
// every insert, so refresh at most once every 15 seconds.
let statisticsTimer = null;

function scheduleStatisticsRefresh(){

    if(statisticsTimer){
        return;
    }

    statisticsTimer = setTimeout(()=>{

        statisticsTimer = null;
        loadStatistics();

    }, 15000);

}

// REALTIME WATER LEVEL UPDATE

supabaseClient
.channel("water-updates")

.on(
    "postgres_changes",
    {
        event:"INSERT",
        schema:"public",
        table:"water_readings"
    },

    (payload)=>{


const waterLevel =
Number(payload.new.water_level);


updateWaterDisplay(waterLevel);


noteReadingTime(payload.new.created_at);


appendReadingToChart(payload.new);


// Flood alerts (SMS/email) are now handled server-side by a
// Postgres trigger on water_readings inserts — see
// rls-and-alert-trigger.sql. This keeps alerting reliable even
// when no one has the dashboard open, and works correctly with
// the RLS policies restricting sms_queue/email_queue writes.


scheduleStatisticsRefresh();


}

)

.subscribe();