// Weather Data Exporter - fetches weather data from Open-Meteo (model),
// Meteostat (Indonesian observation stations), or NASA POWER (MERRA-2
// reanalysis with solar radiation), renders a windrose, and exports to
// Excel. Every upstream call is proxied through the backend so a valid
// Bearer token is required - see the login screen.

// Use ?? (not ||) so an explicit empty string from config.js is honored.
// Empty == same-origin (the backend is a Vercel Serverless Function in
// this very deployment). Falls back to a localhost dev server only when
// APP_CONFIG is missing entirely.
const BACKEND_URL =
    (window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL !== undefined)
        ? window.APP_CONFIG.BACKEND_URL
        : "http://localhost:8001";
const IS_ADMIN_PAGE = document.body?.dataset.page === "admin";

// All three upstream sources go through the backend now; the token gate
// is enforced server-side.
const GEOCODE_URL = `${BACKEND_URL}/api/openmeteo/geocoding`;
const FORECAST_URL = `${BACKEND_URL}/api/openmeteo/forecast`;
const ARCHIVE_URL = `${BACKEND_URL}/api/openmeteo/archive`;
const POWER_URL = `${BACKEND_URL}/api/power/daily/point`;
const POWER_FILL = -999.0;

const TOKEN_STORAGE_KEY = "wde.auth.token";
const PROFILE_STORAGE_KEY = "wde.auth.profile";
const THEME_STORAGE_KEY = "wde.theme";

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
    { key: "temperature_2m_mean", label: "Suhu rata-rata", unit: "deg C" },
    { key: "precipitation_sum", label: "Curah hujan", unit: "mm" },
    { key: "wind_speed_10m_mean", label: "Kecepatan angin rata-rata", unit: "m/s" },
    { key: "wind_direction_10m_dominant", label: "Arah angin dominan", unit: "deg" },
    { key: "sunshine_duration_h", label: "Lama penyinaran matahari", unit: "jam" },
];

// Meteostat daily columns shown in the preview and Excel output. The backend
// `/daily/` response includes more fields, but we filter down to the five
// requested variables. Wind speeds (`wspd`) are already in m/s thanks to the
// backend's km/h -> m/s conversion; sunshine duration (`tsun`) comes back in
// minutes and is converted to hours on the client.
const METEOSTAT_DISPLAY_COLS = [
    { src: "tavg", label: "Suhu rata-rata", unit: "deg C" },
    { src: "prcp", label: "Curah hujan", unit: "mm" },
    { src: "wspd", label: "Kecepatan angin rata-rata", unit: "m/s" },
    { src: "wdir", label: "Arah angin dominan", unit: "deg" },
    { src: "tsun_h", label: "Lama penyinaran matahari", unit: "jam" },
];

// NASA POWER parameter metadata. Order here defines column order in the
// export. All values are daily aggregates (UTC). NASA POWER does not expose a
// direct "sunshine duration" parameter, so we report the daily all-sky GHI
// (ALLSKY_SFC_SW_DWN, kWh/m2/hari) as a solar-energy proxy and document the
// substitution in the Info sheet.
const POWER_PARAMS = [
    { key: "T2M", label: "Suhu rata-rata", unit: "deg C" },
    { key: "PRECTOTCORR", label: "Curah hujan", unit: "mm/hari" },
    { key: "WS10M", label: "Kecepatan angin rata-rata (10 m)", unit: "m/s" },
    { key: "WD10M", label: "Arah angin dominan (10 m)", unit: "deg" },
    {
        key: "ALLSKY_SFC_SW_DWN",
        label: "Radiasi GHI (proxy penyinaran)",
        unit: "kWh/m2/hari",
    },
];

const state = {
    source: "openmeteo", // "openmeteo" | "meteostat" | "power"
    selectedCity: null,
    selectedStation: null,
    // Consolidated location used by Open-Meteo & NASA POWER fetchers.
    // `mode`: how the user picked the location; `points`: 1 entry for pin/city,
    // 9 (3x3) or 25 (5x5) for area; `bbox`: [west, south, east, north] when in
    // area mode (else null); `label`: short summary for UI/Excel.
    location: null,
    locationMode: "city", // active tab: "city" | "map"
    map: null, // Leaflet map instance (lazy)
    mapMode: "pin", // "pin" | "area"
    mapLayers: { pin: null, areaRect: null, gridPoints: null, draw: null },
    stations: [],
    lastResult: null, // {headers, rows, meta, windRows: [{dir, spd}]}
    outputMode: "daily", // "daily" | "monthly"
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
    setHiddenById("login-view", false);
    setHiddenById("admin-view", true);
    setHiddenById("app-view", true);
    setHiddenById("auth-bar", true);
    if (message) showLoginStatus(message, "info");
}

function showAppView() {
    setHiddenById("login-view", true);
    setHiddenById("admin-view", true);
    setHiddenById("app-view", false);
    setHiddenById("auth-bar", false);
    refreshAuthBar();
}

function showAdminView() {
    setHiddenById("login-view", true);
    setHiddenById("app-view", true);
    setHiddenById("admin-view", false);
    setHiddenById("auth-bar", true);
    refreshAuthBar();
}

function setHiddenById(id, hidden) {
    const el = document.getElementById(id);
    if (el) el.hidden = hidden;
}

function refreshAuthBar() {
    const p = state.auth.profile;
    const lab = document.getElementById("auth-label");
    if (!p || !lab) return;
    const exp = p.expires_at ? new Date(p.expires_at) : null;
    const expStr = exp
        ? exp.toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })
        : "?";
    lab.textContent = `Login: ${p.label} - berakhir ${expStr}`;
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
    const customEl = document.getElementById("admin-new-token");
    const mode = adminTokenMode();
    if (mode === "abs" && customEl && !(customEl.value || "").trim()) {
        customEl.value = buildAbsToken();
    }
    const custom = customEl ? (customEl.value || "").trim() : "";
    if (!label) {
        showAdminStatus("Label tidak boleh kosong.", "error");
        return;
    }
    if (!custom) {
        showAdminStatus("Token belum terisi. Buat kode ABS atau isi token sendiri.", "error");
        return;
    }
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(custom)) {
        showAdminStatus(
            "Token harus 6-64 karakter (huruf, angka, '-', '_').",
            "error"
        );
        return;
    }
    showAdminStatus("Membuat token...", "loading");
    try {
        const body = { label, days };
        if (custom) body.token = custom;
        const t = await adminFetch("/api/admin/tokens", {
            method: "POST",
            body: JSON.stringify(body),
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
        if (customEl) customEl.value = mode === "abs" ? buildAbsToken() : "";
        await handleAdminRefresh();
    } catch (err) {
        showAdminStatus(`Gagal: ${err.message}`, "error");
    }
}

function adminTokenMode() {
    const checked = document.querySelector('input[name="admin-token-mode"]:checked');
    return checked ? checked.value : "abs";
}

function setupAdminTokenControls() {
    const tokenEl = document.getElementById("admin-new-token");
    const generateBtn = document.getElementById("admin-generate-token-btn");
    const help = document.getElementById("admin-token-help");
    if (!tokenEl) return;

    function refreshMode() {
        const mode = adminTokenMode();
        tokenEl.readOnly = mode === "abs";
        if (generateBtn) generateBtn.hidden = mode !== "abs";
        if (help) {
            help.textContent = mode === "abs"
                ? "Token otomatis mengikuti format ABS-Tahun-JamMenit-KodeAcak."
                : "Isi manual 6-64 karakter: huruf, angka, tanda minus, atau underscore.";
        }
        if (mode === "abs" && !tokenEl.value.trim()) {
            tokenEl.value = buildAbsToken();
        }
        if (mode === "custom") {
            tokenEl.focus();
            tokenEl.select();
        }
    }

    document.querySelectorAll('input[name="admin-token-mode"]').forEach((r) =>
        r.addEventListener("change", refreshMode)
    );
    if (generateBtn) {
        generateBtn.addEventListener("click", () => {
            tokenEl.value = buildAbsToken();
            showAdminStatus("Kode ABS baru sudah disiapkan. Klik Buat Token untuk menyimpan.", "info");
        });
    }
    refreshMode();
}

function buildAbsToken() {
    const now = new Date();
    const year = now.getFullYear();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return `ABS-${year}-${hh}${mm}-${randomTokenCode(6)}`;
}

function randomTokenCode(length) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(length);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
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
    setupThemeToggle();

    if (IS_ADMIN_PAGE) {
        showAdminView();
        setupAdminTokenControls();
        document.getElementById("admin-create-btn").addEventListener("click", handleAdminCreate);
        document.getElementById("admin-refresh-btn").addEventListener("click", handleAdminRefresh);
        document.getElementById("admin-secret").addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleAdminRefresh();
            }
        });
        return;
    }

    // Login form bindings.
    document.getElementById("login-btn").addEventListener("click", handleLoginSubmit);
    document.getElementById("login-token").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleLoginSubmit();
        }
    });
    document.getElementById("logout-btn").addEventListener("click", handleLogout);

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
    els.selectedLocation = document.getElementById("selected-location");
    els.mapCanvas = document.getElementById("map-canvas");
    els.coordinateFormat = document.getElementById("coordinate-format");
    els.coordDecimal = document.getElementById("coord-decimal");
    els.coordDms = document.getElementById("coord-dms");
    els.coordUtm = document.getElementById("coord-utm");
    els.coordApplyBtn = document.getElementById("coord-apply-btn");
    els.coordStatus = document.getElementById("coord-status");
    els.citySection = document.getElementById("city-section");
    els.stationSection = document.getElementById("station-section");
    els.stationSearch = document.getElementById("station-search");
    els.stationSelect = document.getElementById("station-select");
    els.selectedStation = document.getElementById("selected-station");
    els.startDate = document.getElementById("start-date");
    els.endDate = document.getElementById("end-date");
    els.timezone = document.getElementById("timezone");
    els.fallbackSource = document.getElementById("fallback-source");
    els.baselineBtn = document.getElementById("baseline-btn");
    els.outputMode = document.getElementById("output-mode");
    els.periodHelpOM = document.getElementById("period-help-openmeteo");
    els.periodHelpMS = document.getElementById("period-help-meteostat");
    els.periodHelpPW = document.getElementById("period-help-power");
    els.varsSection = document.getElementById("vars-section");
    els.varsHelpOM = document.getElementById("vars-help-openmeteo");
    els.varsHelpMS = document.getElementById("vars-help-meteostat");
    els.varsHelpPW = document.getElementById("vars-help-power");
    els.previewBtn = document.getElementById("preview-btn");
    els.downloadBtn = document.getElementById("download-btn");
    els.climateChartBtn = document.getElementById("climate-chart-btn");
    els.windroseBtn = document.getElementById("windrose-btn");
    els.form = document.getElementById("weather-form");
    els.status = document.getElementById("status");
    els.previewSection = document.getElementById("preview-section");
    els.previewInfo = document.getElementById("preview-info");
    els.previewTable = document.getElementById("preview-table");
    els.climateChartSection = document.getElementById("climate-chart-section");
    els.climateChartInfo = document.getElementById("climate-chart-info");
    els.climateChart = document.getElementById("climate-chart");
    els.climateChartDownload = document.getElementById("climate-chart-download");
    els.windroseSection = document.getElementById("windrose-section");
    els.windroseInfo = document.getElementById("windrose-info");
    els.windroseChart = document.getElementById("windrose-chart");
    els.windroseDownload = document.getElementById("windrose-download");
    els.windroseModeRadios = document.querySelectorAll('input[name="windrose-mode"]');

    els.startDate.value = "2016-01-01";
    els.endDate.value = "2025-12-31";

    setupSourceToggle();
    setupCityAutocomplete();
    setupStationPicker();
    setupLocationTabs();
    setupMapControls();
    setupCoordinateInput();

    if (els.baselineBtn) {
        els.baselineBtn.addEventListener("click", () => {
            els.startDate.value = "2016-01-01";
            els.endDate.value = "2025-12-31";
            showStatus("Rentang unduh data 2016 - 2025 siap dipakai.", "info");
        });
    }
    if (els.outputMode) {
        els.outputMode.addEventListener("change", () => {
            state.outputMode = els.outputMode.value || "daily";
            if (state.lastResult) renderPreview(previewResultForMode(state.lastResult));
        });
    }
    els.previewBtn.addEventListener("click", () => handleSubmit({ download: false }));
    els.form.addEventListener("submit", (e) => {
        e.preventDefault();
        handleSubmit({ download: true });
    });
    els.climateChartBtn.addEventListener("click", showClimateChart);
    els.climateChartDownload.addEventListener("click", downloadClimateChartPNG);
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

