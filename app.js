// Weather Data Exporter — fetches weather data from Open-Meteo (model)
// or Meteostat (Indonesian observation stations) via a backend proxy,
// renders a windrose, and exports to Excel.

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const BACKEND_URL =
    (window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL) || "http://localhost:8001";

// Open-Meteo variable metadata.
const VARIABLE_META = {
    temperature_2m: { label: "Suhu", unit: "°C", daily: "temperature_2m_mean" },
    relative_humidity_2m: { label: "Kelembaban", unit: "%", daily: null },
    precipitation: { label: "Presipitasi", unit: "mm", daily: "precipitation_sum" },
    cloud_cover: { label: "Tutupan awan", unit: "%", daily: null },
    cloud_cover_low: { label: "Awan rendah", unit: "%", daily: null },
    cloud_cover_mid: { label: "Awan menengah", unit: "%", daily: null },
    cloud_cover_high: { label: "Awan tinggi", unit: "%", daily: null },
    wind_speed_10m: { label: "Kecepatan angin 10m", unit: "km/jam", daily: "wind_speed_10m_max" },
    wind_direction_10m: {
        label: "Arah angin 10m",
        unit: "°",
        daily: "wind_direction_10m_dominant",
    },
    wind_gusts_10m: { label: "Hembusan angin 10m", unit: "km/jam", daily: "wind_gusts_10m_max" },
    surface_pressure: { label: "Tekanan permukaan", unit: "hPa", daily: null },
    weather_code: { label: "Kode cuaca (WMO)", unit: "", daily: "weather_code" },
};

const DAILY_LABEL = {
    temperature_2m_mean: { label: "Suhu rata-rata", unit: "°C" },
    temperature_2m_max: { label: "Suhu maks", unit: "°C" },
    temperature_2m_min: { label: "Suhu min", unit: "°C" },
    precipitation_sum: { label: "Total presipitasi", unit: "mm" },
    wind_speed_10m_max: { label: "Kecepatan angin maks", unit: "km/jam" },
    wind_gusts_10m_max: { label: "Hembusan angin maks", unit: "km/jam" },
    wind_direction_10m_dominant: { label: "Arah angin dominan", unit: "°" },
    weather_code: { label: "Kode cuaca (WMO)", unit: "" },
};

// Meteostat hourly column metadata. Keys must match the backend response.
const METEOSTAT_META = {
    temp: { label: "Suhu", unit: "°C" },
    dwpt: { label: "Dew point", unit: "°C" },
    rhum: { label: "Kelembaban", unit: "%" },
    prcp: { label: "Presipitasi", unit: "mm" },
    snow: { label: "Salju", unit: "mm" },
    wdir: { label: "Arah angin", unit: "°" },
    wspd: { label: "Kecepatan angin", unit: "km/jam" },
    wpgt: { label: "Hembusan angin (peak)", unit: "km/jam" },
    pres: { label: "Tekanan", unit: "hPa" },
    tsun: { label: "Sunshine", unit: "menit" },
    coco: { label: "Kode cuaca", unit: "" },
};

