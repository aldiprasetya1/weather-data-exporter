const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const VARIABLE_META = {
    temperature_2m: { label: "Suhu", unit: "\u00b0C", daily: "temperature_2m_mean" },
    relative_humidity_2m: { label: "Kelembaban", unit: "%", daily: "relative_humidity_2m_mean" },
    precipitation: { label: "Presipitasi", unit: "mm", daily: "precipitation_sum" },
    cloud_cover: { label: "Tutupan awan", unit: "%", daily: "cloud_cover_mean" },
    cloud_cover_low: { label: "Awan rendah", unit: "%", daily: "cloud_cover_low_mean" },
    cloud_cover_mid: { label: "Awan menengah", unit: "%", daily: "cloud_cover_mid_mean" },
    cloud_cover_high: { label: "Awan tinggi", unit: "%", daily: "cloud_cover_high_mean" },
    wind_speed_10m: { label: "Kecepatan angin 10m", unit: "km/jam", daily: "wind_speed_10m_max" },
    wind_direction_10m: {
        label: "Arah angin 10m",
        unit: "\u00b0",
        daily: "wind_direction_10m_dominant",
    },
    wind_gusts_10m: { label: "Hembusan angin 10m", unit: "km/jam", daily: "wind_gusts_10m_max" },
    surface_pressure: { label: "Tekanan permukaan", unit: "hPa", daily: "surface_pressure_mean" },
    weather_code: { label: "Kode cuaca (WMO)", unit: "", daily: "weather_code" },
};

const DAILY_LABEL = {
    temperature_2m_mean: { label: "Suhu rata-rata", unit: "\u00b0C" },
    temperature_2m_max: { label: "Suhu maks", unit: "\u00b0C" },
    temperature_2m_min: { label: "Suhu min", unit: "\u00b0C" },
    relative_humidity_2m_mean: { label: "Kelembaban rata-rata", unit: "%" },
    precipitation_sum: { label: "Total presipitasi", unit: "mm" },
    cloud_cover_mean: { label: "Tutupan awan rata-rata", unit: "%" },
    cloud_cover_low_mean: { label: "Awan rendah rata-rata", unit: "%" },
    cloud_cover_mid_mean: { label: "Awan menengah rata-rata", unit: "%" },
    cloud_cover_high_mean: { label: "Awan tinggi rata-rata", unit: "%" },
    wind_speed_10m_max: { label: "Kecepatan angin maks", unit: "km/jam" },
    wind_gusts_10m_max: { label: "Hembusan angin maks", unit: "km/jam" },
    wind_direction_10m_dominant: { label: "Arah angin dominan", unit: "\u00b0" },
    surface_pressure_mean: { label: "Tekanan permukaan rata-rata", unit: "hPa" },
    weather_code: { label: "Kode cuaca (WMO)", unit: "" },
};

const state = {
    selectedCity: null,
    lastResult: null,
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
    els.cityInput = document.getElementById("city-input");
    els.suggestions = document.getElementById("city-suggestions");
    els.selectedCity = document.getElementById("selected-city");
    els.startDate = document.getElementById("start-date");
    els.endDate = document.getElementById("end-date");
    els.granularity = document.getElementById("granularity");
    els.timezone = document.getElementById("timezone");
    els.previewBtn = document.getElementById("preview-btn");
    els.downloadBtn = document.getElementById("download-btn");
    els.form = document.getElementById("weather-form");
    els.status = document.getElementById("status");
    els.previewSection = document.getElementById("preview-section");
    els.previewInfo = document.getElementById("preview-info");
    els.previewTable = document.getElementById("preview-table");

    const today = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(today.getDate() - 7);
    els.startDate.value = isoDate(weekAgo);
    els.endDate.value = isoDate(today);

    setupCityAutocomplete();

    els.previewBtn.addEventListener("click", () => handleSubmit({ download: false }));
    els.form.addEventListener("submit", (e) => {
        e.preventDefault();
        handleSubmit({ download: true });
    });
});

function isoDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

// ----- City autocomplete -----