function setupThemeToggle() {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    const initial = saved === "light" || saved === "dark" ? saved : "dark";
    applyTheme(initial);
    btn.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
        applyTheme(next);
        if (state.lastResult) {
            if (els.climateChartSection && !els.climateChartSection.hidden) {
                renderClimateChart(state.lastResult, false);
            }
            if (els.windroseSection && !els.windroseSection.hidden) showWindrose();
        }
    });
}

function applyTheme(theme) {
    const value = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = value;
    localStorage.setItem(THEME_STORAGE_KEY, value);
    const btn = document.getElementById("theme-toggle");
    const label = document.getElementById("theme-label");
    const icon = btn?.querySelector(".theme-icon");
    if (btn) btn.setAttribute("aria-pressed", value === "light" ? "true" : "false");
    if (label) label.textContent = value === "light" ? "Terang" : "Gelap";
    if (icon) icon.textContent = value === "light" ? "☼" : "☾";
}

function currentChartTheme() {
    const light = document.documentElement.dataset.theme === "light";
    return light
        ? {
            text: "#0f172a",
            paper: "#ffffff",
            plot: "#ffffff",
            grid: "#e2e8f0",
            axis: "#64748b",
            accent: "#0f766e",
            line: "#1e3a8a",
        }
        : {
            text: "#fafafa",
            paper: "rgba(24, 24, 27, 0)",
            plot: "rgba(15, 15, 17, 0.35)",
            grid: "rgba(255, 255, 255, 0.10)",
            axis: "#a1a1aa",
            accent: "#10b981",
            line: "#60a5fa",
        };
}

function isoDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function addDaysIso(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
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
    applyDateBoundsForSource();
}

// ----- City autocomplete (Open-Meteo) -----