const state = {
    source: "openmeteo", // "openmeteo" | "meteostat"
    selectedCity: null,
    selectedStation: null,
    stations: [],
    lastResult: null, // {headers, rows, meta, windRows: [{dir, spd}]}
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
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
    els.granularity = document.getElementById("granularity");
    els.timezone = document.getElementById("timezone");
    els.periodHelpOM = document.getElementById("period-help-openmeteo");
    els.periodHelpMS = document.getElementById("period-help-meteostat");
    els.varsSection = document.getElementById("vars-section");
    els.varsHelpMS = document.getElementById("vars-help-meteostat");
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
    const isMeteostat = state.source === "meteostat";
    els.citySection.hidden = isMeteostat;
    els.stationSection.hidden = !isMeteostat;
    els.periodHelpOM.hidden = isMeteostat;
    els.periodHelpMS.hidden = !isMeteostat;
    els.varsSection.hidden = isMeteostat;
    els.varsHelpMS.hidden = !isMeteostat;

    // Granularity: Meteostat only supports hourly in this build.
    const dailyOpt = els.granularity.querySelector('option[value="daily"]');
    if (dailyOpt) dailyOpt.disabled = isMeteostat;
    if (isMeteostat) els.granularity.value = "hourly";

    if (isMeteostat && !state.stations.length) {
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
            const res = await fetch(url);
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
        const res = await fetch(`${BACKEND_URL}/stations`);
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
        } else {
            if (!state.selectedCity) {
                throw new Error("Pilih kota dulu dari saran pencarian.");
            }
            const selectedVars = Array.from(
                document.querySelectorAll('input[name="var"]:checked')
            ).map((i) => i.value);
            if (!selectedVars.length) {
                throw new Error("Pilih minimal satu variabel cuaca.");
            }
            result = await fetchOpenMeteo({
                city: state.selectedCity,
                startDate,
                endDate,
                variables: selectedVars,
                granularity: els.granularity.value,
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
        console.error(err);
        showStatus(`Gagal: ${err.message}`, "error");
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

async function fetchOpenMeteo({ city, startDate, endDate, variables, granularity, timezone }) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const archiveCutoff = new Date(today);
    archiveCutoff.setDate(today.getDate() - 5);

    const start = parseLocalDate(startDate);
    const end = parseLocalDate(endDate);

    const apiVars = mapVariables(variables, granularity);

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

    const allTimes = [];
    const allRows = {};

    for (const seg of segments) {
        const data = await callOpenMeteo({
            kind: seg.kind,
            latitude: city.latitude,
            longitude: city.longitude,
            startDate: isoDate(seg.start),
            endDate: isoDate(seg.end),
            apiVars,
            granularity,
            timezone,
        });
        const block = data[granularity];
        if (!block || !block.time) continue;
        block.time.forEach((t, i) => {
            if (!(t in allRows)) {
                allRows[t] = {};
                allTimes.push(t);
            }
            for (const v of apiVars) {
                if (block[v] !== undefined) allRows[t][v] = block[v][i];
            }
        });
    }

    allTimes.sort();

    const headers = ["Waktu", ...apiVars.map(varHeader)];
    const rows = allTimes.map((t) => [t, ...apiVars.map((v) => allRows[t]?.[v] ?? null)]);

    // Wind rows for windrose
    const dirIdx = apiVars.indexOf("wind_direction_10m");
    const spdIdx = apiVars.indexOf("wind_speed_10m");
    const windRows = [];
    if (dirIdx >= 0 && spdIdx >= 0) {
        for (const t of allTimes) {
            const r = allRows[t];
            const d = r[apiVars[dirIdx]];
            const s = r[apiVars[spdIdx]];
            if (d != null && s != null) windRows.push({ dir: d, spd: s });
        }
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
            granularity,
            timezone,
            apiVars,
            sources: segments.map((s) => s.kind),
        },
    };
}

function parseLocalDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function mapVariables(selected, granularity) {
    if (granularity === "hourly") return selected.slice();
    const out = [];
    for (const v of selected) {
        const meta = VARIABLE_META[v];
        if (!meta) continue;
        if (meta.daily) {
            if (!out.includes(meta.daily)) out.push(meta.daily);
        }
    }
    if (!out.length) out.push("temperature_2m_mean", "precipitation_sum");
    return out;
}

function varHeader(v) {
    if (DAILY_LABEL[v]) {
        const m = DAILY_LABEL[v];
        return m.unit ? `${m.label} (${m.unit})` : m.label;
    }
    if (VARIABLE_META[v]) {
        const m = VARIABLE_META[v];
        return m.unit ? `${m.label} (${m.unit})` : m.label;
    }
    return v;
}

async function callOpenMeteo({
    kind,
    latitude,
    longitude,
    startDate,
    endDate,
    apiVars,
    granularity,
    timezone,
}) {
    const base = kind === "archive" ? ARCHIVE_URL : FORECAST_URL;
    const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        start_date: startDate,
        end_date: endDate,
        timezone: timezone || "auto",
        wind_speed_unit: "kmh",
        timeformat: "iso8601",
    });
    params.set(granularity, apiVars.join(","));
    const url = `${base}?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
        let detail = "";
        try {
            const j = await res.json();
            detail = j.reason || JSON.stringify(j);
        } catch (_) {
            detail = await res.text();
        }
        throw new Error(`Open-Meteo (${kind}) HTTP ${res.status}: ${detail}`);
    }
    return await res.json();
}

// ----- Meteostat fetch (via backend) -----

async function fetchMeteostat({ station, startDate, endDate }) {
    const url = `${BACKEND_URL}/hourly/${encodeURIComponent(station.id)}` +
        `?start=${startDate}&end=${endDate}`;
    const res = await fetch(url);
    if (!res.ok) {
        let detail = "";
        try {
            const j = await res.json();
            detail = j.detail || JSON.stringify(j);
        } catch (_) {
            detail = await res.text();
        }
        throw new Error(`Backend HTTP ${res.status}: ${detail}`);
    }
    const data = await res.json();
    // data.columns: ["time", "temp", "dwpt", ...]; data.rows: array of arrays.
    const headers = data.columns.map((c) => {
        if (c === "time") return "Waktu";
        const m = METEOSTAT_META[c];
        if (!m) return c;
        return m.unit ? `${m.label} (${m.unit})` : m.label;
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
        rows: data.rows,
        windRows,
        meta: {
            kind: "meteostat",
            station,
            startDate,
            endDate,
            columns: data.columns,
        },
    };
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
    if (result.source === "meteostat") {
        const s = result.meta.station;
        const wmo = s.wmo || s.id;
        return (
            `Stasiun: ${s.name} (WMO ${wmo}` +
            (s.icao ? ` / ${s.icao}` : "") +
            `) · Periode: ${result.meta.startDate} → ${result.meta.endDate}` +
            ` · Sumber: Meteostat (NOAA ISD/SYNOP) · Total baris: ${result.rows.length}`
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
    if (result.source === "meteostat") {
        const s = result.meta.station;
        const wmo = s.wmo || s.id;
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
            ["Granularitas", "hourly"],
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
        ["Sumber data", result.meta.sources.join(" + ")],
        ["Diunduh pada", new Date().toISOString()],
    ];
}

function buildFilename(result) {
    const safe = (s) => String(s || "x").replace(/[^a-z0-9]+/gi, "_");
    const start = result.source === "meteostat" ? result.meta.startDate : result.meta.startDate;
    const end = result.source === "meteostat" ? result.meta.endDate : result.meta.endDate;
    if (result.source === "meteostat") {
        const s = result.meta.station;
        return `weather_meteostat_${safe(s.wmo || s.id)}_${start}_to_${end}.xlsx`;
    }
    return `weather_${safe(result.meta.city.name)}_${start}_to_${end}_${result.meta.granularity}.xlsx`;
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
    { label: "0–5", min: 0, max: 5, color: "#deebf7" },
    { label: "5–10", min: 5, max: 10, color: "#9ecae1" },
    { label: "10–15", min: 10, max: 15, color: "#6baed6" },
    { label: "15–20", min: 15, max: 20, color: "#4292c6" },
    { label: "20–25", min: 20, max: 25, color: "#2171b5" },
    { label: "25–30", min: 25, max: 30, color: "#08519c" },
    { label: "30+", min: 30, max: Infinity, color: "#08306b" },
];

function showWindrose() {
    const result = state.lastResult;
    if (!result) {
        showStatus("Klik 'Pratinjau Data' dulu untuk memuat data sebelum render windrose.", "error");
        return;
    }
    if (!result.windRows || result.windRows.length === 0) {
        showStatus(
            "Data tidak punya kolom arah/kecepatan angin yang lengkap. " +
            "Pastikan variabel angin dicentang (untuk Open-Meteo).",
            "error"
        );
        return;
    }

    const counts = WINDROSE_BINS.map(() =>
        WINDROSE_DIRECTIONS.map(() => 0)
    ); // [bin][direction]
    let total = 0;
    let calmCount = 0;
    for (const { dir, spd } of result.windRows) {
        if (spd <= 0.5) {
            calmCount++;
            total++;
            continue;
        }
        const dirIdx = directionIndex(dir);
        const binIdx = binIndexFor(spd);
        counts[binIdx][dirIdx]++;
        total++;
    }

    const traces = WINDROSE_BINS.map((bin, bi) => ({
        type: "barpolar",
        name: `${bin.label} km/jam`,
        r: counts[bi].map((c) => (total > 0 ? (c / total) * 100 : 0)),
        theta: WINDROSE_DIRECTIONS.map((d) => d.theta),
        marker: { color: bin.color, line: { color: "white", width: 1 } },
        hovertemplate:
            "%{theta}<br>" +
            `${bin.label} km/jam<br>` +
            "%{r:.2f}% of obs<extra></extra>",
    }));

    const layout = {
        title: {
            text: windroseTitle(result),
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
            title: { text: "Kecepatan angin" },
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
    els.windroseInfo.textContent =
        `Total observasi: ${total} (calm ≤ 0.5 km/jam: ${calmCount} = ` +
        `${total > 0 ? ((calmCount / total) * 100).toFixed(1) : "0"}%). ` +
        `Frekuensi tiap sektor 22.5°, dibagi per bin kecepatan.`;
    els.windroseSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function windroseTitle(result) {
    if (result.source === "meteostat") {
        const s = result.meta.station;
        return (
            `Windrose · ${s.name} (WMO ${s.wmo || s.id})` +
            ` · ${result.meta.startDate} → ${result.meta.endDate}`
        );
    }
    const c = result.meta.city;
    return `Windrose · ${c.name} · ${result.meta.startDate} → ${result.meta.endDate}`;
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
