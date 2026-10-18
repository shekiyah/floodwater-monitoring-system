// Dashboard map + station health.
// The map starts at the configured station coordinates, then follows the
// latest A7670C cellular location saved in public.device_locations.
// supabaseClient and parseSupabaseTimestamp come from supabase-config.js.
(function () {

    // Fallback is the user-confirmed physical station location. This is used
    // until the ESP32 publishes its first successful cellular-location result.
    const STATION = {
        name: "Flood monitoring station",
        deviceId: "ESP32-FLOOD-01",
        lat: 11.086017,
        lng: 125.023413,
        zoom: 17
    };
    const STALE_MIN = 10;
    const LOCATION_POLL_MS = 60000;
    const PIN = { online: "#D93A3A", offline: "#8a949b" };

    if (window.Chart) {
        Chart.defaults.color = "#9db7c6";
        Chart.defaults.borderColor = "rgba(140, 190, 215, 0.12)";
    }

    const mapStyle = document.createElement("style");
    mapStyle.textContent = ".leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.9) contrast(.9) saturate(.5)}";
    document.head.appendChild(mapStyle);

    let map, marker, accuracyCircle;
    let activeLocation = {
        lat: STATION.lat,
        lng: STATION.lng,
        accuracyM: null,
        acquiredAt: null,
        updatedAt: null,
        source: "configured"
    };

    const text = id => (document.getElementById(id)?.textContent || "").trim();

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

    function timestampText(value) {
        if (!value) return "time unavailable";
        const date = typeof parseSupabaseTimestamp === "function"
            ? parseSupabaseTimestamp(value)
            : new Date(value);
        if (Number.isNaN(date.getTime())) return "time unavailable";
        return date.toLocaleString();
    }

    function popupNode() {
        const box = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = STATION.name;
        box.append(name, document.createElement("br"));
        box.append(`Connection: ${isStationOnline() ? "Online" : "Offline"}`, document.createElement("br"));
        box.append(`Water level: ${text("waterLevel") || "—"}`, document.createElement("br"));
        box.append(`Flood status: ${text("status") || "—"}`, document.createElement("br"));
        if (activeLocation.source === "cellular") {
            box.append("Location source: A7670C cellular estimate", document.createElement("br"));
            box.append(`Reported accuracy: ±${activeLocation.accuracyM ?? "unknown"} m`, document.createElement("br"));
            box.append(`Location acquired: ${timestampText(activeLocation.acquiredAt)}`);
        } else {
            box.append("Location source: configured station coordinates");
        }
        return box;
    }

    function refreshMarker() {
        if (!marker) return;
        marker.setIcon(makeIcon(isStationOnline()));
        marker.setPopupContent(popupNode());
    }

    function setLocationStatus(message, isWarning = false) {
        const el = document.getElementById("mapLocationStatus");
        if (!el) return;
        el.textContent = message;
        el.classList.toggle("is-warning", isWarning);
    }

    function haversineMeters(aLat, aLng, bLat, bLng) {
        const toRad = value => value * Math.PI / 180;
        const dLat = toRad(bLat - aLat);
        const dLng = toRad(bLng - aLng);
        const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function applyCellLocation(row) {
        if (!row) return false;
        const lat = Number(row.latitude);
        const lng = Number(row.longitude);
        const accuracy = Number(row.accuracy_m);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
            !Number.isFinite(lng) || lng < -180 || lng > 180 ||
            !Number.isFinite(accuracy) || accuracy < 0) {
            console.warn("Ignoring invalid device_locations row.", row);
            return false;
        }

        const wasConfigured = activeLocation.source !== "cellular";
        const movementM = haversineMeters(activeLocation.lat, activeLocation.lng, lat, lng);
        activeLocation = {
            lat,
            lng,
            accuracyM: Math.round(accuracy),
            acquiredAt: row.acquired_at || null,
            updatedAt: row.updated_at || null,
            source: "cellular"
        };

        if (marker) marker.setLatLng([lat, lng]);
        if (accuracyCircle) {
            accuracyCircle.setLatLng([lat, lng]);
            accuracyCircle.setRadius(Math.max(accuracy, 1));
            accuracyCircle.setStyle({ opacity: 0.65, fillOpacity: 0.12 });
        }

        // Center on the first cellular fix and on later meaningful changes.
        // The accuracy circle makes the approximate nature of cell location visible.
        if (map && (wasConfigured || movementM >= 20)) {
            map.setView([lat, lng], Math.min(map.getZoom(), 17), { animate: true });
        }

        const coords = document.getElementById("mapCoords");
        if (coords) coords.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        setLocationStatus(
            `A7670C cellular estimate · reported accuracy ±${Math.round(accuracy)} m · acquired ${timestampText(row.acquired_at)}. ` +
            `Updates about every 15 minutes while status is NORMAL; paused during flood alerts.`,
            accuracy > 250
        );
        refreshMarker();
        return true;
    }

    function showConfiguredFallback(message) {
        if (activeLocation.source === "cellular") {
            // Keep the last valid cellular fix when a query temporarily fails.
            setLocationStatus(`Keeping the last valid A7670C cellular estimate (${activeLocation.lat.toFixed(6)}, ${activeLocation.lng.toFixed(6)}). ${message}`, true);
            return;
        }
        setLocationStatus(message, true);
    }

    async function loadCellLocation() {
        if (typeof supabaseClient === "undefined" || !supabaseClient) {
            showConfiguredFallback("Supabase is unavailable. Showing configured station coordinates.");
            return;
        }

        const { data, error } = await supabaseClient
            .from("device_locations")
            .select("device_id, latitude, longitude, accuracy_m, acquired_at, updated_at")
            .eq("device_id", STATION.deviceId)
            .maybeSingle();

        if (error) {
            console.warn("Could not load cellular station location:", error.message);
            showConfiguredFallback("Could not load automatic location. Run the location SQL setup and check Supabase access; showing the last known/configured position.");
            return;
        }

        if (!data) {
            showConfiguredFallback("Waiting for the ESP32's first A7670C location update. Showing configured station coordinates for now.");
            return;
        }

        if (!applyCellLocation(data)) {
            showConfiguredFallback("The latest cellular location was invalid. Keeping the last valid/configured position.");
        }
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

        accuracyCircle = L.circle([STATION.lat, STATION.lng], {
            radius: 1,
            color: "#e6b25e",
            weight: 1,
            fillColor: "#e6b25e",
            fillOpacity: 0.12,
            interactive: false
        }).addTo(map);
        accuracyCircle.setStyle({ opacity: 0, fillOpacity: 0 });

        marker = L.marker([STATION.lat, STATION.lng], { icon: makeIcon(false), title: STATION.name })
            .addTo(map).bindPopup(popupNode());
        const coords = document.getElementById("mapCoords");
        if (coords) coords.textContent = `${STATION.lat.toFixed(6)}, ${STATION.lng.toFixed(6)} (configured)`;
        setLocationStatus("Waiting for the first automatic A7670C location update. Showing configured station coordinates for now.");

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
        if (typeof supabaseClient === "undefined" || !supabaseClient || !document.getElementById("hInternet")) return;

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
        loadCellLocation();
        // Realtime moves the map as soon as the ESP32 writes a new location.
        // A 60-second read is also kept as a fallback if a Realtime event is missed.
        if (typeof supabaseClient !== "undefined" && supabaseClient) {
            supabaseClient.channel("dashboard-system-status")
                .on("postgres_changes", { event: "INSERT", schema: "public", table: "system_status" }, loadHealth)
                .subscribe();

            supabaseClient.channel("dashboard-cell-location")
                .on("postgres_changes", {
                    event: "*",
                    schema: "public",
                    table: "device_locations",
                    filter: `device_id=eq.${STATION.deviceId}`
                }, payload => applyCellLocation(payload.new))
                .subscribe();
        }
        window.setInterval(loadCellLocation, LOCATION_POLL_MS);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

})();