function setupCityAutocomplete() {
    let debounceTimer = null;
    let activeIndex = -1;

    els.cityInput.addEventListener("input", () => {
        const q = els.cityInput.value.trim();
        state.selectedCity = null;
        if (state.location && state.location.mode === "city") {
            state.location = null;
        }
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
                - ${r.latitude.toFixed(3)}, ${r.longitude.toFixed(3)}</span>`;
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
        // City autocomplete is the active picker to mirror into state.location
        // so the unified fetch path treats it like a 1-point pin.
        state.location = {
            mode: "city",
            label: parts.join(", "),
            points: [{
                latitude: r.latitude,
                longitude: r.longitude,
                name: r.name,
                admin1: r.admin1,
                country: r.country,
                timezone: r.timezone,
            }],
            bbox: null,
            gridSize: 1,
            timezone: r.timezone || null,
        };
        state.locationMode = "city";
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
        const inv = s.hourly_end ? ` - hourly ${s.hourly_start} to ${s.hourly_end}` : "";
        opt.textContent = `${wmo}${icao} - ${s.name}${inv}`;
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
    applyDateBoundsForSource();
}

function applyDateBoundsForSource() {
    if (!els.startDate || !els.endDate) return;
    if (state.source !== "meteostat" || !state.selectedStation) {
        els.startDate.removeAttribute("min");
        els.startDate.removeAttribute("max");
        els.endDate.removeAttribute("min");
        els.endDate.removeAttribute("max");
        return;
    }

    const s = state.selectedStation;
    const min = s.hourly_start || "";
    const max = s.hourly_end || "";
    if (min) {
        els.startDate.min = min;
        els.endDate.min = min;
    }
    if (max) {
        els.startDate.max = max;
        els.endDate.max = max;
        if (els.endDate.value > max) els.endDate.value = max;
        if (els.startDate.value > max) els.startDate.value = addDaysIso(max, -7);
    }
    if (min && els.startDate.value < min) els.startDate.value = min;
    if (els.startDate.value > els.endDate.value) els.startDate.value = els.endDate.value;
}

// ----- Map picker (Leaflet, for Open-Meteo & NASA POWER) -----

function setupLocationTabs() {
    const tabs = document.querySelectorAll('#city-section .tab');
    tabs.forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab; // "city-name" | "city-map"
            tabs.forEach((b) => {
                const active = b === btn;
                b.classList.toggle('active', active);
                b.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            const namePanel = document.getElementById('city-tab-name');
            const mapPanel = document.getElementById('city-tab-map');
            if (target === 'city-map') {
                namePanel.hidden = true;
                mapPanel.hidden = false;
                state.locationMode = 'map';
                ensureMap();
            } else {
                namePanel.hidden = false;
                mapPanel.hidden = true;
                state.locationMode = 'city';
            }
        });
    });
}

function setupMapControls() {
    const radios = document.querySelectorAll('input[name="map-mode"]');
    radios.forEach((r) =>
        r.addEventListener('change', () => {
            state.mapMode = r.value;
            applyMapMode();
        })
    );
    const clearBtn = document.getElementById('map-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => clearMapSelection());
    }
}

function setupCoordinateInput() {
    if (!els.coordinateFormat || !els.coordApplyBtn) return;
    const refresh = () => {
        const format = els.coordinateFormat.value || "decimal";
        if (els.coordDecimal) els.coordDecimal.hidden = format !== "decimal";
        if (els.coordDms) els.coordDms.hidden = format !== "dms";
        if (els.coordUtm) els.coordUtm.hidden = format !== "utm";
        if (els.coordStatus) els.coordStatus.textContent = "";
    };
    els.coordinateFormat.addEventListener("change", refresh);
    els.coordApplyBtn.addEventListener("click", applyManualCoordinate);
    refresh();
}

function applyManualCoordinate() {
    try {
        const format = els.coordinateFormat?.value || "decimal";
        const point = format === "dms"
            ? coordinateFromDms()
            : format === "utm"
                ? coordinateFromUtm()
                : coordinateFromDecimal();
        validateLatLon(point);
        ensureMap();
        setTimeout(() => {
            setPin(point.lat, point.lon);
            if (state.map) state.map.setView([point.lat, point.lon], 16);
            if (els.coordStatus) {
                els.coordStatus.textContent =
                    `Koordinat diterapkan: ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}.`;
            }
        }, state.map ? 0 : 250);
    } catch (err) {
        if (els.coordStatus) els.coordStatus.textContent = err.message || "Koordinat tidak valid.";
        showStatus(err.message || "Koordinat tidak valid.", "error");
    }
}

function coordinateFromDecimal() {
    const lat = numberFromInput("coord-lat", "Lintang wajib diisi.");
    const lon = numberFromInput("coord-lon", "Bujur wajib diisi.");
    return { lat, lon };
}

function coordinateFromDms() {
    const lat = dmsToDecimal(
        numberFromInput("coord-lat-deg", "Derajat lintang wajib diisi."),
        numberFromInput("coord-lat-min", "Menit lintang wajib diisi."),
        numberFromInput("coord-lat-sec", "Detik lintang wajib diisi."),
        document.getElementById("coord-lat-hemi")?.value || "S"
    );
    const lon = dmsToDecimal(
        numberFromInput("coord-lon-deg", "Derajat bujur wajib diisi."),
        numberFromInput("coord-lon-min", "Menit bujur wajib diisi."),
        numberFromInput("coord-lon-sec", "Detik bujur wajib diisi."),
        document.getElementById("coord-lon-hemi")?.value || "E"
    );
    return { lat, lon };
}

function coordinateFromUtm() {
    const zone = numberFromInput("coord-utm-zone", "Zona UTM wajib diisi.");
    const easting = numberFromInput("coord-utm-easting", "Easting wajib diisi.");
    const northing = numberFromInput("coord-utm-northing", "Northing wajib diisi.");
    const hemi = document.getElementById("coord-utm-hemi")?.value || "S";
    return utmToLatLon(easting, northing, zone, hemi);
}

function numberFromInput(id, message) {
    const raw = document.getElementById(id)?.value;
    const value = Number(String(raw || "").replace(",", "."));
    if (!Number.isFinite(value)) throw new Error(message);
    return value;
}

function validateLatLon(latlon) {
    if (!latlon || !Number.isFinite(latlon.lat) || !Number.isFinite(latlon.lon)) {
        throw new Error("Koordinat tidak valid.");
    }
    if (latlon.lat < -90 || latlon.lat > 90) {
        throw new Error("Lintang harus berada antara -90 sampai 90.");
    }
    if (latlon.lon < -180 || latlon.lon > 180) {
        throw new Error("Bujur harus berada antara -180 sampai 180.");
    }
}

function dmsToDecimal(degrees, minutes, seconds, hemisphere) {
    if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
        throw new Error("Nilai menit dan detik DMS harus berada antara 0 sampai kurang dari 60.");
    }
    const sign = /S|W/i.test(hemisphere) ? -1 : 1;
    return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
}

function utmToLatLon(easting, northing, zone, hemisphere) {
    if (zone < 1 || zone > 60) throw new Error("Zona UTM harus berada antara 1 sampai 60.");
    const a = 6378137.0;
    const eccSquared = 0.00669438;
    const k0 = 0.9996;
    const eccPrimeSquared = eccSquared / (1 - eccSquared);
    const e1 = (1 - Math.sqrt(1 - eccSquared)) / (1 + Math.sqrt(1 - eccSquared));

    const x = easting - 500000.0;
    let y = northing;
    if (String(hemisphere).toUpperCase() === "S") y -= 10000000.0;

    const longOrigin = (zone - 1) * 6 - 180 + 3;
    const m = y / k0;
    const mu = m / (a * (1 - eccSquared / 4 - (3 * eccSquared ** 2) / 64 - (5 * eccSquared ** 3) / 256));
    const phi1Rad = mu
        + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
        + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
        + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
        + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

    const n1 = a / Math.sqrt(1 - eccSquared * Math.sin(phi1Rad) ** 2);
    const t1 = Math.tan(phi1Rad) ** 2;
    const c1 = eccPrimeSquared * Math.cos(phi1Rad) ** 2;
    const r1 = a * (1 - eccSquared) / ((1 - eccSquared * Math.sin(phi1Rad) ** 2) ** 1.5);
    const d = x / (n1 * k0);

    const latRad = phi1Rad - (n1 * Math.tan(phi1Rad) / r1) * (
        (d ** 2) / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * eccPrimeSquared) * (d ** 4) / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * eccPrimeSquared - 3 * c1 ** 2) * (d ** 6) / 720
    );
    const lonRad = (
        d
        - (1 + 2 * t1 + c1) * (d ** 3) / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * eccPrimeSquared + 24 * t1 ** 2) * (d ** 5) / 120
    ) / Math.cos(phi1Rad);

    return {
        lat: latRad * 180 / Math.PI,
        lon: longOrigin + lonRad * 180 / Math.PI,
    };
}

function ensureMap() {
    // Lazy init: Leaflet may not be ready when the page is constructed (it's
    // loaded with `defer`), and the map div has 0 height until visible.
    if (state.map) {
        // Make sure Leaflet recomputes container size after the panel becomes
        // visible (otherwise tiles render gray).
        setTimeout(() => state.map.invalidateSize(), 50);
        return;
    }
    if (typeof L === 'undefined') {
        // Leaflet still loading - try again shortly.
        setTimeout(ensureMap, 200);
        return;
    }
    const map = L.map('map-canvas', {
        center: [-2.5, 117.0], // tengah Indonesia
        zoom: 5,
        worldCopyJump: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(map);

    state.map = map;
    state.mapLayers.draw = L.featureGroup().addTo(map);

    map.on('click', (e) => {
        if (state.mapMode === 'pin') {
            setPin(e.latlng.lat, e.latlng.lng);
        }
        // In area mode the click is intentionally ignored - user must use
        // the rectangle draw control in the top-left corner instead.
    });

    applyMapMode();
    setTimeout(() => map.invalidateSize(), 50);
}

function applyMapMode() {
    if (!state.map) return;
    // Clear any active draw control so we can rebuild for the new mode.
    if (state.mapLayers.drawControl) {
        state.map.removeControl(state.mapLayers.drawControl);
        state.mapLayers.drawControl = null;
    }
    if (state.mapMode === 'area') {
        // Show a rectangle-only Leaflet.draw toolbar.
        if (typeof L === 'undefined' || !L.Control.Draw) return;
        const drawControl = new L.Control.Draw({
            position: 'topleft',
            draw: {
                polyline: false,
                polygon: false,
                circle: false,
                circlemarker: false,
                marker: false,
                rectangle: {
                    shapeOptions: {
                        color: '#2563eb',
                        weight: 2,
                        fillOpacity: 0.08,
                    },
                    showArea: false,
                },
            },
            edit: false,
        });
        state.map.addControl(drawControl);
        state.mapLayers.drawControl = drawControl;
        state.map.off(L.Draw.Event.CREATED).on(L.Draw.Event.CREATED, (e) => {
            if (e.layerType !== 'rectangle') return;
            const b = e.layer.getBounds();
            setArea(
                b.getWest(),
                b.getSouth(),
                b.getEast(),
                b.getNorth()
            );
        });
    }
    // In pin mode there's no draw control - clicks on the map handle it.
}

function clearMapSelection() {
    if (!state.map) return;
    if (state.mapLayers.pin) {
        state.map.removeLayer(state.mapLayers.pin);
        state.mapLayers.pin = null;
    }
    if (state.mapLayers.areaRect) {
        state.map.removeLayer(state.mapLayers.areaRect);
        state.mapLayers.areaRect = null;
    }
    if (state.mapLayers.gridPoints) {
        state.map.removeLayer(state.mapLayers.gridPoints);
        state.mapLayers.gridPoints = null;
    }
    if (state.mapLayers.draw) state.mapLayers.draw.clearLayers();
    state.location = null;
    state.selectedCity = null;
    if (els.selectedLocation) {
        els.selectedLocation.textContent =
            'Belum ada lokasi yang dipilih di peta.';
    }
}

function setPin(lat, lon) {
    if (!state.map) return;
    if (state.mapLayers.pin) state.map.removeLayer(state.mapLayers.pin);
    if (state.mapLayers.areaRect) {
        state.map.removeLayer(state.mapLayers.areaRect);
        state.mapLayers.areaRect = null;
    }
    if (state.mapLayers.gridPoints) {
        state.map.removeLayer(state.mapLayers.gridPoints);
        state.mapLayers.gridPoints = null;
    }
    if (state.mapLayers.draw) state.mapLayers.draw.clearLayers();

    const marker = L.marker([lat, lon], { draggable: true }).addTo(state.map);
    marker.on('dragend', () => {
        const ll = marker.getLatLng();
        commitPin(ll.lat, ll.lng);
    });
    state.mapLayers.pin = marker;
    commitPin(lat, lon);
}

function commitPin(lat, lon) {
    const label = `Pin: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    state.location = {
        mode: 'pin',
        label,
        points: [{ latitude: lat, longitude: lon }],
        bbox: null,
        gridSize: 1,
        timezone: null,
    };
    state.selectedCity = {
        name: `Pin (${lat.toFixed(4)}, ${lon.toFixed(4)})`,
        latitude: lat,
        longitude: lon,
    };
    state.locationMode = 'map';
    if (els.selectedLocation) {
        els.selectedLocation.innerHTML =
            `Terpilih: <strong>${escapeHtml(label)}</strong> ` +
            `<span class="muted">(geser marker untuk update; klik di peta untuk pindah)</span>`;
    }
}

function setArea(west, south, east, north) {
    if (!state.map || typeof L === 'undefined') return;
    if (state.mapLayers.pin) {
        state.map.removeLayer(state.mapLayers.pin);
        state.mapLayers.pin = null;
    }
    if (state.mapLayers.areaRect) {
        state.map.removeLayer(state.mapLayers.areaRect);
    }
    if (state.mapLayers.gridPoints) {
        state.map.removeLayer(state.mapLayers.gridPoints);
    }
    if (state.mapLayers.draw) state.mapLayers.draw.clearLayers();

    // Auto pick grid resolution from bbox span. Larger areas to 5x5 to
    // sample more grid cells; small ones to 3x3 to stay light.
    const span = Math.max(Math.abs(east - west), Math.abs(north - south));
    const gridSize = span >= 1.0 ? 5 : 3;

    const points = [];
    // Sample the *interior* of the rectangle (skip the edges) so all
    // points fall inside the user's drawn area.
    for (let i = 0; i < gridSize; i++) {
        for (let j = 0; j < gridSize; j++) {
            const fx = (i + 1) / (gridSize + 1);
            const fy = (j + 1) / (gridSize + 1);
            const lon = west + fx * (east - west);
            const lat = south + fy * (north - south);
            points.push({
                latitude: Number(lat.toFixed(4)),
                longitude: Number(lon.toFixed(4)),
            });
        }
    }

    const rect = L.rectangle(
        [
            [south, west],
            [north, east],
        ],
        {
            color: '#2563eb',
            weight: 2,
            fillOpacity: 0.08,
        }
    ).addTo(state.map);
    state.mapLayers.areaRect = rect;

    const dotLayer = L.layerGroup().addTo(state.map);
    points.forEach((p, i) => {
        L.circleMarker([p.latitude, p.longitude], {
            radius: 4,
            color: '#2563eb',
            weight: 1,
            fillColor: '#2563eb',
            fillOpacity: 0.6,
        })
            .addTo(dotLayer)
            .bindTooltip(
                `Titik #${i + 1}: ${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`
            );
    });
    state.mapLayers.gridPoints = dotLayer;

    const fmt = (v) => Number(v).toFixed(3);
    const label =
        `Area ${fmt(south)}-${fmt(north)} LU/LS, ${fmt(west)}-${fmt(east)} BB/BT ` +
        `(grid ${gridSize}x${gridSize}, ${points.length} titik)`;

    state.location = {
        mode: 'area',
        label,
        points,
        bbox: [west, south, east, north],
        gridSize,
        timezone: null,
    };
    state.selectedCity = {
        name: `Area ${gridSize}x${gridSize}`,
        latitude: points[0].latitude,
        longitude: points[0].longitude,
    };
    state.locationMode = 'map';
    if (els.selectedLocation) {
        els.selectedLocation.innerHTML =
            `Terpilih: <strong>${escapeHtml(label)}</strong>`;
    }
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
    if (state.source === "meteostat" && state.selectedStation?.hourly_end && endDate > state.selectedStation.hourly_end) {
        showStatus(
            `Data Meteostat untuk stasiun ini tersedia sampai ${state.selectedStation.hourly_end}. ` +
            "Tanggal akhir sudah dibatasi mengikuti stasiun yang dipilih.",
            "error"
        );
        els.endDate.value = state.selectedStation.hourly_end;
        return;
    }

    setLoading(true, download);
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
            if (!state.location) {
                throw new Error(
                    "Pilih lokasi dulu (cari kota atau klik di peta) - POWER butuh lat/lon."
                );
            }
            result = await fetchPower({
                location: state.location,
                startDate,
                endDate,
            });
        } else {
            if (!state.location) {
                throw new Error(
                    "Pilih lokasi dulu (cari kota atau klik di peta)."
                );
            }
            result = await fetchOpenMeteo({
                location: state.location,
                startDate,
                endDate,
                timezone: els.timezone.value,
            });
        }

        if (result.rows.length === 0) {
            state.lastResult = result;
            renderPreview(result);
            showStatus(emptyResultMessage(result), "error");
            return;
        }
        state.lastResult = result;
        const previewResult = previewResultForMode(result);
        renderPreview(previewResult);
        renderClimateChart(result);
        if (download) {
            exportXlsx(result, getOutputMode());
            const rowLabel = getOutputMode() === "monthly"
                ? `${previewResult.rows.length} baris rekap bulanan`
                : `${result.rows.length} baris harian`;
            showStatus(
                `Berhasil. ${rowLabel} diunduh sebagai Excel.`,
                "success"
            );
        } else {
            const rowLabel = getOutputMode() === "monthly"
                ? `${previewResult.rows.length} baris rekap bulanan`
                : `${result.rows.length} baris`;
            showStatus(
                `Pratinjau dimuat: ${rowLabel}. Klik "Unduh Excel" untuk simpan.`,
                "info"
            );
        }
    } catch (err) {
        if (err && err.name === "AuthError") {
            // showLoginView already invoked by apiFetch.
        } else {
            console.error(err);
            showStatus(`Gagal: ${friendlyErrorMessage(err)}`, "error");
        }
    } finally {
        setLoading(false, download);
    }
}

