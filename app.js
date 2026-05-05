// Weather Data Exporter — fetches weather data from Open-Meteo (model),
// Meteostat (Indonesian observation stations), or NASA POWER (MERRA-2
// reanalysis with solar radiation), renders a windrose, and exports to
// Excel. Every upstream call is proxied through the backend so a valid
// Bearer token is required — see the login screen.

const BACKEND_URL =
    (window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL) || "http://localhost:8001";

// All three upstream sources go through the backend now; the token gate
// is enforced server-side.
const GEOCODE_URL = `${BACKEND_URL}/api/openmeteo/geocoding`;
const FORECAST_URL = `${BACKEND_URL}/api/openmeteo/forecast`;
const ARCHIVE_URL = `${BACKEND_URL}/api/openmeteo/archive`;
const POWER_URL = `${BACKEND_URL}/api/power/daily/point`;
const POWER_FILL = -999.0;

const TOKEN_STORAGE_KEY = "wde.auth.token";
const PROFILE_STORAGE_KEY = "wde.auth.profile";

// Open-Meteo hourly variables fetched on every request. Wind speeds come back
// in m/s thanks to the `wind_speed_unit=ms` query parameter. The hourly values
// are aggregated to daily on the client to compute true means (Open-Meteo's
// daily endpoint only exposes max for wind_speed_10m).
const OPENMETEO_HOURLY_VARS = [
    "temperature_2m",
    "precipitation",
    "wind_speed_10m",
    "wind_direction_10m",
    "sunshine_duration",
];

// Order of columns in the Open-Meteo daily preview/Excel output.
const OPENMETEO_DAILY_COLS = [
    { key: "temperature_2m_mean", label: "Suhu rata-rata", unit: "°C" },
    { key: "precipitation_sum", label: "Curah hujan", unit: "mm" },
    { key: "wind_speed_10m_mean", label: "Kecepatan angin rata-rata", unit: "m/s" },
    { key: "wind_direction_10m_dominant", label: "Arah angin dominan", unit: "°" },
    { key: "sunshine_duration_h", label: "Lama penyinaran matahari", unit: "jam" },
];

// Meteostat daily columns shown in the preview and Excel output. The backend
// `/daily/` response includes more fields, but we filter down to the five
// requested variables. Wind speeds (`wspd`) are already in m/s thanks to the
// backend's km/h -> m/s conversion; sunshine duration (`tsun`) comes back in
// minutes and is converted to hours on the client.
const METEOSTAT_DISPLAY_COLS = [
    { src: "tavg", label: "Suhu rata-rata", unit: "°C" },
    { src: "prcp", label: "Curah hujan", unit: "mm" },
    { src: "wspd", label: "Kecepatan angin rata-rata", unit: "m/s" },
    { src: "wdir", label: "Arah angin dominan", unit: "°" },
    { src: "tsun_h", label: "Lama penyinaran matahari", unit: "jam" },
];

// NASA POWER parameter metadata. Order here defines column order in the
// export. All values are daily aggregates (UTC). NASA POWER does not expose a
// direct "sunshine duration" parameter, so we report the daily all-sky GHI
// (ALLSKY_SFC_SW_DWN, kWh/m²/hari) as a solar-energy proxy and document the
// substitution in the Info sheet.
const POWER_PARAMS = [
    { key: "T2M", label: "Suhu rata-rata", unit: "°C" },
    { key: "PRECTOTCORR", label: "Curah hujan", unit: "mm/hari" },
    { key: "WS10M", label: "Kecepatan angin rata-rata (10 m)", unit: "m/s" },
    { key: "WD10M", label: "Arah angin dominan (10 m)", unit: "°" },
    {
        key: "ALLSKY_SFC_SW_DWN",
        label: "Radiasi GHI (proxy penyinaran)",
        unit: "kWh/m²/hari",
    },
];

const state = {
    source: "openmeteo", // "openmeteo" | "meteostat" | "power"
    selectedCity: null,
    selectedStation: null,
    stations: [],
    lastResult: null, // {headers, rows, meta, windRows: [{dir, spd}]}
    windroseMode: "from", // "from" (asal angin) | "to" (arah hembusan)
    auth: { token: null, profile: null },
};

const els = {};

// ===== Authentication =====

class AuthError extends Error {
    constructor(message) {
        super(message);
        this.name = "AuthError";
    }
}

function loadAuth() {
    try {
        const token = localStorage.getItem(TOKEN_STORAGE_KEY) || null;
        const profileRaw = localStorage.getItem(PROFILE_STORAGE_KEY);
        const profile = profileRaw ? JSON.parse(profileRaw) : null;
        state.auth = { token, profile };
        return state.auth;
    } catch (_) {
        state.auth = { token: null, profile: null };
        return state.auth;
    }
}

function saveAuth(token, profile) {
    state.auth = { token, profile };
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
    if (profile) localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(PROFILE_STORAGE_KEY);
}

function clearAuth() {
    saveAuth(null, null);
}

function isAuthExpired(profile) {
    if (!profile || !profile.expires_at) return true;
    const exp = Date.parse(profile.expires_at);
    if (!Number.isFinite(exp)) return true;
    return Date.now() >= exp;
}

async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.auth.token) {
        headers.set("Authorization", `Bearer ${state.auth.token}`);
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
        clearAuth();
        showLoginView("Sesi Anda berakhir. Silakan login kembali.");
        throw new AuthError("Token tidak valid atau sudah berakhir.");
    }
    return res;
}

// ===== Login / view switching =====

function showLoginView(message) {
    document.getElementById("login-view").hidden = false;
    document.getElementById("admin-view").hidden = true;
    document.getElementById("app-view").hidden = true;
    document.getElementById("auth-bar").hidden = true;
    if (message) showLoginStatus(message, "info");
}

function showAppView() {
    document.getElementById("login-view").hidden = true;
    document.getElementById("admin-view").hidden = true;
    document.getElementById("app-view").hidden = false;
    document.getElementById("auth-bar").hidden = false;
    refreshAuthBar();
}

function showAdminView() {
    document.getElementById("login-view").hidden = true;
    document.getElementById("app-view").hidden = true;
    document.getElementById("admin-view").hidden = false;
    document.getElementById("auth-bar").hidden = false;
    refreshAuthBar();
}

function refreshAuthBar() {
    const p = state.auth.profile;
    const lab = document.getElementById("auth-label");
    if (!p || !lab) return;
    const exp = p.expires_at ? new Date(p.expires_at) : null;
    const expStr = exp
        ? exp.toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })
        : "?";
    lab.textContent = `Login: ${p.label} · berakhir ${expStr}`;
}

