// Dashboard map + station health. Loaded before script.js; script.js is unchanged.
// supabaseClient and parseSupabaseTimestamp come from supabase-config.js.
(function () {

    // >>> EDIT THESE to where the station is installed. <<<
    const STATION = { name: "Flood monitoring station", lat: 10.3157, lng: 123.8854, zoom: 15 };
    const STALE_MIN = 10;
    const COLORS = { normal: "#2E9E4F", alert: "#E8B93A", critical: "#E2711D", danger: "#D93A3A", unknown: "#6b8794" };

    // Dark theme for the existing water-level chart.
    if (window.Chart) {
        Chart.defaults.color = "#9db7c6";
        Chart.defaults.borderColor = "rgba(140, 190, 215, 0.12)";
    }

    let map, marker;

    const text = id => (document.getElementById(id)?.textContent || "").trim();

    function statusKey() {
        const t = text("status").toLowerCase();
        return COLORS[t] ? t : "unknown";
    }

    function makeIcon(key) {
        return L.divIcon({
            className: "",
            html: `<div class="st-marker" style="--c:${COLORS[key]}"></div>`,
            iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -12]
        });
    }

    function popupNode() {
        const box = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = STATION.name;
        box.append(name, document.createElement("br"),
            `Water level: ${text("waterLevel") || "—"}`, document.createElement("br"),
            `Status: ${text("status") || "—"}`);
        return box;
    }

    function refreshMarker() {
        if (!marker) return;
        marker.setIcon(makeIcon(statusKey()));
        marker.setPopupContent(popupNode());
    }

    function placeStation(lat, lng) {
        marker.setLatLng([lat, lng]);
        map.setView([lat, lng], STATION.zoom);
        document.getElementById("mapCoords").textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }

    function initMap() {
        const el = document.getElementById("map");
        if (!el || !window.L) return;

        map = L.map(el, { scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false })
            .setView([STATION.lat, STATION.lng], STATION.zoom);

        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            maxZoom: 19, subdomains: "abcd",
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        }).addTo(map);

        marker = L.marker([STATION.lat, STATION.lng], { icon: makeIcon("unknown"), title: STATION.name })
            .addTo(map).bindPopup(popupNode());
        document.getElementById("mapCoords").textContent = `${STATION.lat.toFixed(5)}, ${STATION.lng.toFixed(5)}`;

        // script.js fills #status and #waterLevel; follow them.
        const obs = new MutationObserver(refreshMarker);
        ["status", "waterLevel"].forEach(id => {
            const n = document.getElementById(id);
            if (n) obs.observe(n, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        });
        refreshMarker();
    }

    // ---------- Station health (latest system_status row) ----------
    const ONLINE = /online|connected|active|up|true|^1$/i;
    const isOnline = v => v === true || v === 1 || ONLINE.test(String(v ?? ""));
    const has = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

    function setState(id, value, ok) {
        const el = document.getElementById(id);
        el.textContent = value;
        el.className = ok ? "ok" : "bad";
    }

    function ageText(date) {
        const m = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
        if (m < 1) return { t: "Updated just now", stale: false };
        if (m < 60) return { t: `Updated ${m} min ago`, stale: m > STALE_MIN };
        if (m < 2880) return { t: `Updated ${Math.round(m / 60)} h ago`, stale: true };
        return { t: `Updated ${Math.round(m / 1440)} days ago`, stale: true };
    }

    async function loadHealth() {
        if (!window.supabaseClient || !document.getElementById("hInternet")) return;

        const { data, error } = await supabaseClient
            .from("system_status").select("*").order("updated_at", { ascending: false }).limit(1);

        if (error || !data || !data.length) {
            document.getElementById("hUpdated").textContent = error ? "Station health isn't available for your account." : "No station data yet.";
            return;
        }

        const r = data[0];
        setState("hInternet", r.internet_status ?? "—", isOnline(r.internet_status));
        setState("hDevice", r.device_status ?? "—", isOnline(r.device_status));

        const pct = has(r.gsm_signal) ? Math.max(0, Math.min(100, Number(r.gsm_signal))) : null;
        document.getElementById("hSignal").textContent = pct === null ? "—" : pct + "%";
        document.querySelectorAll("#hBars i").forEach((b, i) =>
            b.classList.toggle("on", pct !== null && pct > i * 20));

        document.getElementById("hSpeed").textContent = has(r.upload_kbps) ? (Number(r.upload_kbps) / 1000).toFixed(2) + " Mbps" : "—";
        document.getElementById("hPing").textContent = has(r.ping_ms) ? Math.round(Number(r.ping_ms)) + " ms" : "—";

        if (r.updated_at) {
            const ts = typeof parseSupabaseTimestamp === "function" ? parseSupabaseTimestamp(r.updated_at) : new Date(r.updated_at);
            const a = ageText(ts);
            const u = document.getElementById("hUpdated");
            u.textContent = a.t;
            u.classList.toggle("is-stale", a.stale);
        }

        // Optional: if the device later sends GPS, the marker follows it.
        if (map && has(r.latitude) && has(r.longitude)) placeStation(Number(r.latitude), Number(r.longitude));
    }

    function init() {
        initMap();
        loadHealth();
        if (window.supabaseClient) {
            supabaseClient.channel("dashboard-system-status")
                .on("postgres_changes", { event: "INSERT", schema: "public", table: "system_status" }, loadHealth)
                .subscribe();
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

})();