function setLoading(loading, download = false) {
    if (!els.previewBtn || !els.downloadBtn || !els.windroseBtn) return;
    if (!els.previewBtn.dataset.idleText) {
        els.previewBtn.dataset.idleText = els.previewBtn.textContent;
        els.downloadBtn.dataset.idleText = els.downloadBtn.textContent;
    }
    els.previewBtn.disabled = loading;
    els.downloadBtn.disabled = loading;
    if (els.climateChartBtn) els.climateChartBtn.disabled = loading;
    els.windroseBtn.disabled = loading;
    els.previewBtn.textContent = loading && !download
        ? "Memuat..."
        : els.previewBtn.dataset.idleText;
    els.downloadBtn.textContent = loading && download
        ? "Menyiapkan Excel..."
        : els.downloadBtn.dataset.idleText;
}

function showStatus(msg, type = "info") {
    els.status.hidden = false;
    els.status.textContent = msg;
    els.status.className = `status ${type}`;
}

function emptyResultMessage(result) {
    if (result.source === "meteostat") {
        const s = result.meta.station;
        const end = s.hourly_end ? ` Data stasiun tersedia sampai ${s.hourly_end}.` : "";
        return `Tidak ada data Meteostat untuk ${s.name} pada periode ${result.meta.startDate} sampai ${result.meta.endDate}.${end} Coba periode lain atau pilih stasiun berbeda.`;
    }
    return `Tidak ada data untuk periode ${result.meta.startDate} sampai ${result.meta.endDate}. Coba lokasi atau tanggal lain.`;
}

function friendlyErrorMessage(err) {
    const msg = err?.message || String(err);
    if (msg.includes("Range too large")) {
        return "Rentang tanggal terlalu panjang. Maksimal 366 hari per permintaan.";
    }
    if (msg.includes("Unknown station")) {
        return "Stasiun tidak dikenali oleh backend. Pilih stasiun dari daftar, bukan mengetik kode manual.";
    }
    if (msg.includes("Invalid or expired token")) {
        return "Token tidak valid atau sudah kedaluwarsa. Silakan login ulang dengan token aktif.";
    }
    if (msg.includes("Backend HTTP")) {
        return msg.replace(/^Backend HTTP \d+:\s*/, "");
    }
    return msg;
}

// ----- Open-Meteo fetch -----

async function fetchOpenMeteo({ location, startDate, endDate, timezone }) {
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

    // Accumulate hourly samples keyed by local-date (YYYY-MM-DD). For area
    // mode we fetch each grid point and pour all hourly samples into the
    // same per-day buckets - the daily mean across N points x 24 h ~
    // spatial+temporal mean for the day.
    const groups = {};
    const points = location.points;

    for (let pi = 0; pi < points.length; pi++) {
        const pt = points[pi];
        for (const seg of segments) {
            const data = await callOpenMeteo({
                kind: seg.kind,
                latitude: pt.latitude,
                longitude: pt.longitude,
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
                    // "dominant" direction reflects when wind was actually
                    // blowing hard, not calm-noise samples near 0 m/s.
                    const rad = (dr * Math.PI) / 180;
                    g.sins.push(Math.sin(rad) * sp);
                    g.coses.push(Math.cos(rad) * sp);
                }
                if (sn != null) g.sunshineSec.push(sn);
            });
        }
    }

    const dates = Object.keys(groups).sort();
    const aggregated = dates.map((d) =>
        aggregateOpenMeteoDay(d, groups[d], points.length)
    );

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
            city: location.points[0], // backward compat for filename/UI helpers
            location,
            startDate,
            endDate,
            granularity: "daily",
            timezone,
            sources: segments.map((s) => s.kind),
        },
    };
}

