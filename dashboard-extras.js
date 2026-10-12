// Dashboard map + station health. Loaded before script.js; script.js is unchanged.
// supabaseClient and parseSupabaseTimestamp come from supabase-config.js.
(function () {

    // Station location (fixed, not from the ESP32).
    const STATION = { name: "Flood monitoring station", lat: 11.086126, lng: 125.023385, zoom: 17 };
    const STALE_MIN = 10;
    const PIN = { online: "#D93A3A", offline: "#8a949b" };   // red = online, grey = not online

    // Dark theme for the existing water-level chart.
    if (window.Chart) {
        Chart.defaults.color = "#9db7c6";
        Chart.defaults.borderColor = "rgba(140, 190, 215, 0.12)";
    }

    // Free OpenStreetMap tiles, darkened with a CSS filter (pin and controls are not affected).
    const mapStyle = document.createElement("style");
    mapStyle.textContent = ".leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.9) contrast(.9) saturate(.5)}";
    document.head.appendChild(mapStyle);

    let map, marker;

    const text = id => (document.getElementById(id)?.textContent || "").trim();

    // "Online" = the dashboard's Sensor connection tile says Connected
    // (script.js fills #sensorConnection; "No recent data" or "Checking…" count as not online).
    function isStationOnline() {
        return /^connected/i.test(text("sensorConnection"));
    }

    function makeIcon(online) {
        const color = online ? PIN.online : PIN.offline;
        return L.divIcon({
            className: "",
            html: `<svg width="28" height="38" viewBox="0 0 28 38" aria-hidden="true" style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))">
                       <path d="M14 1C6.8 1 1 6.7 1 13.7 1 23.6 14 37 14 37s13-13.4 13-23.3C27 6.7 21.2 1 14 1z" fill="${color}" stroke="#fff" stroke-width="2"/>
                       <circle cx="14" cy="13.5" r="4.8" fill="#fff"/>
                   </svg>`,
            iconSize: [28, 38], iconAnchor: [14, 37], popupAnchor: [0, -34]
        });
    }

    function popupNode() {
        const box = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = STATION.name;
        box.append(name, document.createElement("br"),
            `Connection: ${isStationOnline() ? "Online" : "Offline"}`, document.createElement("br"),
            `Water level: ${text("waterLevel") || "—"}`, document.createElement("br"),
            `Status: ${text("status") || "—"}`);
        return box;
    }

    function refreshMarker() {
        if (!marker) return;
        marker.setIcon(makeIcon(isStationOnline()));
        marker.setPopupContent(popupNode());
    }

    function initMap() {
        const el = document.getElementById("map");
        if (!el || !window.L) return;

        map = L.map(el, { scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false })
            .setView([STATION.lat, STATION.lng], STATION.zoom);

        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);

        marker = L.marker([STATION.lat, STATION.lng], { icon: makeIcon(false), title: STATION.name })
            .addTo(map).bindPopup(popupNode());
        document.getElementById("mapCoords").textContent = `${STATION.lat.toFixed(6)}, ${STATION.lng.toFixed(6)}`;

        // script.js fills these; follow them so the pin updates by itself.
        const obs = new MutationObserver(refreshMarker);
        ["sensorConnection", "status", "waterLevel"].forEach(id => {
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
        // The pin stays at STATION above; device GPS is not used.
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