function setupCityAutocomplete() {
    let debounceTimer = null;
    let activeIndex = -1;

    els.cityInput.addEventListener("input", () => {
        const q = els.cityInput.value.trim();
        state.selectedCity = null;
        els.selectedCity.textContent = "Belum ada kota yang dipilih.";
        els.selectedCity.classList.remove("success");

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
            const url = `${GEOCODE_URL}?name=${encodeURIComponent(q)}&count=8&language=id&format=json`;
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
                \u2014 ${r.latitude.toFixed(3)}, ${r.longitude.toFixed(3)}</span>`;
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

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));
}

// ----- Submit / fetch -----

async function handleSubmit({ download }) {
    if (!state.selectedCity) {
        showStatus("Pilih kota dulu dari saran pencarian.", "error");
        return;
    }
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

    const selectedVars = Array.from(
        document.querySelectorAll('input[name="var"]:checked')
    ).map((i) => i.value);

    if (!selectedVars.length) {
        showStatus("Pilih minimal satu variabel cuaca.", "error");
        return;
    }

    const granularity = els.granularity.value;
    const timezone = els.timezone.value;

    setLoading(true);
    showStatus("Mengambil data dari Open-Meteo...", "loading");

    try {
        const result = await fetchWeather({
            city: state.selectedCity,
            startDate,
            endDate,
            variables: selectedVars,
            granularity,
            timezone,
        });
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
}

function showStatus(msg, type = "info") {
    els.status.hidden = false;
    els.status.textContent = msg;
    els.status.className = `status ${type}`;
}

async function fetchWeather({ city, startDate, endDate, variables, granularity, timezone }) {
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

    return {
        headers,
        rows,
        meta: {
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
    if (!out.length) {
        throw new Error("Variabel yang dipilih tidak tersedia untuk granularitas harian.");
    }
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
            const j = await res.clone().json();
            detail = j.reason || JSON.stringify(j);
        } catch (_) {
            detail = await res.text();
        }
        throw new Error(`Open-Meteo (${kind}) HTTP ${res.status}: ${detail}`);
    }
    return await res.json();
}

// ----- Preview & export -----

function renderPreview(result) {
    els.previewSection.hidden = false;
    const { city, startDate, endDate, granularity, sources } = result.meta;
    const parts = [city.name];
    if (city.admin1) parts.push(city.admin1);
    if (city.country) parts.push(city.country);
    els.previewInfo.textContent =
        `Kota: ${parts.join(", ")} \u00b7 Periode: ${startDate} \u2192 ${endDate}` +
        ` \u00b7 Granularitas: ${granularity} \u00b7 Sumber: ${sources.join(" + ")}` +
        ` \u00b7 Total baris: ${result.rows.length}`;

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
            td.textContent = cell ?? "";
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
}

function exportXlsx(result) {
    const { city, startDate, endDate, granularity, timezone, sources } = result.meta;
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

    const cityParts = [city.name];
    if (city.admin1) cityParts.push(city.admin1);
    if (city.country) cityParts.push(city.country);
    const metaRows = [
        ["Field", "Value"],
        ["Kota", cityParts.join(", ")],
        ["Latitude", city.latitude],
        ["Longitude", city.longitude],
        ["Zona waktu (kota)", city.timezone || ""],
        ["Zona waktu (request)", timezone],
        ["Tanggal mulai", startDate],
        ["Tanggal akhir", endDate],
        ["Granularitas", granularity],
        ["Sumber data", sources.join(" + ")],
        ["API", "Open-Meteo (open-meteo.com)"],
        ["Diunduh pada", new Date().toISOString()],
    ];
    const metaWs = XLSX.utils.aoa_to_sheet(metaRows);
    metaWs["!cols"] = [{ wch: 22 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, metaWs, "Info");

    const safeCity = (city.name || "city").replace(/[^a-z0-9]+/gi, "_");
    const filename = `weather_${safeCity}_${startDate}_to_${endDate}_${granularity}.xlsx`;
    XLSX.writeFile(wb, filename);
}