function aggregateOpenMeteoDay(date, g, nPoints = 1) {
    const sum = (a) => (a.length ? a.reduce((x, y) => x + y, 0) : null);
    const mean = (a) => (a.length ? sum(a) / a.length : null);
    const round = (v, n) => (v == null ? null : Number(v.toFixed(n)));
    // For multi-point (area) mode, hourly samples are pooled across N grid
    // points, so a naive sum() over the day's bucket double-counts by N.
    // Divide totals by N to recover the spatial mean of the daily total.
    const np = Math.max(1, nPoints);

    let dirMean = null;
    if (g.sins.length) {
        const sx = sum(g.sins);
        const cx = sum(g.coses);
        if (sx != null && cx != null && (sx !== 0 || cx !== 0)) {
            dirMean = ((Math.atan2(sx, cx) * 180) / Math.PI + 360) % 360;
        }
    }
    const precipTotal = sum(g.precips);
    const sunshineSecTotal = sum(g.sunshineSec);
    return {
        date,
        temperature_2m_mean: round(mean(g.temps), 2),
        precipitation_sum:
            precipTotal == null ? null : round(precipTotal / np, 2),
        wind_speed_10m_mean: round(mean(g.speeds), 2),
        wind_direction_10m_dominant: dirMean == null ? null : Math.round(dirMean),
        sunshine_duration_h:
            sunshineSecTotal == null
                ? null
                : round(sunshineSecTotal / np / 3600, 2),
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

async function fetchPower({ location, startDate, endDate }) {
    // POWER daily endpoint expects YYYYMMDD strings; no time-standard.
    const compact = (s) => s.replace(/-/g, "");
    const points = location.points;

    // Per-day buckets across N grid points. For each timestamp we accumulate
    // the value at every point; later we average (or vector-mean for wind).
    // Speed-weighted vector mean for wind direction so the dominant
    // direction across the area reflects when the wind was actually blowing.
    const buckets = {};
    let elev = null;
    let apiVersion = null;
    let sources = [];

    for (const pt of points) {
        const params = new URLSearchParams({
            parameters: POWER_PARAMS.map((p) => p.key).join(","),
            community: "RE",
            longitude: String(pt.longitude),
            latitude: String(pt.latitude),
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
        if (!param) {
            throw new Error("Respons NASA POWER tidak punya properties.parameter.");
        }

        if (apiVersion == null) {
            apiVersion = data.header && data.header.api && data.header.api.version;
            sources = (data.header && data.header.sources) || [];
            elev =
                data.geometry &&
                data.geometry.coordinates &&
                data.geometry.coordinates[2];
        }

        const tset = new Set();
        for (const k of Object.keys(param)) {
            for (const t of Object.keys(param[k])) tset.add(t);
        }
        for (const t of tset) {
            if (!buckets[t]) {
                buckets[t] = {
                    T2M: [],
                    PRECTOTCORR: [],
                    WS10M: [],
                    GHI: [],
                    sins: [],
                    coses: [],
                };
            }
            const b = buckets[t];
            const tmp = clean(param.T2M?.[t]);
            const pr = clean(param.PRECTOTCORR?.[t]);
            const sp = clean(param.WS10M?.[t]);
            const dr = clean(param.WD10M?.[t]);
            const ghi = clean(param.ALLSKY_SFC_SW_DWN?.[t]);
            if (tmp != null) b.T2M.push(tmp);
            if (pr != null) b.PRECTOTCORR.push(pr);
            if (sp != null) b.WS10M.push(sp);
            if (sp != null && dr != null) {
                const rad = (dr * Math.PI) / 180;
                b.sins.push(Math.sin(rad) * sp);
                b.coses.push(Math.cos(rad) * sp);
            }
            if (ghi != null) b.GHI.push(ghi);
        }
    }

    const times = Object.keys(buckets).sort();
    const sum = (a) => (a.length ? a.reduce((x, y) => x + y, 0) : null);
    const mean = (a) => (a.length ? sum(a) / a.length : null);
    const round = (v, n) => (v == null ? null : Number(v.toFixed(n)));

    const headers = [
        "Tanggal (UTC)",
        ...POWER_PARAMS.map((p) => `${p.label} (${p.unit})`),
    ];
    const rows = [];
    const windRows = [];
    for (const t of times) {
        const b = buckets[t];
        const iso = powerDailyKeyToIso(t);
        let dirMean = null;
        if (b.sins.length) {
            const sx = sum(b.sins);
            const cx = sum(b.coses);
            if (sx != null && cx != null && (sx !== 0 || cx !== 0)) {
                dirMean =
                    ((Math.atan2(sx, cx) * 180) / Math.PI + 360) % 360;
            }
        }
        const tmp = round(mean(b.T2M), 2);
        const pr = round(mean(b.PRECTOTCORR), 2);
        const sp = round(mean(b.WS10M), 2);
        const drRound = dirMean == null ? null : Math.round(dirMean);
        const gh = round(mean(b.GHI), 2);
        rows.push([iso, tmp, pr, sp, drRound, gh]);
        if (drRound != null && sp != null) windRows.push({ dir: drRound, spd: sp });
    }

    return {
        source: "power",
        headers,
        rows,
        windRows,
        meta: {
            kind: "power",
            city: location.points[0], // backward compat for filename/UI helpers
            location,
            startDate,
            endDate,
            granularity: "daily",
            elevation: elev,
            sources,
            apiVersion,
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

    if (rows.length === 0 && els.fallbackSource?.value && els.fallbackSource.value !== "none") {
        return fetchMeteostatReanalysisFallback({
            station,
            startDate,
            endDate,
            fallbackSource: els.fallbackSource.value,
        });
    }

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
            dailyFallback: data.fallback || null,
            rowSources: data.row_sources || [],
            sourceCounts: data.source_counts || {},
            coverage: buildCoverage({
                startDate,
                endDate,
                rows,
                rowSources: data.row_sources || [],
            }),
            tsunBackfill: backfill,
        },
    };
}

async function fetchMeteostatReanalysisFallback({ station, startDate, endDate, fallbackSource }) {
    const location = {
        mode: "station-fallback",
        label: `${station.name} (fallback reanalysis/model)`,
        points: [{
            name: station.name,
            latitude: station.latitude,
            longitude: station.longitude,
            timezone: station.timezone,
        }],
        bbox: null,
        gridSize: 1,
    };
    const base = fallbackSource === "power"
        ? await fetchPower({ location, startDate, endDate })
        : await fetchOpenMeteo({
            location,
            startDate,
            endDate,
            timezone: station.timezone || "UTC",
        });
    const sourceName = fallbackSource === "power"
        ? "nasa_power_reanalysis"
        : "openmeteo_era5_reanalysis";
    return {
        ...base,
        source: "meteostat",
        meta: {
            ...base.meta,
            kind: "meteostat",
            station,
            startDate,
            endDate,
            granularity: "daily",
            reanalysisFallback: fallbackSource === "power"
                ? "NASA POWER"
                : "Open-Meteo ERA5",
            rowSources: base.rows.map(() => sourceName),
            sourceCounts: { [sourceName]: base.rows.length },
            coverage: buildCoverage({
                startDate,
                endDate,
                rows: base.rows,
                rowSources: base.rows.map(() => sourceName),
            }),
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

const MONTH_LABELS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "Mei",
    "Jun",
    "Jul",
    "Agst",
    "Sept",
    "Okt",
    "Nov",
    "Des",
];

function getOutputMode() {
    return els.outputMode?.value || state.outputMode || "daily";
}

function previewResultForMode(result) {
    return getOutputMode() === "monthly" ? buildMonthlyResult(result) : result;
}

function buildMonthlyResult(result) {
    const monthly = buildMonthlyAggregation(result);
    return {
        ...result,
        headers: [
            "Tahun",
            "Bulan",
            ...monthly.metrics.map((m) => m.header),
        ],
        rows: monthly.longRows,
        meta: {
            ...result.meta,
            granularity: "monthly",
            outputMode: "monthly",
        },
    };
}

function buildMonthlyAggregation(result) {
    const metrics = result.headers.slice(1).map((header, i) => ({
        header,
        index: i + 1,
        sheetName: monthlySheetName(header),
    }));
    const speedMetric = metrics.find((m) =>
        /kecepatan angin/i.test(m.header)
    );
    const directionMetric = metrics.find((m) =>
        /arah angin/i.test(m.header)
    );
    const buckets = new Map();

    for (const row of result.rows) {
        const date = String(row[0] || "");
        if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
        const year = date.slice(0, 4);
        const month = date.slice(5, 7);
        const key = `${year}-${month}`;
        if (!buckets.has(key)) {
            buckets.set(key, {
                year,
                month,
                values: metrics.map(() => []),
                dirSin: 0,
                dirCos: 0,
                dirCount: 0,
            });
        }
        const bucket = buckets.get(key);
        const speed = speedMetric ? toNumber(row[speedMetric.index]) : null;
        for (const metric of metrics) {
            const value = toNumber(row[metric.index]);
            if (value == null) continue;
            if (metric === directionMetric) {
                const weight = speed == null || speed <= 0 ? 1 : speed;
                const rad = (value * Math.PI) / 180;
                bucket.dirSin += Math.sin(rad) * weight;
                bucket.dirCos += Math.cos(rad) * weight;
                bucket.dirCount += 1;
            } else {
                bucket.values[metric.index - 1].push(value);
            }
        }
    }

    const years = Array.from(new Set([...buckets.values()].map((b) => b.year))).sort();
    const rowsByKey = new Map();
    const longRows = [];
    for (const bucket of [...buckets.values()].sort((a, b) =>
        a.year === b.year
            ? Number(a.month) - Number(b.month)
            : Number(a.year) - Number(b.year)
    )) {
        const values = metrics.map((metric) => {
            if (metric === directionMetric) {
                if (!bucket.dirCount || (bucket.dirSin === 0 && bucket.dirCos === 0)) {
                    return null;
                }
                return roundMonthly(
                    ((Math.atan2(bucket.dirSin, bucket.dirCos) * 180) / Math.PI + 360) % 360,
                    metric.header
                );
            }
            return roundMonthly(mean(bucket.values[metric.index - 1]), metric.header);
        });
        const key = `${bucket.year}-${bucket.month}`;
        rowsByKey.set(key, values);
        longRows.push([
            bucket.year,
            MONTH_LABELS[Number(bucket.month) - 1],
            ...values,
        ]);
    }

    return { metrics, years, rowsByKey, longRows };
}

function buildCoverage({ startDate, endDate, rows, rowSources = [] }) {
    const expectedDates = dateRangeIso(startDate, endDate);
    const expected = expectedDates.length;
    const dates = new Set(rows.map((row) => row[0]).filter(Boolean));
    const available = dates.size;
    const missingByYear = {};
    for (const date of expectedDates) {
        if (!dates.has(date)) {
            const year = date.slice(0, 4);
            missingByYear[year] = (missingByYear[year] || 0) + 1;
        }
    }
    const sourceCounts = {};
    rowSources.forEach((source) => {
        if (!source) return;
        sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    });
    return {
        expected,
        available,
        percent: expected ? Number(((available / expected) * 100).toFixed(1)) : 0,
        missingByYear,
        sourceCounts,
    };
}

function dateRangeIso(startDate, endDate) {
    const out = [];
    const cur = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    while (cur <= end) {
        out.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
}

function describeCoverage(coverage) {
    if (!coverage) return "";
    const missingYears = Object.entries(coverage.missingByYear || {})
        .map(([year, days]) => `${year} (${days} hari)`)
        .join(", ");
    const missingText = missingYears || "tidak ada";
    return `Kelengkapan data: ${coverage.available}/${coverage.expected} hari ` +
        `(${coverage.percent}%). Tahun bolong: ${missingText}.`;
}

function toNumber(value) {
    if (value == null || value === "") return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function mean(values) {
    if (!values || values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMonthly(value, header) {
    if (value == null) return null;
    const digits = /arah angin/i.test(header) ? 0 : 2;
    return Number(value.toFixed(digits));
}

function monthlySheetName(header) {
    const base = header
        .replace(/\s*\([^)]*\)\s*/g, "")
        .replace(/[^a-z0-9]+/gi, " ")
        .trim() || "Variabel";
    return base.slice(0, 31);
}

function renderPreview(result) {
    els.previewSection.hidden = false;
    renderPreviewInfo(result);

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

function renderPreviewInfo(result) {
    els.previewInfo.innerHTML = "";

    const summary = document.createElement("div");
    summary.className = "preview-summary-text";
    summary.textContent = describeResult(result);
    els.previewInfo.appendChild(summary);

    const coverage = result.meta.coverage || null;
    const sourceCounts = result.meta.sourceCounts || coverage?.sourceCounts || {};
    const chips = document.createElement("div");
    chips.className = "source-badges";

    Object.entries(sourceCounts).forEach(([source, count]) => {
        const badge = document.createElement("span");
        badge.className = `source-badge ${sourceBadgeClass(source)}`;
        badge.textContent = `${sourceBadgeLabel(source)}: ${count} hari`;
        chips.appendChild(badge);
    });

    if (coverage) {
        const badge = document.createElement("span");
        badge.className = coverage.percent >= 95
            ? "source-badge audit-good"
            : "source-badge audit-warn";
        badge.textContent = `Kelengkapan: ${coverage.available}/${coverage.expected} hari (${coverage.percent}%)`;
        chips.appendChild(badge);
    }

    if (result.meta.reanalysisFallback) {
        const badge = document.createElement("span");
        badge.className = "source-badge reanalysis";
        badge.textContent = "Reanalysis/model, bukan observasi stasiun";
        chips.appendChild(badge);
    }

    if (chips.children.length) {
        els.previewInfo.appendChild(chips);
    }
}

function sourceBadgeLabel(source) {
    const labels = {
        meteostat_daily: "Meteostat Daily",
        meteostat_hourly_aggregated: "Hourly Aggregated",
        openmeteo_era5_reanalysis: "ERA5 Reanalysis",
        nasa_power_reanalysis: "NASA POWER Reanalysis",
    };
    return labels[source] || source;
}

function sourceBadgeClass(source) {
    if (source === "meteostat_daily") return "observed";
    if (source === "meteostat_hourly_aggregated") return "aggregated";
    if (source && source.includes("reanalysis")) return "reanalysis";
    return "";
}

function describeResult(result) {
    const outputLabel = result.meta.outputMode === "monthly"
        ? "rekap rata-rata bulanan"
        : "data harian";
    if (result.source === "power") {
        const loc = result.meta.location;
        const c = result.meta.city;
        const locDesc = locationDescription(loc, c);
        return (
            `${locDesc}` +
            ` - Periode: ${result.meta.startDate} to ${result.meta.endDate} (UTC)` +
            ` - Sumber: NASA POWER (${(result.meta.sources || []).join(", ") || "MERRA-2"})` +
            ` - Output: ${outputLabel}` +
            ` - Total baris: ${result.rows.length}`
        );
    }
    if (result.source === "meteostat") {
        const s = result.meta.station;
        const wmo = s.wmo || s.id;
        const bf = result.meta.tsunBackfill || {};
        const bfCount = Array.isArray(bf.dates) ? bf.dates.length : 0;
        const bfNote = bfCount > 0
            ? ` - Lama penyinaran: ${bfCount} hari di-backfill dari Open-Meteo ERA5`
            : "";
        const fallbackNote = result.meta.dailyFallback === "hourly_aggregated"
            ? " - Data harian dibentuk dari agregasi hourly Meteostat"
            : "";
        const reanalysisNote = result.meta.reanalysisFallback
            ? ` - Fallback: ${result.meta.reanalysisFallback} (reanalysis/model, bukan observasi stasiun)`
            : "";
        const coverageNote = result.meta.coverage
            ? ` - ${describeCoverage(result.meta.coverage)}`
            : "";
        return (
            `Stasiun: ${s.name} (WMO ${wmo}` +
            (s.icao ? ` / ${s.icao}` : "") +
            `) - Periode: ${result.meta.startDate} to ${result.meta.endDate}` +
            ` - Sumber: Meteostat (NOAA ISD/SYNOP, harian)` +
            ` - Output: ${outputLabel}` +
            ` - Total baris: ${result.rows.length}` +
            fallbackNote +
            reanalysisNote +
            coverageNote +
            bfNote
        );
    }
    const c = result.meta.city;
    const loc = result.meta.location;
    const locDesc = locationDescription(loc, c);
    return (
        `${locDesc} - Periode: ${result.meta.startDate} to ${result.meta.endDate}` +
        ` - Granularitas: ${result.meta.granularity} - Output: ${outputLabel}` +
        ` - Sumber: ${result.meta.sources.join(" + ")}` +
        ` - Total baris: ${result.rows.length}`
    );
}

function locationDescription(loc, fallbackCity) {
    const c = fallbackCity || (loc && loc.points && loc.points[0]) || {};
    const parts = [];
    if (c.name) parts.push(c.name);
    if (c.admin1) parts.push(c.admin1);
    if (c.country) parts.push(c.country);
    if (loc && loc.mode === "area") {
        const bb = loc.bbox || [];
        const fmt = (v) => Number(v).toFixed(3);
        return (
            `Area: ${loc.gridSize}x${loc.gridSize} grid (${loc.points.length} titik)` +
            (bb.length === 4
                ? `, bbox W=${fmt(bb[0])} S=${fmt(bb[1])} E=${fmt(bb[2])} N=${fmt(bb[3])}`
                : "")
        );
    }
    if (loc && loc.mode === "pin") {
        return (
            `Pin di peta (${c.latitude?.toFixed(3) ?? "?"}, ${c.longitude?.toFixed(3) ?? "?"})`
        );
    }
    return `Lokasi: ${parts.join(", ")} (${c.latitude?.toFixed(3) ?? "?"}, ${c.longitude?.toFixed(3) ?? "?"})`;
}

// ----- Climate chart -----

function showClimateChart() {
    if (!state.lastResult) {
        showStatus("Klik 'Pratinjau Data' dulu untuk memuat data sebelum render grafik.", "error");
        return;
    }
    renderClimateChart(state.lastResult, true);
}

function renderClimateChart(result, scroll = false) {
    if (!result || !result.rows || result.rows.length === 0 || !els.climateChart) return;
    const chart = buildClimateChartData(result);
    if (!chart.metrics.length) {
        if (scroll) showStatus("Data belum cukup untuk membuat grafik bulanan.", "error");
        return;
    }
    const theme = currentChartTheme();

    els.climateChart.innerHTML = "";
    els.climateChart.classList.add("climate-chart-grid");
    chart.metrics.forEach((metric, metricIndex) => {
        const card = document.createElement("div");
        card.className = "climate-chart-card";
        const header = document.createElement("div");
        header.className = "climate-chart-card-header";
        const title = document.createElement("h3");
        title.textContent = metric.title;
        const download = document.createElement("button");
        download.type = "button";
        download.textContent = "Unduh PNG";
        header.appendChild(title);
        header.appendChild(download);
        const plot = document.createElement("div");
        plot.className = "climate-plot";
        plot.id = `climate-plot-${metric.id}`;
        card.appendChild(header);
        card.appendChild(plot);
        els.climateChart.appendChild(card);

        const traces = metric.series.map((series, seriesIndex) => ({
            type: metric.chartType,
            mode: metric.chartType === "scatter" ? "lines+markers" : undefined,
            x: MONTH_LABELS,
            y: series.values,
            name: String(series.year),
            marker: {
                color: metric.chartType === "bar"
                    ? chartPalette(seriesIndex, theme, 0.72)
                    : chartPalette(seriesIndex, theme, 1),
                size: metric.chartType === "scatter" ? 6 : undefined,
            },
            line: metric.chartType === "scatter"
                ? { color: chartPalette(seriesIndex, theme, 1), width: 2 }
                : undefined,
            hovertemplate: `%{x} ${series.year}<br>${metric.title}: %{y:.2f} ${metric.unit}<extra></extra>`,
        }));

        const layout = {
            title: {
                text: `${metric.title} - ${chart.label}`,
                font: { size: 14 },
            },
            font: { family: "Inter, system-ui, sans-serif", color: theme.text },
            barmode: "group",
            xaxis: {
                title: "Bulan",
                gridcolor: theme.grid,
                linecolor: theme.axis,
                tickfont: { color: theme.axis },
            },
            yaxis: {
                title: metric.unit ? `${metric.title} (${metric.unit})` : metric.title,
                rangemode: metric.allowNegative ? "normal" : "tozero",
                gridcolor: theme.grid,
                linecolor: theme.axis,
                tickfont: { color: theme.axis },
            },
            legend: { orientation: "h", y: -0.24 },
            margin: { t: 58, r: 30, b: 92, l: 62 },
            paper_bgcolor: theme.paper,
            plot_bgcolor: theme.plot,
        };

        Plotly.newPlot(plot, traces, layout, {
            responsive: true,
            displaylogo: false,
            modeBarButtonsToRemove: ["lasso2d", "select2d"],
        });
        download.addEventListener("click", () =>
            downloadClimatePlot(plot, result, metric, metricIndex)
        );
    });

    els.climateChartSection.hidden = false;
    els.climateChartInfo.textContent =
        "Grafik dipisah per parameter. Setiap grafik menampilkan bulan Januari-Desember dengan seri per tahun sesuai rentang yang dipilih.";
    if (scroll) {
        els.climateChartSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

function buildClimateChartData(result) {
    const definitions = [
        {
            id: "suhu",
            title: "Suhu rata-rata",
            unit: "deg C",
            pattern: /suhu rata-rata/i,
            aggregation: "mean",
            chartType: "scatter",
        },
        {
            id: "curah-hujan",
            title: "Curah hujan",
            unit: "mm",
            pattern: /curah hujan|presipitasi/i,
            aggregation: "sum",
            chartType: "bar",
        },
        {
            id: "kecepatan-angin",
            title: "Kecepatan angin rata-rata",
            unit: "m/s",
            pattern: /kecepatan angin/i,
            aggregation: "mean",
            chartType: "scatter",
        },
        {
            id: "arah-angin",
            title: "Arah angin dominan",
            unit: "deg",
            pattern: /arah angin/i,
            aggregation: "circular",
            chartType: "scatter",
        },
        {
            id: "penyinaran",
            title: "Lama penyinaran matahari",
            unit: "jam",
            pattern: /lama penyinaran|radiasi ghi/i,
            aggregation: "sum",
            chartType: "bar",
        },
    ].map((def) => ({ ...def, index: result.headers.findIndex((h) => def.pattern.test(h)) }))
        .filter((def) => def.index >= 0);

    const buckets = new Map(); // metric id -> year -> month index -> values
    definitions.forEach((def) => buckets.set(def.id, new Map()));
    for (const row of result.rows) {
        const date = String(row[0] || "");
        if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
        const year = Number(date.slice(0, 4));
        const month = Number(date.slice(5, 7)) - 1;
        if (!Number.isFinite(year) || month < 0 || month > 11) continue;
        definitions.forEach((def) => {
            const value = toNumber(row[def.index]);
            if (value == null) return;
            const byYear = buckets.get(def.id);
            if (!byYear.has(year)) byYear.set(year, Array.from({ length: 12 }, () => []));
            byYear.get(year)[month].push(value);
        });
    }
    const metrics = definitions.map((def) => {
        const byYear = buckets.get(def.id);
        const years = Array.from(byYear.keys()).sort((a, b) => a - b);
        return {
            ...def,
            series: years.map((year) => ({
                year,
                values: byYear.get(year).map((values) => aggregateChartValues(values, def.aggregation)),
            })),
        };
    }).filter((metric) => metric.series.length);

    return {
        label: chartLocationLabel(result),
        metrics,
    };
}

function aggregateChartValues(values, aggregation) {
    if (!values || !values.length) return null;
    if (aggregation === "sum") return roundChart(sumValues(values));
    if (aggregation === "circular") return roundChart(circularMean(values));
    return roundChart(mean(values));
}

function circularMean(values) {
    if (!values || !values.length) return null;
    let sin = 0;
    let cos = 0;
    values.forEach((value) => {
        const rad = value * Math.PI / 180;
        sin += Math.sin(rad);
        cos += Math.cos(rad);
    });
    const angle = Math.atan2(sin / values.length, cos / values.length) * 180 / Math.PI;
    return (angle + 360) % 360;
}

function chartPalette(index, theme, opacity = 1) {
    const dark = ["#10b981", "#60a5fa", "#fbbf24", "#c084fc", "#f87171", "#22d3ee", "#a3e635", "#fb7185"];
    const light = ["#0f766e", "#2563eb", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#65a30d", "#be123c"];
    const hex = (document.documentElement.dataset.theme === "light" ? light : dark)[index % dark.length];
    if (opacity >= 1) return hex;
    return hexToRgba(hex, opacity);
}

function hexToRgba(hex, opacity) {
    const clean = hex.replace("#", "");
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function sumValues(values) {
    return values && values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function roundChart(value) {
    return value == null ? null : Number(value.toFixed(2));
}

function chartLocationLabel(result) {
    if (result.source === "meteostat" && result.meta.station) {
        return result.meta.station.name;
    }
    if (result.meta.location) {
        return result.meta.location.label || result.meta.city?.name || "Lokasi";
    }
    return result.meta.city?.name || "Lokasi";
}

function downloadClimateChartPNG() {
    if (!state.lastResult || !els.climateChart || els.climateChartSection.hidden) {
        showStatus("Tampilkan grafik dulu sebelum unduh.", "error");
        return;
    }
    const plots = Array.from(els.climateChart.querySelectorAll(".climate-plot"));
    if (!plots.length) {
        showStatus("Tidak ada grafik yang bisa diunduh.", "error");
        return;
    }
    const chart = buildClimateChartData(state.lastResult);
    plots.forEach((plot, index) => {
        const metric = chart.metrics[index] || { id: `grafik-${index + 1}` };
        setTimeout(() => downloadClimatePlot(plot, state.lastResult, metric, index), index * 350);
    });
}

function downloadClimatePlot(plot, result, metric, index = 0) {
    const safe = (s) => String(s || "x").replace(/[^a-z0-9]+/gi, "_");
    const filename =
        `grafik_rona_awal_${safe(metric.id || `parameter_${index + 1}`)}_${safe(chartLocationLabel(result))}_` +
        `${result.meta.startDate}_to_${result.meta.endDate}`;
    Plotly.downloadImage(plot, {
        format: "png",
        width: 1100,
        height: 700,
        filename,
    });
}

// ----- Excel export -----

function exportXlsx(result, outputMode = "daily") {
    const wb = XLSX.utils.book_new();
    if (outputMode === "monthly") {
        appendMonthlySheets(wb, result);
    }

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
    XLSX.utils.book_append_sheet(wb, ws, outputMode === "monthly" ? "Data Harian" : "Data");

    const metaRows = buildMetaRows(result);
    if (outputMode === "monthly") {
        metaRows.splice(1, 0, ["Output Excel", "Rekap rata-rata per bulan"]);
        metaRows.splice(2, 0, [
            "Catatan rekap",
            "Setiap sheet variabel berisi rata-rata nilai harian per bulan, dengan baris bulan dan kolom tahun.",
        ]);
    }
    const metaWs = XLSX.utils.aoa_to_sheet(metaRows);
    metaWs["!cols"] = [{ wch: 22 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, metaWs, "Info");

    const filename = buildFilename(result, outputMode);
    XLSX.writeFile(wb, filename);
}

function appendMonthlySheets(wb, result) {
    const monthly = buildMonthlyAggregation(result);
    const usedNames = new Set();
    const orderedMetrics = [...monthly.metrics].sort((a, b) => {
        const ar = /curah hujan|presipitasi/i.test(a.header) ? 0 : 1;
        const br = /curah hujan|presipitasi/i.test(b.header) ? 0 : 1;
        return ar - br;
    });
    for (const metric of orderedMetrics) {
        const aoa = [
            [metric.header, ...monthly.years],
            ...MONTH_LABELS.map((monthLabel, monthIndex) => [
                monthLabel,
                ...monthly.years.map((year) => {
                    const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
                    const values = monthly.rowsByKey.get(key);
                    return values ? values[metric.index - 1] : null;
                }),
            ]),
        ];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!cols"] = [{ wch: 16 }, ...monthly.years.map(() => ({ wch: 12 }))];
        XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(metric.sheetName, usedNames));
    }
}

function uniqueSheetName(name, usedNames) {
    let safeName = name.slice(0, 31) || "Sheet";
    let candidate = safeName;
    let count = 2;
    while (usedNames.has(candidate)) {
        const suffix = ` ${count}`;
        candidate = `${safeName.slice(0, 31 - suffix.length)}${suffix}`;
        count += 1;
    }
    usedNames.add(candidate);
    return candidate;
}

// Render the location rows for the Excel Info sheet. Always includes the
// underlying lat/lon used for the *first* point so prior columns keep working,
// but for pin/area mode also exposes how many points were averaged and the
// bounding box (when applicable).
function locationRows(loc, fallbackCity) {
    const c = fallbackCity || (loc && loc.points && loc.points[0]) || {};
    const cityParts = [];
    if (c.name) cityParts.push(c.name);
    if (c.admin1) cityParts.push(c.admin1);
    if (c.country) cityParts.push(c.country);
    const cityLabel = cityParts.length ? cityParts.join(", ") : "";

    if (!loc) {
        return [
            ["Lokasi", cityLabel],
            ["Latitude", c.latitude ?? ""],
            ["Longitude", c.longitude ?? ""],
        ];
    }

    if (loc.mode === "city") {
        return [
            ["Lokasi", cityLabel || loc.label || ""],
            ["Mode lokasi", "Kota (1 titik)"],
            ["Latitude", c.latitude ?? ""],
            ["Longitude", c.longitude ?? ""],
        ];
    }
    if (loc.mode === "pin") {
        return [
            ["Lokasi", loc.label || ""],
            ["Mode lokasi", "Pin tunggal di peta (1 titik)"],
            ["Latitude", c.latitude ?? ""],
            ["Longitude", c.longitude ?? ""],
        ];
    }
    if (loc.mode === "area") {
        const bb = loc.bbox || [];
        const fmt = (v) => (v == null ? "" : Number(v).toFixed(4));
        return [
            ["Lokasi", loc.label || "Area peta"],
            [
                "Mode lokasi",
                `Area peta (grid ${loc.gridSize}x${loc.gridSize} = ${loc.points.length} titik dirata-rata)`,
            ],
            ["Bounding box (W, S, E, N)", bb.length === 4 ? bb.map(fmt).join(", ") : ""],
            [
                "Titik grid",
                loc.points
                    .map(
                        (p, i) =>
                            `#${i + 1} (${fmt(p.latitude)}, ${fmt(p.longitude)})`
                    )
                    .join("; "),
            ],
        ];
    }
    return [
        ["Lokasi", cityLabel || ""],
        ["Latitude", c.latitude ?? ""],
        ["Longitude", c.longitude ?? ""],
    ];
}

function buildMetaRows(result) {
    const variableList = [
        "1. Suhu rata-rata (deg C)",
        "2. Curah hujan / presipitasi (mm)",
        "3. Kecepatan angin rata-rata (m/s)",
        "4. Arah angin dominan (deg, 0-360)",
        "5. Lama penyinaran matahari (jam)",
    ].join(" | ");

    if (result.source === "power") {
        const loc = result.meta.location;
        const c = result.meta.city;
        const locRows = locationRows(loc, c);
        return [
            ["Field", "Value"],
            ["Sumber", "NASA POWER (power.larc.nasa.gov, MERRA-2 + CERES SYN1deg)"],
            ["API version", result.meta.apiVersion || ""],
            ["Sumber asal", (result.meta.sources || []).join(", ")],
            ["Community", "RE (Renewable Energy)"],
            ...locRows,
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
                    "(ALLSKY_SFC_SW_DWN, kWh/m2/hari) sebagai proxy energi penyinaran.",
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
            "yang dikonversi ke jam (/60).";
        if (bfDates.length > 0) {
            const shown = bfDates.slice(0, 10).join(", ");
            const more = bfDates.length > 10
                ? ` ... (+${bfDates.length - 10} lainnya)`
                : "";
            sunshineNote +=
                ` ${bfDates.length} tanggal di-backfill dari Open-Meteo ERA5 ` +
                `(sunshine_duration, detik / 60) karena 'tsun' Meteostat kosong: ` +
                `${shown}${more}.`;
        }
        if (bf.error) {
            sunshineNote += ` Backfill gagal sebagian: ${bf.error}.`;
        }
        const coverage = result.meta.coverage;
        const sourceCounts = result.meta.sourceCounts || coverage?.sourceCounts || {};
        const sourceSummary = Object.entries(sourceCounts)
            .map(([source, count]) => `${source}: ${count}`)
            .join(" | ");
        const missingYears = coverage
            ? Object.entries(coverage.missingByYear || {})
                .map(([year, days]) => `${year}: ${days} hari`)
                .join(" | ") || "tidak ada"
            : "";
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
            ["Kelengkapan data", coverage ? `${coverage.available}/${coverage.expected} hari (${coverage.percent}%)` : ""],
            ["Tahun bolong", missingYears],
            ["Sumber per baris", sourceSummary],
            [
                "Catatan data harian",
                result.meta.reanalysisFallback
                    ? `${result.meta.reanalysisFallback} dipakai sebagai fallback reanalysis/model, bukan observasi stasiun.`
                    : result.meta.dailyFallback === "hourly_aggregated"
                    ? "File daily Meteostat kosong untuk periode ini; data harian dibentuk dari agregasi hourly Meteostat."
                    : "Data berasal dari file daily Meteostat.",
            ],
            ["Catatan penyinaran", sunshineNote],
            ["Diunduh pada", new Date().toISOString()],
        ];
    }
    const c = result.meta.city;
    const loc = result.meta.location;
    const locRows = locationRows(loc, c);
    return [
        ["Field", "Value"],
        ["Sumber", "Open-Meteo (open-meteo.com)"],
        ...locRows,
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
                "speed-weighted vector mean, lama penyinaran = sum (detik) / 3600.",
        ],
        ["Sumber data", result.meta.sources.join(" + ")],
        ["Diunduh pada", new Date().toISOString()],
    ];
}

function buildFilename(result, outputMode = "daily") {
    const safe = (s) => String(s || "x").replace(/[^a-z0-9]+/gi, "_");
    const start = result.meta.startDate;
    const end = result.meta.endDate;
    const suffix = outputMode === "monthly" ? "monthly" : "daily";
    if (result.source === "meteostat") {
        const s = result.meta.station;
        return `weather_meteostat_${safe(s.wmo || s.id)}_${start}_to_${end}_${suffix}.xlsx`;
    }
    const loc = result.meta.location;
    let label = result.meta.city?.name || "lokasi";
    if (loc) {
        if (loc.mode === "area") label = `area_${loc.gridSize}x${loc.gridSize}`;
        else if (loc.mode === "pin") {
            const p = loc.points[0];
            label = `pin_${p.latitude.toFixed(2)}_${p.longitude.toFixed(2)}`;
        } else if (loc.points && loc.points[0] && loc.points[0].name) {
            label = loc.points[0].name;
        }
    }
    if (result.source === "power") {
        return `weather_power_${safe(label)}_${start}_to_${end}_${suffix}.xlsx`;
    }
    return `weather_${safe(label)}_${start}_to_${end}_${suffix}.xlsx`;
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
    { label: "0-1", min: 0, max: 1, color: "#deebf7" },
    { label: "1-3", min: 1, max: 3, color: "#9ecae1" },
    { label: "3-5", min: 3, max: 5, color: "#6baed6" },
    { label: "5-7", min: 5, max: 7, color: "#4292c6" },
    { label: "7-9", min: 7, max: 9, color: "#2171b5" },
    { label: "9-11", min: 9, max: 11, color: "#08519c" },
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

    const theme = currentChartTheme();
    const layout = {
        title: {
            text: windroseTitle(result, mode),
            font: { size: 14 },
        },
        font: { family: "Inter, system-ui, sans-serif", color: theme.text },
        paper_bgcolor: theme.paper,
        plot_bgcolor: theme.plot,
        polar: {
            bgcolor: theme.plot,
            barmode: "stack",
            bargap: 0,
            radialaxis: {
                ticksuffix: "%",
                angle: 45,
                gridcolor: theme.grid,
                linecolor: theme.axis,
                tickfont: { size: 11, color: theme.axis },
            },
            angularaxis: {
                direction: "clockwise",
                rotation: 90, // N at top
                gridcolor: theme.grid,
                linecolor: theme.axis,
                tickfont: { size: 12, color: theme.axis },
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
    const modeLabel = mode === "to" ? "Blowing To (arah hembusan)"
        : "Blowing From (asal angin, konvensi meteorologi)";
    els.windroseInfo.textContent =
        `Mode: ${modeLabel}. ` +
        `Total observasi: ${total} (calm <= 0.5 m/s: ${calmCount} = ` +
        `${total > 0 ? ((calmCount / total) * 100).toFixed(1) : "0"}%). ` +
        `Frekuensi tiap sektor 22.5deg, dibagi per bin kecepatan.`;
    els.windroseSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function windroseTitle(result, mode) {
    const tag = mode === "to" ? "Blowing To" : "Blowing From";
    if (result.source === "meteostat") {
        const s = result.meta.station;
        return (
            `Windrose (${tag}) - ${s.name} (WMO ${s.wmo || s.id})` +
            ` - ${result.meta.startDate} to ${result.meta.endDate}`
        );
    }
    if (result.source === "power") {
        const c = result.meta.city;
        return (
            `Windrose (${tag}) - ${c.name} (NASA POWER, 10 m)` +
            ` - ${result.meta.startDate} to ${result.meta.endDate}`
        );
    }
    const c = result.meta.city;
    return `Windrose (${tag}) - ${c.name} - ${result.meta.startDate} to ${result.meta.endDate}`;
}

function directionIndex(degrees) {
    // Map 0..360 to nearest of 16 cardinal sectors (each 22.5deg wide).
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
