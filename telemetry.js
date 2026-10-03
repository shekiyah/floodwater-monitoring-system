// supabaseClient and parseSupabaseTimestamp come from
// supabase-config.js; requireRole comes from nav.js.
// Viewers are sent back to the dashboard; RLS on system_status is the
// real boundary.

async function loadSystemStatus() {

    const { data, error } = await supabaseClient
        .from("system_status")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1);

    if (error) {
        console.error("Telemetry error:", error);
        return;
    }

    const gsmStatus = document.getElementById("gsmStatus");
    const gsmSignal = document.getElementById("gsmSignal");
    const deviceStatus = document.getElementById("deviceStatus");

    if (!data || data.length === 0) {
        gsmStatus.textContent = "No data yet";
        gsmSignal.textContent = "No data yet";
        deviceStatus.textContent = "No data yet";
        return;
    }

    const status = data[0];

    gsmStatus.textContent = status.internet_status;
    gsmSignal.textContent = status.gsm_signal + "%";
    deviceStatus.textContent = status.device_status;
}

// TELEMETRY HISTORY CHARTS
// A status value counts as "online" if it looks like one of these
// words, or is literally true/1. Adjust ONLINE_PATTERN if the device
// firmware writes different strings into system_status.
const ONLINE_PATTERN = /online|connected|active|up|true|^1$/i;

function isOnline(value) {

    if (value === true || value === 1) {
        return true;
    }

    return ONLINE_PATTERN.test(String(value ?? ""));
}

let telemetrySignalChartInstance = null;
let telemetryStatusChartInstance = null;

async function loadTelemetryHistory() {

    // 48-hour window keeps query cost bounded as system_status grows.
    const windowStart = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const { data, error } = await supabaseClient
        .from("system_status")
        .select("*")
        .gte("updated_at", windowStart.toISOString())
        .order("updated_at", { ascending: true })
        .limit(2000);

    if (error) {
        console.error("Telemetry history error:", error);
        return;
    }

    if (!data || data.length === 0) {
        return;
    }

    const labels = data.map(row => parseSupabaseTimestamp(row.updated_at).toLocaleString());

    const signalLevels = data.map(row => Number(row.gsm_signal));
    const internetOnline = data.map(row => isOnline(row.internet_status) ? 1 : 0);
    const deviceOnline = data.map(row => isOnline(row.device_status) ? 1 : 0);

    renderSignalChart(labels, signalLevels);
    renderStatusChart(labels, internetOnline, deviceOnline);
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

function renderSignalChart(labels, signalLevels) {

    const ctx = document.getElementById("telemetrySignalChart");

    if (telemetrySignalChartInstance) {
        telemetrySignalChartInstance.destroy();
    }

    telemetrySignalChartInstance = new Chart(ctx, {

        type: "line",

        data: {
            labels: labels,
            datasets: [{
                label: "GSM signal (%)",
                data: signalLevels,
                borderColor: "#16536B",
                backgroundColor: "rgba(22, 83, 107, 0.10)",
                fill: true,
                borderWidth: 2,
                tension: 0.25,
                pointRadius: 0,
                pointHoverRadius: 4
            }]
        },

        options: {
            responsive: true,
            interaction: { mode: "index", intersect: false },
            plugins: { legend: { display: false } },
            scales: {
                x: timeAxis,
                y: {
                    beginAtZero: true,
                    max: 100,
                    title: { display: true, text: "Signal %" }
                }
            }
        }
    });
}

function renderStatusChart(labels, internetOnline, deviceOnline) {

    const ctx = document.getElementById("telemetryStatusChart");

    if (telemetryStatusChartInstance) {
        telemetryStatusChartInstance.destroy();
    }

    telemetryStatusChartInstance = new Chart(ctx, {

        type: "line",

        data: {
            labels: labels,
            datasets: [
                {
                    label: "Internet",
                    data: internetOnline,
                    borderColor: "#16536B",
                    stepped: true,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4
                },
                {
                    label: "Device",
                    data: deviceOnline,
                    borderColor: "#A9773B",
                    stepped: true,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4
                }
            ]
        },

        options: {
            responsive: true,
            interaction: { mode: "index", intersect: false },
            scales: {
                x: timeAxis,
                y: {
                    min: 0,
                    max: 1,
                    ticks: {
                        stepSize: 1,
                        callback: value => value === 1 ? "Online" : "Offline"
                    }
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
        .subscribe();
}

init();