function showLoginStatus(msg, type = "info") {
    const el = document.getElementById("login-status");
    el.hidden = false;
    el.textContent = msg;
    el.className = `status ${type}`;
}

async function handleLoginSubmit() {
    const input = document.getElementById("login-token");
    const token = (input.value || "").trim();
    if (!token) {
        showLoginStatus("Masukkan token akses Anda.", "error");
        return;
    }
    showLoginStatus("Memverifikasi token...", "loading");
    try {
        const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
        });
        const text = await res.text();
        if (!res.ok) {
            let detail = text;
            try {
                detail = JSON.parse(text).detail || text;
            } catch (_) {}
            throw new Error(`HTTP ${res.status}: ${detail}`);
        }
        const profile = JSON.parse(text);
        if (profile.revoked || profile.expired) {
            throw new Error("Token sudah dicabut atau kadaluarsa.");
        }
        saveAuth(token, profile);
        input.value = "";
        showAppView();
    } catch (err) {
        showLoginStatus(`Gagal login: ${err.message}`, "error");
    }
}

function handleLogout() {
    clearAuth();
    showLoginView("Anda telah logout.");
}

// ===== Admin panel =====

function showAdminStatus(msg, type = "info") {
    const el = document.getElementById("admin-status");
    el.hidden = false;
    el.textContent = msg;
    el.className = `status ${type}`;
}

function adminSecret() {
    return (document.getElementById("admin-secret").value || "").trim();
}

async function adminFetch(path, opts = {}) {
    const sec = adminSecret();
    if (!sec) throw new Error("Masukkan X-Admin-Secret terlebih dahulu.");
    const headers = new Headers(opts.headers || {});
    headers.set("X-Admin-Secret", sec);
    if (opts.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`${BACKEND_URL}${path}`, { ...opts, headers });
    const text = await res.text();
    if (!res.ok) {
        let detail = text;
        try { detail = JSON.parse(text).detail || text; } catch (_) {}
        throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return text ? JSON.parse(text) : null;
}

async function handleAdminCreate() {
    const label = (document.getElementById("admin-new-label").value || "").trim();
    const days = parseInt(document.getElementById("admin-new-days").value, 10);
    if (!label) {
        showAdminStatus("Label tidak boleh kosong.", "error");
        return;
    }
    showAdminStatus("Membuat token...", "loading");
    try {
        const t = await adminFetch("/api/admin/tokens", {
            method: "POST",
            body: JSON.stringify({ label, days }),
        });
        const box = document.getElementById("admin-new-token-box");
        box.hidden = false;
        box.innerHTML =
            `<strong>Token baru untuk ${escapeHtml(t.label)} (${days} hari):</strong><br>` +
            `<code class="token-display">${escapeHtml(t.token)}</code><br>` +
            `<small>Berlaku sampai ${escapeHtml(t.expires_at)}. Salin token ini sekarang \u2014 ` +
            `tidak akan ditampilkan ulang.</small>`;
        showAdminStatus(`Token untuk "${t.label}" berhasil dibuat.`, "success");
        document.getElementById("admin-new-label").value = "";
        await handleAdminRefresh();
    } catch (err) {
        showAdminStatus(`Gagal: ${err.message}`, "error");
    }
}

async function handleAdminRefresh() {
    showAdminStatus("Memuat daftar token...", "loading");
    try {
        const data = await adminFetch("/api/admin/tokens");
        renderAdminTokens(data.tokens || []);
        showAdminStatus(`${data.count} token.`, "info");
    } catch (err) {
        showAdminStatus(`Gagal: ${err.message}`, "error");
    }
}

async function handleAdminRevoke(token) {
    if (!confirm(`Cabut token ${token}?`)) return;
    try {
        await adminFetch(`/api/admin/tokens/${encodeURIComponent(token)}`, {
            method: "DELETE",
        });
        showAdminStatus("Token dicabut.", "success");
        await handleAdminRefresh();
    } catch (err) {
        showAdminStatus(`Gagal: ${err.message}`, "error");
    }
}

function renderAdminTokens(tokens) {
    const t = document.getElementById("admin-tokens-table");
    t.innerHTML = "";
    if (!tokens.length) {
        t.innerHTML = "<tbody><tr><td>(belum ada token)</td></tr></tbody>";
        return;
    }
    const thead = document.createElement("thead");
    thead.innerHTML = `<tr>
        <th>Label</th><th>Status</th><th>Berakhir</th><th>Token</th><th></th>
    </tr>`;
    t.appendChild(thead);
    const tbody = document.createElement("tbody");
    tokens.forEach((tok) => {
        const status = tok.revoked
            ? `<span class="badge bad">revoked</span>`
            : tok.expired
                ? `<span class="badge muted">expired</span>`
                : `<span class="badge good">active</span>`;
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${escapeHtml(tok.label)}</td>
            <td>${status}</td>
            <td>${escapeHtml(tok.expires_at)}</td>
            <td><code class="token-display">${escapeHtml(tok.token)}</code></td>
            <td><button class="link-button revoke-btn" data-token="${escapeHtml(tok.token)}">Revoke</button></td>`;
        tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    t.querySelectorAll(".revoke-btn").forEach((b) =>
        b.addEventListener("click", (e) => handleAdminRevoke(e.target.dataset.token))
    );
}

document.addEventListener("DOMContentLoaded", () => {
    // Login form bindings.
    document.getElementById("login-btn").addEventListener("click", handleLoginSubmit);
    document.getElementById("login-token").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleLoginSubmit();
        }
    });
    document.getElementById("logout-btn").addEventListener("click", handleLogout);
    document.getElementById("open-admin-btn").addEventListener("click", showAdminView);
    document.getElementById("back-from-admin-btn").addEventListener("click", showAppView);
    document.getElementById("admin-create-btn").addEventListener("click", handleAdminCreate);
    document.getElementById("admin-refresh-btn").addEventListener("click", handleAdminRefresh);

    // Decide initial view based on stored token.
    loadAuth();
    if (state.auth.token && state.auth.profile && !isAuthExpired(state.auth.profile)) {
        showAppView();
    } else {
        if (state.auth.token) clearAuth();
        showLoginView();
    }

    els.cityInput = document.getElementById("city-input");
    els.suggestions = document.getElementById("city-suggestions");
    els.selectedCity = document.getElementById("selected-city");
    els.citySection = document.getElementById("city-section");
    els.stationSection = document.getElementById("station-section");
    els.stationSearch = document.getElementById("station-search");
    els.stationSelect = document.getElementById("station-select");
    els.selectedStation = document.getElementById("selected-station");
    els.startDate = document.getElementById("start-date");
    els.endDate = document.getElementById("end-date");
    els.timezone = document.getElementById("timezone");
    els.periodHelpOM = document.getElementById("period-help-openmeteo");
    els.periodHelpMS = document.getElementById("period-help-meteostat");
    els.periodHelpPW = document.getElementById("period-help-power");
    els.varsSection = document.getElementById("vars-section");
    els.varsHelpOM = document.getElementById("vars-help-openmeteo");
    els.varsHelpMS = document.getElementById("vars-help-meteostat");
    els.varsHelpPW = document.getElementById("vars-help-power");
    els.previewBtn = document.getElementById("preview-btn");
    els.downloadBtn = document.getElementById("download-btn");
    els.windroseBtn = document.getElementById("windrose-btn");
    els.form = document.getElementById("weather-form");
    els.status = document.getElementById("status");
    els.previewSection = document.getElementById("preview-section");
    els.previewInfo = document.getElementById("preview-info");
    els.previewTable = document.getElementById("preview-table");
    els.windroseSection = document.getElementById("windrose-section");
    els.windroseInfo = document.getElementById("windrose-info");
    els.windroseChart = document.getElementById("windrose-chart");
    els.windroseDownload = document.getElementById("windrose-download");
    els.windroseModeRadios = document.querySelectorAll('input[name="windrose-mode"]');

    const today = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(today.getDate() - 7);
    els.startDate.value = isoDate(weekAgo);
    els.endDate.value = isoDate(today);

    setupSourceToggle();
    setupCityAutocomplete();
    setupStationPicker();

    els.previewBtn.addEventListener("click", () => handleSubmit({ download: false }));
    els.form.addEventListener("submit", (e) => {
        e.preventDefault();
        handleSubmit({ download: true });
    });
    els.windroseBtn.addEventListener("click", showWindrose);
    els.windroseDownload.addEventListener("click", downloadWindrosePNG);
    els.windroseModeRadios.forEach((r) =>
        r.addEventListener("change", () => {
            state.windroseMode = r.value;
            // Re-render only if a windrose was already shown for current data.
            if (state.lastResult && !els.windroseSection.hidden) {
                showWindrose();
            }
        })
    );
});

function isoDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));
}

// ----- Source toggle -----

function setupSourceToggle() {
    const radios = document.querySelectorAll('input[name="source"]');
    radios.forEach((r) =>
        r.addEventListener("change", () => {
            state.source = r.value;
            updateSourceUI();
        })
    );
    updateSourceUI();
}

function updateSourceUI() {
    const src = state.source;
    const isOM = src === "openmeteo";
    const isMS = src === "meteostat";
    const isPW = src === "power";

    // POWER reuses the city picker (it just needs lat/lon).
    els.citySection.hidden = isMS;
    els.stationSection.hidden = !isMS;
    els.periodHelpOM.hidden = !isOM;
    els.periodHelpMS.hidden = !isMS;
    if (els.periodHelpPW) els.periodHelpPW.hidden = !isPW;
    // All three sources now fetch fixed daily variable sets; show the
    // matching help text for the selected source.
    if (els.varsHelpOM) els.varsHelpOM.hidden = !isOM;
    els.varsHelpMS.hidden = !isMS;
    if (els.varsHelpPW) els.varsHelpPW.hidden = !isPW;
    els.varsSection.hidden = false;

    if (isMS && !state.stations.length) {
        loadStations();
    }
}

// ----- City autocomplete (Open-Meteo) -----

function setupCityAutocomplete() {
    let debounceTimer = null;
    let activeIndex = -1;

    els.cityInput.addEventListener("input", () => {
        const q = els.cityInput.value.trim();
        state.selectedCity = null;
        els.selectedCity.textContent = "Belum ada kota yang dipilih.";
        clearTimeout(debounceTimer);
        if (q.length < 2) {
            hideSuggestions();
            return;
        }
        debounceTimer = setTimeout(() => searchCities(q), 250);
    });

    els.cityInput.addEventListener("keydown", (e) => {
        const items = els.suggestions.querySelectorAll("li");
        if (!items.length) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeIndex = Math.min(activeIndex + 1, items.length - 1);
            updateActive(items, activeIndex);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            updateActive(items, activeIndex);
        } else if (e.key === "Enter" && activeIndex >= 0) {
            e.preventDefault();
            items[activeIndex].click();
        } else if (e.key === "Escape") {
            hideSuggestions();
        }
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".autocomplete")) hideSuggestions();
    });

    function updateActive(items, idx) {
        items.forEach((it, i) => it.classList.toggle("active", i === idx));
    }

    function hideSuggestions() {
        els.suggestions.hidden = true;
        els.suggestions.innerHTML = "";
        activeIndex = -1;
    }

    async function searchCities(q) {
        try {
            const url = `${GEOCODE_URL}?name=${encodeURIComponent(
                q
            )}&count=8&language=id&format=json`;
            const res = await apiFetch(url);
            if (!res.ok) throw new Error(`Geocoding error ${res.status}`);
            const data = await res.json();
            renderSuggestions(data.results || []);
        } catch (err) {
            console.error(err);
            hideSuggestions();
        }
    }

    function renderSuggestions(results) {
        els.suggestions.innerHTML = "";
        if (!results.length) {
            hideSuggestions();
            return;
        }
        results.forEach((r) => {
            const li = document.createElement("li");
            const parts = [r.name];
            if (r.admin1) parts.push(r.admin1);
            if (r.country) parts.push(r.country);
            li.innerHTML = `<strong>${escapeHtml(r.name)}</strong>
                <span class="meta">${escapeHtml(parts.slice(1).join(", "))}
                — ${r.latitude.toFixed(3)}, ${r.longitude.toFixed(3)}</span>`;
            li.addEventListener("click", () => selectCity(r));
            els.suggestions.appendChild(li);
        });
        els.suggestions.hidden = false;
        activeIndex = -1;
    }

    function selectCity(r) {
        state.selectedCity = r;
        const parts = [r.name];
        if (r.admin1) parts.push(r.admin1);
        if (r.country) parts.push(r.country);
        els.cityInput.value = parts.join(", ");
        els.selectedCity.innerHTML = `Terpilih: <strong>${escapeHtml(parts.join(", "))}</strong>
            (${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)},
            zona waktu: ${escapeHtml(r.timezone || "auto")})`;
        hideSuggestions();
    }
}

// ----- Station picker (Meteostat) -----

async function loadStations() {
    try {
        showStatus("Memuat daftar stasiun Indonesia...", "loading");
        const res = await apiFetch(`${BACKEND_URL}/stations`);
        if (!res.ok) throw new Error(`Backend ${res.status}`);
        const data = await res.json();
        state.stations = data.stations || [];
        renderStationList(state.stations);
        showStatus(`${state.stations.length} stasiun di Indonesia tersedia.`, "info");
    } catch (err) {
        console.error(err);
        showStatus(`Gagal memuat daftar stasiun: ${err.message}`, "error");
    }
}

function setupStationPicker() {
    els.stationSearch.addEventListener("input", () => {
        const q = els.stationSearch.value.trim().toLowerCase();
        if (!q) {
            renderStationList(state.stations);
            return;
        }
        const filtered = state.stations.filter((s) => {
            const hay = [s.id, s.name, s.wmo, s.icao, s.region]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            return hay.includes(q);
        });
        renderStationList(filtered);
    });

    els.stationSelect.addEventListener("change", () => {
        const id = els.stationSelect.value;
        const s = state.stations.find((x) => x.id === id);
        if (s) selectStation(s);
    });
}

function renderStationList(list) {
    els.stationSelect.innerHTML = "";
    list.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.id;
        const wmo = s.wmo || s.id;
        const icao = s.icao ? ` (${s.icao})` : "";
        const inv = s.hourly_end ? ` · hourly ${s.hourly_start} → ${s.hourly_end}` : "";
        opt.textContent = `${wmo}${icao} — ${s.name}${inv}`;
        els.stationSelect.appendChild(opt);
    });
}

function selectStation(s) {
    state.selectedStation = s;
    const wmo = s.wmo || s.id;
    const icao = s.icao ? ` / ${s.icao}` : "";
    els.selectedStation.innerHTML =
        `Terpilih: <strong>${escapeHtml(s.name)}</strong> ` +
        `(WMO ${escapeHtml(wmo)}${escapeHtml(icao)}, ` +
        `${s.latitude?.toFixed(4)}, ${s.longitude?.toFixed(4)}, ` +
        `${escapeHtml(s.timezone || "")})`;
}

// ----- Submit -----

async function handleSubmit({ download }) {
    const startDate = els.startDate.value;
    const endDate = els.endDate.value;
    if (!startDate || !endDate) {
        showStatus("Isi tanggal mulai dan akhir.", "error");
        return;
    }
    if (startDate > endDate) {
        showStatus("Tanggal mulai harus lebih awal dari tanggal akhir.", "error");
        return;
    }

    setLoading(true);
    showStatus("Mengambil data...", "loading");

    try {
        let result;
        if (state.source === "meteostat") {
            if (!state.selectedStation) {
                throw new Error("Pilih stasiun dulu dari daftar.");
            }
            result = await fetchMeteostat({
                station: state.selectedStation,
                startDate,
                endDate,
            });
        } else if (state.source === "power") {
            if (!state.selectedCity) {
                throw new Error("Pilih kota dulu dari saran pencarian (POWER butuh lat/lon).");
            }
            result = await fetchPower({
                city: state.selectedCity,
                startDate,
                endDate,
            });
        } else {
            if (!state.selectedCity) {
                throw new Error("Pilih kota dulu dari saran pencarian.");
            }
            result = await fetchOpenMeteo({
                city: state.selectedCity,
                startDate,
                endDate,
                timezone: els.timezone.value,
            });
        }

        state.lastResult = result;
        renderPreview(result);
        if (download) {
            exportXlsx(result);
            showStatus(
                `Berhasil. ${result.rows.length} baris diunduh sebagai Excel.`,
                "success"
            );
        } else {
            showStatus(
                `Pratinjau dimuat: ${result.rows.length} baris. Klik "Unduh Excel" untuk simpan.`,
                "info"
            );
        }
    } catch (err) {
        if (err && err.name === "AuthError") {
            // showLoginView already invoked by apiFetch.
        } else {
            console.error(err);
            showStatus(`Gagal: ${err.message}`, "error");
        }
    } finally {
        setLoading(false);
    }
}

function setLoading(loading) {
    els.previewBtn.disabled = loading;
    els.downloadBtn.disabled = loading;
    els.windroseBtn.disabled = loading;
}

function showStatus(msg, type = "info") {
    els.status.hidden = false;
    els.status.textContent = msg;
    els.status.className = `status ${type}`;
}

// ----- Open-Meteo fetch -----

async function fetchOpenMeteo({ city, startDate, endDate, timezone }) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const archiveCutoff = new Date(today);
    archiveCutoff.setDate(today.getDate() - 5);

    const start = parseLocalDate(startDate);
    const end = parseLocalDate(endDate);

    const segments = [];
    if (end < archiveCutoff) {
        segments.push({ kind: "archive", start, end });
    } else if (start >= archiveCutoff) {
        segments.push({ kind: "forecast", start, end });
    } else {
        const archiveEnd = new Date(archiveCutoff);
        archiveEnd.setDate(archiveEnd.getDate() - 1);
        segments.push({ kind: "archive", start, end: archiveEnd });
        segments.push({ kind: "forecast", start: archiveCutoff, end });
    }

    // Accumulate hourly samples keyed by local-date (YYYY-MM-DD).
    const groups = {};

    for (const seg of segments) {
        const data = await callOpenMeteo({
            kind: seg.kind,
            latitude: city.latitude,
            longitude: city.longitude,
            startDate: isoDate(seg.start),
            endDate: isoDate(seg.end),
            timezone,
        });
        const block = data.hourly;
        if (!block || !block.time) continue;
        block.time.forEach((t, i) => {
            const date = String(t).slice(0, 10);
            if (!groups[date]) {
                groups[date] = {
                    temps: [],
                    precips: [],
                    speeds: [],
                    sins: [],
                    coses: [],
                    sunshineSec: [],
                };
            }
            const g = groups[date];
            const tmp = block.temperature_2m?.[i];
            const pr = block.precipitation?.[i];
            const sp = block.wind_speed_10m?.[i];
            const dr = block.wind_direction_10m?.[i];
            const sn = block.sunshine_duration?.[i];
            if (tmp != null) g.temps.push(tmp);
            if (pr != null) g.precips.push(pr);
            if (sp != null) g.speeds.push(sp);
            if (sp != null && dr != null) {
                // Speed-weighted vector mean for wind direction so the
                // "dominant" direction reflects when wind was actually blowing
                // hard, not calm-noise samples near 0 m/s.
                const rad = (dr * Math.PI) / 180;
                g.sins.push(Math.sin(rad) * sp);
                g.coses.push(Math.cos(rad) * sp);
            }
            if (sn != null) g.sunshineSec.push(sn);
        });
    }

    const dates = Object.keys(groups).sort();
    const aggregated = dates.map((d) => aggregateOpenMeteoDay(d, groups[d]));

    const headers = [
        "Tanggal",
        ...OPENMETEO_DAILY_COLS.map((c) => `${c.label} (${c.unit})`),
    ];
    const rows = aggregated.map((a) => [
        a.date,
        ...OPENMETEO_DAILY_COLS.map((c) => a[c.key] ?? null),
    ]);

    // One windrose observation per day, using the speed-weighted dominant
    // direction and the daily mean speed. Speeds are already in m/s.
    const windRows = [];
    for (const a of aggregated) {
        const d = a.wind_direction_10m_dominant;
        const s = a.wind_speed_10m_mean;
        if (d != null && s != null) windRows.push({ dir: d, spd: s });
    }

    return {
        source: "openmeteo",
        headers,
        rows,
        windRows,
        meta: {
            kind: "openmeteo",
            city,
            startDate,
            endDate,
            granularity: "daily",
            timezone,
            sources: segments.map((s) => s.kind),
        },
    };
}

function aggregateOpenMeteoDay(date, g) {
    const sum = (a) => (a.length ? a.reduce((x, y) => x + y, 0) : null);
    const mean = (a) => (a.length ? sum(a) / a.length : null);
    const round = (v, n) => (v == null ? null : Number(v.toFixed(n)));

    let dirMean = null;
    if (g.sins.length) {
        const sx = sum(g.sins);
        const cx = sum(g.coses);
        if (sx != null && cx != null && (sx !== 0 || cx !== 0)) {
            dirMean = ((Math.atan2(sx, cx) * 180) / Math.PI + 360) % 360;
        }
    }
    return {
        date,
        temperature_2m_mean: round(mean(g.temps), 2),
        precipitation_sum: round(sum(g.precips), 2),
        wind_speed_10m_mean: round(mean(g.speeds), 2),
        wind_direction_10m_dominant: dirMean == null ? null : Math.round(dirMean),
        sunshine_duration_h: g.sunshineSec.length
            ? round(sum(g.sunshineSec) / 3600, 2)
            : null,
    };
}

function parseLocalDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
}

async function callOpenMeteo({
    kind,
    latitude,
    longitude,
    startDate,
    endDate,
    timezone,
}) {
    const base = kind === "archive" ? ARCHIVE_URL : FORECAST_URL;
    const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        start_date: startDate,
        end_date: endDate,
        timezone: timezone || "auto",
        wind_speed_unit: "ms",
        timeformat: "iso8601",
    });
    params.set("hourly", OPENMETEO_HOURLY_VARS.join(","));
    const url = `${base}?${params.toString()}`;
    const res = await apiFetch(url);
    if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try {
            const j = JSON.parse(text);
            detail = j.reason || JSON.stringify(j);
        } catch (_) {
            // detail stays as raw text
        }
        throw new Error(`Open-Meteo (${kind}) HTTP ${res.status}: ${detail}`);
    }
    return await res.json();
}

// ----- NASA POWER fetch -----

async function fetchPower({ city, startDate, endDate }) {
    // POWER daily endpoint expects YYYYMMDD strings; no time-standard.
    const compact = (s) => s.replace(/-/g, "");
    const params = new URLSearchParams({
        parameters: POWER_PARAMS.map((p) => p.key).join(","),
        community: "RE",
        longitude: String(city.longitude),
        latitude: String(city.latitude),
        start: compact(startDate),
        end: compact(endDate),
        format: "JSON",
    });
    const url = `${POWER_URL}?${params.toString()}`;
    const res = await apiFetch(url);
    if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try {
            const j = JSON.parse(text);
            detail = j.message || JSON.stringify(j.messages || j);
        } catch (_) {
            // detail stays as raw text
        }
        throw new Error(`NASA POWER HTTP ${res.status}: ${detail}`);
    }
    const data = await res.json();
    const param = data.properties && data.properties.parameter;
    if (!param) throw new Error("Respons NASA POWER tidak punya properties.parameter.");

    // Build sorted list of timestamps from the union of all parameter keys.
    const tset = new Set();
    for (const k of Object.keys(param)) {
        for (const t of Object.keys(param[k])) tset.add(t);
    }
    const times = Array.from(tset).sort();

    const headers = [
        "Tanggal (UTC)",
        ...POWER_PARAMS.map((p) => `${p.label} (${p.unit})`),
    ];
    const rows = times.map((t) => {
        const iso = powerDailyKeyToIso(t);
        return [iso, ...POWER_PARAMS.map((p) => clean(param[p.key]?.[t]))];
    });

    const windRows = [];
    for (const t of times) {
        const d = clean(param.WD10M?.[t]);
        const sMs = clean(param.WS10M?.[t]);
        if (d != null && sMs != null) {
            windRows.push({ dir: d, spd: sMs });
        }
    }

    const elev =
        data.geometry && data.geometry.coordinates && data.geometry.coordinates[2];

    return {
        source: "power",
        headers,
        rows,
        windRows,
        meta: {
            kind: "power",
            city,
            startDate,
            endDate,
            granularity: "daily",
            elevation: elev,
            sources: (data.header && data.header.sources) || [],
            apiVersion: data.header && data.header.api && data.header.api.version,
            timeStandard: "UTC",
        },
    };
}

function clean(v) {
    if (v == null) return null;
    if (typeof v === "number" && v <= POWER_FILL + 0.001) return null;
    return v;
}

function powerDailyKeyToIso(t) {
    // POWER daily keys are "YYYYMMDD" -> "YYYY-MM-DD".
    if (!/^\d{8}$/.test(t)) return t;
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

// ----- Meteostat fetch (via backend) -----

async function fetchMeteostat({ station, startDate, endDate }) {
    const url = `${BACKEND_URL}/daily/${encodeURIComponent(station.id)}` +
        `?start=${startDate}&end=${endDate}`;
    const res = await apiFetch(url);
    if (!res.ok) {
        const text = await res.text();
        let detail = text;
        try {
            const j = JSON.parse(text);
            detail = j.detail || JSON.stringify(j);
        } catch (_) {
            // detail stays as raw text
        }
        throw new Error(`Backend HTTP ${res.status}: ${detail}`);
    }
    const data = await res.json();
    // data.columns: ["time", "tavg", "tmin", ...]; data.rows: array of arrays.
    // Wind speeds are already in m/s thanks to the backend km/h -> m/s
    // conversion. Sunshine duration (`tsun`) comes back in minutes and we
    // convert to hours here. We filter the response down to the five
    // user-requested variables (tavg, prcp, wspd, wdir, tsun_h).
    const timeIdx = data.columns.indexOf("time");
    const colIdx = {};
    for (const c of METEOSTAT_DISPLAY_COLS) {
        const src = c.src === "tsun_h" ? "tsun" : c.src;
        colIdx[c.src] = data.columns.indexOf(src);
    }
    const round2 = (v) => (v == null ? null : Number(Number(v).toFixed(2)));

    const headers = [
        "Tanggal",
        ...METEOSTAT_DISPLAY_COLS.map((c) => `${c.label} (${c.unit})`),
    ];

    // Meteostat's `tsun` is frequently null for Indonesian stations because
    // most BMKG SYNOP reports omit calibrated sunshine duration. Backfill
    // those gaps from Open-Meteo ERA5 (same endpoint proxied by the backend,
    // so the same Bearer token authenticates the request).
    const tsunIdx = colIdx.tsun_h; // `tsun` column index (from backend)
    const missingDates = [];
    if (tsunIdx >= 0 && timeIdx >= 0) {
        for (const r of data.rows) {
            if (r[tsunIdx] == null) missingDates.push(r[timeIdx]);
        }
    }
    const backfill = {
        source: "open-meteo-era5",
        dates: [],
        error: null,
    };
    // Honor any server-side backfill that already happened so we don't
    // double-count when the volume-backed backend is eventually redeployed.
    if (data.tsun_backfill && Array.isArray(data.tsun_backfill.dates)) {
        backfill.dates = data.tsun_backfill.dates.slice();
    }
    if (missingDates.length > 0 && tsunIdx >= 0 && timeIdx >= 0) {
        try {
            const fill = await fetchOpenMeteoSunshine({
                lat: station.latitude,
                lon: station.longitude,
                startDate,
                endDate,
            });
            for (const r of data.rows) {
                if (r[tsunIdx] == null) {
                    const d = r[timeIdx];
                    const seconds = fill[d];
                    if (seconds != null) {
                        // Meteostat tsun is in minutes; convert seconds -> min
                        // so the downstream /60 -> hours path stays valid.
                        r[tsunIdx] = round2(seconds / 60);
                        backfill.dates.push(d);
                    }
                }
            }
        } catch (exc) {
            backfill.error = exc.message || String(exc);
        }
    }

    const rows = data.rows.map((r) => {
        const out = [timeIdx >= 0 ? r[timeIdx] : null];
        for (const c of METEOSTAT_DISPLAY_COLS) {
            const idx = colIdx[c.src];
            const raw = idx >= 0 ? r[idx] : null;
            if (c.src === "tsun_h") {
                out.push(raw == null ? null : round2(raw / 60));
            } else {
                out.push(raw == null ? null : raw);
            }
        }
        return out;
    });

    const dirIdx = data.columns.indexOf("wdir");
    const spdIdx = data.columns.indexOf("wspd");
    const windRows = [];
    if (dirIdx >= 0 && spdIdx >= 0) {
        for (const r of data.rows) {
            const d = r[dirIdx];
            const s = r[spdIdx];
            if (d != null && s != null) windRows.push({ dir: d, spd: s });
        }
    }

    return {
        source: "meteostat",
        headers,
        rows,
        windRows,
        meta: {
            kind: "meteostat",
            station,
            startDate,
            endDate,
            granularity: "daily",
            columns: data.columns,
            tsunBackfill: backfill,
        },
    };
}

// Fetch daily sunshine_duration (seconds) from Open-Meteo for a
// coordinate and date range. Splits the range between the archive
// endpoint (past) and the forecast endpoint (recent/future) based on
// today - 5 days, matching typical Open-Meteo coverage. Returns
// { "YYYY-MM-DD": seconds | null }.
async function fetchOpenMeteoSunshine({ lat, lon, startDate, endDate }) {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    const cutoff = new Date();
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - 5);

    const segments = [];
    if (start <= cutoff) {
        const segEnd = end < cutoff ? end : cutoff;
        segments.push({ url: ARCHIVE_URL, start, end: segEnd });
    }
    if (end > cutoff) {
        const segStart = start > cutoff
            ? start
            : new Date(cutoff.getTime() + 86400000);
        segments.push({ url: FORECAST_URL, start: segStart, end });
    }

    const iso = (d) => d.toISOString().slice(0, 10);
    const out = {};
    for (const seg of segments) {
        if (seg.start > seg.end) continue;
        const params = new URLSearchParams({
            latitude: String(lat),
            longitude: String(lon),
            start_date: iso(seg.start),
            end_date: iso(seg.end),
            daily: "sunshine_duration",
            timezone: "UTC",
        });
        const url = `${seg.url}?${params.toString()}`;
        const res = await apiFetch(url);
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`Open-Meteo ${res.status}: ${t.slice(0, 200)}`);
        }
        const data = await res.json();
        const times = (data.daily && data.daily.time) || [];
        const vals = (data.daily && data.daily.sunshine_duration) || [];
        for (let i = 0; i < times.length; i++) out[times[i]] = vals[i];
    }
    return out;
}

// ----- Preview -----

function renderPreview(result) {
    els.previewSection.hidden = false;
    els.previewInfo.textContent = describeResult(result);

    const table = els.previewTable;
    table.innerHTML = "";
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    result.headers.forEach((h) => {
        const th = document.createElement("th");
        th.textContent = h;
        trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    result.rows.slice(0, 50).forEach((r) => {
        const tr = document.createElement("tr");
        r.forEach((cell) => {
            const td = document.createElement("td");
            td.textContent = cell == null ? "" : cell;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
}

function describeResult(result) {
    if (result.source === "power") {
        const c = result.meta.city;
        const parts = [c.name];
        if (c.admin1) parts.push(c.admin1);
        if (c.country) parts.push(c.country);
        return (
            `Lokasi: ${parts.join(", ")} (${c.latitude.toFixed(3)}, ${c.longitude.toFixed(3)})` +
            ` · Periode: ${result.meta.startDate} → ${result.meta.endDate} (UTC)` +
            ` · Sumber: NASA POWER (${(result.meta.sources || []).join(", ") || "MERRA-2"})` +
            ` · Total baris: ${result.rows.length}`
        );
    }
    if (result.source === "meteostat") {
        const s = result.meta.station;
        const wmo = s.wmo || s.id;
        const bf = result.meta.tsunBackfill || {};
        const bfCount = Array.isArray(bf.dates) ? bf.dates.length : 0;
        const bfNote = bfCount > 0
            ? ` · Lama penyinaran: ${bfCount} hari di-backfill dari Open-Meteo ERA5`
            : "";
        return (
            `Stasiun: ${s.name} (WMO ${wmo}` +
            (s.icao ? ` / ${s.icao}` : "") +
            `) · Periode: ${result.meta.startDate} → ${result.meta.endDate}` +
            ` · Sumber: Meteostat (NOAA ISD/SYNOP, harian) · Total baris: ${result.rows.length}` +
            bfNote
        );
    }
    const c = result.meta.city;
    const parts = [c.name];
    if (c.admin1) parts.push(c.admin1);
    if (c.country) parts.push(c.country);
    return (
        `Kota: ${parts.join(", ")} · Periode: ${result.meta.startDate} → ${result.meta.endDate}` +
        ` · Granularitas: ${result.meta.granularity} · Sumber: ${result.meta.sources.join(" + ")}` +
        ` · Total baris: ${result.rows.length}`
    );
}

// ----- Excel export -----

function exportXlsx(result) {
    const wb = XLSX.utils.book_new();
    const aoa = [result.headers, ...result.rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = result.headers.map((h, idx) => {
        let max = String(h).length;
        for (let i = 0; i < Math.min(result.rows.length, 200); i++) {
            const v = result.rows[i][idx];
            if (v != null) max = Math.max(max, String(v).length);
        }
        return { wch: Math.min(max + 2, 40) };
    });
    XLSX.utils.book_append_sheet(wb, ws, "Data");

    const metaRows = buildMetaRows(result);
    const metaWs = XLSX.utils.aoa_to_sheet(metaRows);
    metaWs["!cols"] = [{ wch: 22 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, metaWs, "Info");

    const filename = buildFilename(result);
    XLSX.writeFile(wb, filename);
}

function buildMetaRows(result) {
    const variableList = [
        "1. Suhu rata-rata (°C)",
        "2. Curah hujan / presipitasi (mm)",
        "3. Kecepatan angin rata-rata (m/s)",
        "4. Arah angin dominan (°, 0–360)",
        "5. Lama penyinaran matahari (jam)",
    ].join(" | ");

    if (result.source === "power") {
        const c = result.meta.city;
        const cityParts = [c.name];
        if (c.admin1) cityParts.push(c.admin1);
        if (c.country) cityParts.push(c.country);
        return [
            ["Field", "Value"],
            ["Sumber", "NASA POWER (power.larc.nasa.gov, MERRA-2 + CERES SYN1deg)"],
            ["API version", result.meta.apiVersion || ""],
            ["Sumber asal", (result.meta.sources || []).join(", ")],
            ["Community", "RE (Renewable Energy)"],
            ["Lokasi", cityParts.join(", ")],
            ["Latitude", c.latitude],
            ["Longitude", c.longitude],
            ["Elevasi grid (m)", result.meta.elevation ?? ""],
            ["Tanggal mulai", result.meta.startDate],
            ["Tanggal akhir", result.meta.endDate],
            ["Granularitas", "daily"],
            ["Satuan kecepatan angin", "m/s"],
            ["Variabel", variableList],
            [
                "Catatan penyinaran",
                "NASA POWER tidak menyediakan kolom 'sunshine duration' langsung. " +
                    "Kolom 'Lama penyinaran' diisi dengan radiasi GHI all-sky " +
                    "(ALLSKY_SFC_SW_DWN, kWh/m²/hari) sebagai proxy energi penyinaran.",
            ],
            ["Time standard", result.meta.timeStandard || "UTC"],
            ["Diunduh pada", new Date().toISOString()],
        ];
    }
    if (result.source === "meteostat") {
        const s = result.meta.station;
        const wmo = s.wmo || s.id;
        const bf = result.meta.tsunBackfill || {};
        const bfDates = Array.isArray(bf.dates) ? bf.dates : [];
        let sunshineNote =
            "Lama penyinaran berasal dari kolom Meteostat 'tsun' (menit) " +
            "yang dikonversi ke jam (÷60).";
        if (bfDates.length > 0) {
            const shown = bfDates.slice(0, 10).join(", ");
            const more = bfDates.length > 10
                ? ` … (+${bfDates.length - 10} lainnya)`
                : "";
            sunshineNote +=
                ` ${bfDates.length} tanggal di-backfill dari Open-Meteo ERA5 ` +
                `(sunshine_duration, detik ÷ 60) karena 'tsun' Meteostat kosong: ` +
                `${shown}${more}.`;
        }
        if (bf.error) {
            sunshineNote += ` Backfill gagal sebagian: ${bf.error}.`;
        }
        return [
            ["Field", "Value"],
            ["Sumber", "Meteostat (NOAA ISD / SYNOP via bulk.meteostat.net)"],
            ["Stasiun", s.name],
            ["Kode WMO", wmo],
            ["Kode ICAO", s.icao || ""],
            ["Region", s.region || ""],
            ["Latitude", s.latitude],
            ["Longitude", s.longitude],
            ["Elevasi (m)", s.elevation],
            ["Zona waktu (stasiun)", s.timezone || ""],
            ["Tanggal mulai", result.meta.startDate],
            ["Tanggal akhir", result.meta.endDate],
            ["Granularitas", "daily"],
            ["Satuan kecepatan angin", "m/s"],
            ["Variabel", variableList],
            ["Catatan penyinaran", sunshineNote],
            ["Diunduh pada", new Date().toISOString()],
        ];
    }
    const c = result.meta.city;
    const cityParts = [c.name];
    if (c.admin1) cityParts.push(c.admin1);
    if (c.country) cityParts.push(c.country);
    return [
        ["Field", "Value"],
        ["Sumber", "Open-Meteo (open-meteo.com)"],
        ["Kota", cityParts.join(", ")],
        ["Latitude", c.latitude],
        ["Longitude", c.longitude],
        ["Zona waktu (kota)", c.timezone || ""],
        ["Zona waktu (request)", result.meta.timezone],
        ["Tanggal mulai", result.meta.startDate],
        ["Tanggal akhir", result.meta.endDate],
        ["Granularitas", result.meta.granularity],
        ["Satuan kecepatan angin", "m/s"],
        ["Variabel", variableList],
        [
            "Catatan agregasi",
            "Nilai harian dihitung dari data hourly Open-Meteo: suhu = mean, " +
                "curah hujan = sum, kecepatan angin = mean, arah angin = " +
                "speed-weighted vector mean, lama penyinaran = sum (detik) ÷ 3600.",
        ],
        ["Sumber data", result.meta.sources.join(" + ")],
        ["Diunduh pada", new Date().toISOString()],
    ];
}

function buildFilename(result) {
    const safe = (s) => String(s || "x").replace(/[^a-z0-9]+/gi, "_");
    const start = result.meta.startDate;
    const end = result.meta.endDate;
    if (result.source === "meteostat") {
        const s = result.meta.station;
        return `weather_meteostat_${safe(s.wmo || s.id)}_${start}_to_${end}.xlsx`;
    }
    if (result.source === "power") {
        return `weather_power_${safe(result.meta.city.name)}_${start}_to_${end}.xlsx`;
    }
    return `weather_${safe(result.meta.city.name)}_${start}_to_${end}_daily.xlsx`;
}

// ----- Windrose -----

const WINDROSE_DIRECTIONS = [
    { theta: "N", deg: 0 },
    { theta: "NNE", deg: 22.5 },
    { theta: "NE", deg: 45 },
    { theta: "ENE", deg: 67.5 },
    { theta: "E", deg: 90 },
    { theta: "ESE", deg: 112.5 },
    { theta: "SE", deg: 135 },
    { theta: "SSE", deg: 157.5 },
    { theta: "S", deg: 180 },
    { theta: "SSW", deg: 202.5 },
    { theta: "SW", deg: 225 },
    { theta: "WSW", deg: 247.5 },
    { theta: "W", deg: 270 },
    { theta: "WNW", deg: 292.5 },
    { theta: "NW", deg: 315 },
    { theta: "NNW", deg: 337.5 },
];
const WINDROSE_BINS = [
    { label: "0–1", min: 0, max: 1, color: "#deebf7" },
    { label: "1–3", min: 1, max: 3, color: "#9ecae1" },
    { label: "3–5", min: 3, max: 5, color: "#6baed6" },
    { label: "5–7", min: 5, max: 7, color: "#4292c6" },
    { label: "7–9", min: 7, max: 9, color: "#2171b5" },
    { label: "9–11", min: 9, max: 11, color: "#08519c" },
    { label: "11+", min: 11, max: Infinity, color: "#08306b" },
];

function showWindrose() {
    const result = state.lastResult;
    if (!result) {
        showStatus("Klik 'Pratinjau Data' dulu untuk memuat data sebelum render windrose.", "error");
        return;
    }
    if (!result.windRows || result.windRows.length === 0) {
        showStatus(
            "Data tidak punya kolom arah/kecepatan angin yang lengkap.",
            "error"
        );
        return;
    }

    const mode = state.windroseMode === "to" ? "to" : "from";
    const counts = WINDROSE_BINS.map(() =>
        WINDROSE_DIRECTIONS.map(() => 0)
    ); // [bin][direction]
    let total = 0;
    let calmCount = 0;
    for (const { dir, spd } of result.windRows) {
        const adjDir = mode === "to" ? (dir + 180) % 360 : dir;
        if (spd <= 0.5) {
            calmCount++;
            total++;
            continue;
        }
        const dirIdx = directionIndex(adjDir);
        const binIdx = binIndexFor(spd);
        counts[binIdx][dirIdx]++;
        total++;
    }

    const traces = WINDROSE_BINS.map((bin, bi) => ({
        type: "barpolar",
        name: `${bin.label} m/s`,
        r: counts[bi].map((c) => (total > 0 ? (c / total) * 100 : 0)),
        theta: WINDROSE_DIRECTIONS.map((d) => d.theta),
        marker: { color: bin.color, line: { color: "white", width: 1 } },
        hovertemplate:
            "%{theta}<br>" +
            `${bin.label} m/s<br>` +
            "%{r:.2f}% of obs<extra></extra>",
    }));

    const layout = {
        title: {
            text: windroseTitle(result, mode),
            font: { size: 14 },
        },
        font: { family: "system-ui, sans-serif" },
        polar: {
            barmode: "stack",
            bargap: 0,
            radialaxis: {
                ticksuffix: "%",
                angle: 45,
                tickfont: { size: 11 },
            },
            angularaxis: {
                direction: "clockwise",
                rotation: 90, // N at top
                tickfont: { size: 12 },
            },
        },
        legend: {
            title: { text: "Kecepatan angin (m/s)" },
            orientation: "v",
        },
        margin: { t: 60, b: 40, l: 40, r: 120 },
        showlegend: true,
    };

    Plotly.newPlot(els.windroseChart, traces, layout, {
        responsive: true,
        displaylogo: false,
        modeBarButtonsToRemove: ["lasso2d", "select2d"],
    });

    els.windroseSection.hidden = false;
    const modeLabel = mode === "to" ? "Blowing TO (arah hembusan)"
        : "Blowing FROM (asal angin, konvensi meteorologi)";
    els.windroseInfo.textContent =
        `Mode: ${modeLabel}. ` +
        `Total observasi: ${total} (calm ≤ 0.5 m/s: ${calmCount} = ` +
        `${total > 0 ? ((calmCount / total) * 100).toFixed(1) : "0"}%). ` +
        `Frekuensi tiap sektor 22.5°, dibagi per bin kecepatan.`;
    els.windroseSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function windroseTitle(result, mode) {
    const tag = mode === "to" ? "Blowing TO" : "Blowing FROM";
    if (result.source === "meteostat") {
        const s = result.meta.station;
        return (
            `Windrose (${tag}) · ${s.name} (WMO ${s.wmo || s.id})` +
            ` · ${result.meta.startDate} → ${result.meta.endDate}`
        );
    }
    if (result.source === "power") {
        const c = result.meta.city;
        return (
            `Windrose (${tag}) · ${c.name} (NASA POWER, 10 m)` +
            ` · ${result.meta.startDate} → ${result.meta.endDate}`
        );
    }
    const c = result.meta.city;
    return `Windrose (${tag}) · ${c.name} · ${result.meta.startDate} → ${result.meta.endDate}`;
}

function directionIndex(degrees) {
    // Map 0..360 to nearest of 16 cardinal sectors (each 22.5° wide).
    const norm = ((degrees % 360) + 360) % 360;
    return Math.round(norm / 22.5) % 16;
}

function binIndexFor(spd) {
    for (let i = WINDROSE_BINS.length - 1; i >= 0; i--) {
        if (spd >= WINDROSE_BINS[i].min) return i;
    }
    return 0;
}

function downloadWindrosePNG() {
    const result = state.lastResult;
    if (!result || !els.windroseChart || els.windroseSection.hidden) {
        showStatus("Tampilkan windrose dulu sebelum unduh.", "error");
        return;
    }
    const safe = (s) => String(s || "x").replace(/[^a-z0-9]+/gi, "_");
    let filename;
    if (result.source === "meteostat") {
        const s = result.meta.station;
        filename = `windrose_meteostat_${safe(s.wmo || s.id)}_${result.meta.startDate}_to_${result.meta.endDate}`;
    } else if (result.source === "power") {
        filename = `windrose_power_${safe(result.meta.city.name)}_${result.meta.startDate}_to_${result.meta.endDate}`;
    } else {
        filename = `windrose_${safe(result.meta.city.name)}_${result.meta.startDate}_to_${result.meta.endDate}`;
    }
    Plotly.downloadImage(els.windroseChart, {
        format: "png",
        width: 900,
        height: 800,
        filename,
    });
}
