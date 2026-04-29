const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const METEOSTAT_API = "https://meteostat.p.rapidapi.com";

const VARIABLE_META = {
    temperature_2m: { label: "Suhu", unit: "\u00b0C", daily: "temperature_2m_mean" },
    relative_humidity_2m: { label: "Kelembaban", unit: "%", daily: "relative_humidity_2m_mean" },
    precipitation: { label: "Presipitasi", unit: "mm", daily: "precipitation_sum" },
    cloud_cover: { label: "Tutupan awan", unit: "%", daily: "cloud_cover_mean" },
    cloud_cover_low: { label: "Awan rendah", unit: "%", daily: "cloud_cover_low_mean" },
    cloud_cover_mid: { label: "Awan menengah", unit: "%", daily: "cloud_cover_mid_mean" },
    cloud_cover_high: { label: "Awan tinggi", unit: "%", daily: "cloud_cover_high_mean" },
    wind_speed_10m: { label: "Kecepatan angin 10m", unit: "m/s", daily: "wind_speed_10m_max" },
    wind_direction_10m: {
        label: "Arah angin 10m",
        unit: "\u00b0",
        daily: "wind_direction_10m_dominant",
    },
    wind_gusts_10m: { label: "Hembusan angin 10m", unit: "m/s", daily: "wind_gusts_10m_max" },
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
    wind_speed_10m_max: { label: "Kecepatan angin maks", unit: "m/s" },
    wind_gusts_10m_max: { label: "Hembusan angin maks", unit: "m/s" },
    wind_direction_10m_dominant: { label: "Arah angin dominan", unit: "\u00b0" },
    surface_pressure_mean: { label: "Tekanan permukaan rata-rata", unit: "hPa" },
    weather_code: { label: "Kode cuaca (WMO)", unit: "" },
};

const INDONESIA_STATIONS = [
    {id:"97320",name:"Alor / Mali",lat:-8.2167,lon:124.5667,elev:12},
    {id:"97722",name:"Amahai",lat:-3.35,lon:128.8833,elev:10},
    {id:"97724",name:"Ambon / Pattimura",lat:-3.7,lon:128.0833,elev:12},
    {id:"97240",name:"Ampenan / Selaparang",lat:-8.5333,lon:116.0667,elev:3},
    {id:"WALL0",name:"Balik Papan / Balikpapan / Sepinggan",lat:-1.2683,lon:116.8945,elev:3},
    {id:"96633",name:"Balikpapan / Sepinggan",lat:-1.2667,lon:116.9,elev:3},
    {id:"96011",name:"Banda Aceh / Blangbintang",lat:5.5167,lon:95.4167,elev:21},
    {id:"WAOO0",name:"Banjarmasin / Pulaubiruang",lat:-3.4424,lon:114.763,elev:20},
    {id:"96685",name:"Banjarmasin / Syamsuddin Noor",lat:-3.4333,lon:114.75,elev:20},
    {id:"96987",name:"Banyuwangi",lat:-8.2167,lon:114.3833,elev:5},
    {id:"96087",name:"Batan, Sumatra",lat:1.1167,lon:104.1167,elev:24},
    {id:"97192",name:"Bau-Bau / Beto Ambiri",lat:-5.4667,lon:122.6167,elev:2},
    {id:"96033",name:"Belawan",lat:3.8,lon:98.7,elev:3},
    {id:"96253",name:"Bengkulu / Padangkemiling",lat:-3.8833,lon:102.3333,elev:16},
    {id:"97560",name:"Biak / Mokmer",lat:-1.1833,lon:136.1167,elev:11},
    {id:"97270",name:"Bima",lat:-8.55,lon:118.7,elev:2},
    {id:"97016",name:"Bitung",lat:1.4333,lon:125.1833,elev:3},
    {id:"96753",name:"Bogor / Dermaga",lat:-6.5,lon:106.75,elev:250},
    {id:"96805",name:"Cilacap",lat:-7.7333,lon:109.0167,elev:6},
    {id:"96751",name:"Citeko / Puncak",lat:-6.7,lon:106.9333,elev:300},
    {id:"96739",name:"Curug / Budiarto",lat:-6.2333,lon:106.65,elev:46},
    {id:"97230",name:"Denpasar / Ngurah-Rai",lat:-8.75,lon:115.1667,elev:1},
    {id:"97780",name:"Enarotali",lat:-3.9167,lon:136.3667,elev:1770},
    {id:"97630",name:"Fak-Fak / Torea",lat:-2.8833,lon:132.25,elev:130},
    {id:"97406",name:"Galela / Gamarmalamu",lat:1.8167,lon:127.8333,elev:8},
    {id:"97748",name:"Geser",lat:-3.8,lon:130.8333,elev:3},
    {id:"97048",name:"Gorontalo / Jalaluddin",lat:0.5167,lon:123.0667,elev:2},
    {id:"96075",name:"Gunung Sitoli / Binaka",lat:1.5,lon:97.6333,elev:6},
    {id:"96743",name:"Jakarta / Kebonkosong",lat:-6.15,lon:106.85,elev:5},
    {id:"96745",name:"Jakarta / Observatory",lat:-6.1833,lon:106.8333,elev:8},
    {id:"96749",name:"Jakarta / Soekarno-Hatta",lat:-6.1167,lon:106.65,elev:8},
    {id:"96741",name:"Jakarta / Tanjung Priok",lat:-6.1,lon:106.8667,elev:2},
    {id:"96195",name:"Jambi / Sultan Taha",lat:-1.6333,lon:103.65,elev:25},
    {id:"96791",name:"Jatiwangi",lat:-6.75,lon:108.2667,elev:50},
    {id:"97698",name:"Jayapura",lat:-2.3667,lon:140.7167,elev:3},
    {id:"97690",name:"Jayapura / Sentani",lat:-2.5667,lon:140.4833,elev:99},
    {id:"97760",name:"Kaimana / Utarom",lat:-3.6667,lon:133.75,elev:3},
    {id:"96973",name:"Kalianget Madura Island",lat:-7.05,lon:113.9667,elev:3},
    {id:"97146",name:"Kendari / Woltermon-Ginsidi",lat:-4.1,lon:122.4333,elev:50},
    {id:"96207",name:"Kerinci / Depati Parbo",lat:-2.7667,lon:101.3667,elev:782},
    {id:"96615",name:"Ketapang / Rahadi Usmaman",lat:-1.85,lon:109.9667,elev:9},
    {id:"97796",name:"Kokonao / Timuka",lat:-4.7167,lon:136.4333,elev:3},
    {id:"96695",name:"Kotabaru",lat:-3.4,lon:116.2167,elev:18},
    {id:"97372",name:"Kupang / El Tari",lat:-10.1667,lon:123.6667,elev:108},
    {id:"WATT0",name:"Kupang / Oesapa-besar",lat:-10.1716,lon:123.671,elev:102},
    {id:"97460",name:"Labuha / Taliabu",lat:-1.6167,lon:124.55,elev:3},
    {id:"97310",name:"Larantuka",lat:-8.2667,lon:122.9667,elev:9},
    {id:"96009",name:"Lhokseumawe / Malikussaleh",lat:5.2333,lon:97.2,elev:87},
    {id:"97086",name:"Luwuk / Bubung",lat:-0.9,lon:122.7833,elev:2},
    {id:"97120",name:"Majene",lat:-2.5,lon:119.0,elev:8},
    {id:"97530",name:"Manokwari / Rendani",lat:-0.8833,lon:134.05,elev:3},
    {id:"97126",name:"Masamba",lat:-2.55,lon:120.3667,elev:50},
    {id:"WAWM0",name:"Masamba / Pasar Selatan",lat:-2.558,lon:120.324,elev:50},
    {id:"97300",name:"Maumere / Wai Oti",lat:-8.6333,lon:122.25,elev:3},
    {id:"96035",name:"Medan / Polonia",lat:3.5667,lon:98.6833,elev:25},
    {id:"97014",name:"Menado / Dr. Sam Ratulangi",lat:1.5333,lon:124.9167,elev:80},
    {id:"97980",name:"Merauke / Mopah",lat:-8.4667,lon:140.3833,elev:3},
    {id:"96015",name:"Meulaboh / Cut Nyak Dhien",lat:4.25,lon:96.1167,elev:90},
    {id:"96595",name:"Muaratewe / Beringin",lat:-0.95,lon:114.9,elev:60},
    {id:"97682",name:"Nabire",lat:-3.3333,lon:135.5,elev:3},
    {id:"97700",name:"Namlea",lat:-3.25,lon:127.0833,elev:20},
    {id:"96163",name:"Padang / Tabing",lat:-0.8833,lon:100.35,elev:3},
    {id:"96109",name:"Pakanbaru / Simpangtiga",lat:0.4667,lon:101.45,elev:31},
    {id:"96655",name:"Palangkaraya / Panarung",lat:-1.0,lon:114.0,elev:27},
    {id:"96221",name:"Palembang / Talangbetutu",lat:-2.9,lon:104.7,elev:10},
    {id:"96535",name:"Paloh",lat:-1.7,lon:109.3,elev:15},
    {id:"97072",name:"Palu / Mutiara",lat:-0.6833,lon:119.7333,elev:6},
    {id:"96645",name:"Pangkalan Bun / Iskandar",lat:-2.7,lon:110.7,elev:25},
    {id:"96237",name:"Pangkalpinang / Pangkalpinang",lat:-2.1667,lon:106.1333,elev:33},
    {id:"96581",name:"Pontianak / Supadio",lat:-0.15,lon:109.4,elev:3},
    {id:"97096",name:"Poso / Kasiguncu",lat:-1.3833,lon:120.7333,elev:2},
    {id:"WADL0",name:"Praya / Keliung",lat:-8.7573,lon:116.2767,elev:97},
    {id:"96171",name:"Rengat / Japura",lat:0.4667,lon:102.3167,elev:46},
    {id:"97378",name:"Rote / Baa",lat:-10.7333,lon:123.0667,elev:1},
    {id:"96001",name:"Sabang / Cut Bau",lat:5.8667,lon:95.3167,elev:126},
    {id:"97380",name:"Sabu / Tardamu",lat:-10.5,lon:121.8333,elev:26},
    {id:"96607",name:"Samarinda / Temindung",lat:-0.6167,lon:117.15,elev:230},
    {id:"97600",name:"Sanana",lat:-2.0833,lon:126.0,elev:2},
    {id:"96925",name:"Sangkapura Bawean Island",lat:-5.85,lon:112.6333,elev:3},
    {id:"97580",name:"Sarmi",lat:-1.8333,lon:138.7167,elev:3},
    {id:"97900",name:"Saumlaki",lat:-7.9833,lon:131.3,elev:24},
    {id:"96837",name:"Semarang",lat:-6.9667,lon:110.4167,elev:3},
    {id:"96839",name:"Semarang / Ahmadyani",lat:-6.9833,lon:110.3833,elev:3},
    {id:"96737",name:"Serang",lat:-6.1167,lon:106.1333,elev:40},
    {id:"97570",name:"Serui / Yendosa",lat:-1.8667,lon:136.2333,elev:3},
    {id:"96073",name:"Sibolga / Pinangsori",lat:1.55,lon:98.8833,elev:3},
    {id:"96179",name:"Singkep / Dabo",lat:-0.4833,lon:104.5833,elev:31},
    {id:"96559",name:"Sintang",lat:0.1167,lon:111.5333,elev:30},
    {id:"97502",name:"Sorong / Jefman",lat:-0.9333,lon:131.1167,elev:3},
    {id:"97260",name:"Sumbawa Besar / Sumbawa Besar",lat:-8.4333,lon:117.4167,elev:3},
    {id:"96937",name:"Surabaya",lat:-7.2167,lon:113.7167,elev:3},
    {id:"96935",name:"Surabaya / Juanda",lat:-7.3667,lon:112.7667,elev:3},
    {id:"96933",name:"Surabaya / Perak",lat:-7.2167,lon:112.7167,elev:3},
    {id:"97008",name:"Tahuna",lat:3.5833,lon:125.4667,elev:38},
    {id:"97876",name:"Tanah Merah / Tanah Merah",lat:-6.1,lon:140.3,elev:16},
    {id:"WIDN0",name:"Tanjung Pinang / Gesik",lat:0.9227,lon:104.532,elev:16},
    {id:"96529",name:"Tanjung Redep / Berau",lat:2.1167,lon:117.45,elev:26},
    {id:"96525",name:"Tanjung Selor",lat:2.85,lon:117.3333,elev:50},
    {id:"96249",name:"Tanjungpandan / Buluh Tumbang",lat:-2.75,lon:107.75,elev:44},
    {id:"96091",name:"Tanjungpinang / Kijang",lat:0.9167,lon:104.5333,elev:18},
    {id:"96509",name:"Tarakan / Juwata",lat:3.3333,lon:117.5667,elev:6},
    {id:"96145",name:"Tarempa",lat:3.2,lon:106.25,elev:3},
    {id:"96797",name:"Tegal",lat:-6.85,lon:109.15,elev:10},
    {id:"96295",name:"Telukbetung / Beranti",lat:-5.2667,lon:105.1833,elev:96},
    {id:"97430",name:"Ternate / Babullah",lat:0.7833,lon:127.3833,elev:23},
    {id:"97028",name:"Toli-Toli / Lalos",lat:1.0167,lon:120.8,elev:2},
    {id:"97810",name:"Tual / Dumatubun",lat:-5.6833,lon:132.75,elev:12},
    {id:"97182",name:"Ujang Pandang",lat:-5.0667,lon:119.55,elev:14},
    {id:"97180",name:"Ujung Pandang / Hasanuddin",lat:-5.0667,lon:119.55,elev:14},
    {id:"97340",name:"Waingapu / Mau Hau",lat:-9.6667,lon:120.3333,elev:12},
    {id:"97686",name:"Wamena / Wamena",lat:-4.0667,lon:138.95,elev:1660}
];

const state = {
    selectedCity: null,
    selectedStation: null,
    lastResult: null,
    dataSource: "open-meteo",
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
    els.dataSource = document.getElementById("data-source");
    els.meteostatKeySection = document.getElementById("meteostat-key-section");
    els.rapidapiKey = document.getElementById("rapidapi-key");
    els.citySection = document.getElementById("city-section");
    els.stationSection = document.getElementById("station-section");
    els.stationSearch = document.getElementById("station-search");
    els.stationSelect = document.getElementById("station-select");
    els.selectedStationInfo = document.getElementById("selected-station");
    els.cityInput = document.getElementById("city-input");
    els.suggestions = document.getElementById("city-suggestions");
    els.selectedCity = document.getElementById("selected-city");
    els.startDate = document.getElementById("start-date");
    els.endDate = document.getElementById("end-date");
    els.granularity = document.getElementById("granularity");
    els.granularityField = document.getElementById("granularity-field");
    els.timezone = document.getElementById("timezone");
    els.previewBtn = document.getElementById("preview-btn");
    els.downloadBtn = document.getElementById("download-btn");
    els.form = document.getElementById("weather-form");
    els.status = document.getElementById("status");
    els.previewSection = document.getElementById("preview-section");
    els.previewInfo = document.getElementById("preview-info");
    els.previewTable = document.getElementById("preview-table");
    els.openmeteoVars = document.getElementById("openmeteo-vars");
    els.meteostatVars = document.getElementById("meteostat-vars");
    els.sourceNote = document.getElementById("source-note");

    const today = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(today.getDate() - 7);
    els.startDate.value = isoDate(weekAgo);
    els.endDate.value = isoDate(today);

    setupCityAutocomplete();
    setupStationPicker();
    setupSourceSwitcher();

    els.windroseBtn = document.getElementById("windrose-btn");
    els.windroseSection = document.getElementById("windrose-section");
    els.windroseInfo = document.getElementById("windrose-info");
    els.windroseFrom = document.getElementById("windrose-from");
    els.windroseTo = document.getElementById("windrose-to");
    els.windroseLegend = document.getElementById("windrose-legend");

    els.previewBtn.addEventListener("click", () => handleSubmit({ download: false }));
    els.windroseBtn.addEventListener("click", () => handleWindrose());
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

// ----- Source switcher -----

function setupSourceSwitcher() {
    function syncSourceUI() {
        state.dataSource = els.dataSource.value;
        const isMeteostat = state.dataSource === "meteostat";

        els.meteostatKeySection.hidden = !isMeteostat;
        els.citySection.hidden = isMeteostat;
        els.stationSection.hidden = !isMeteostat;
        els.granularityField.hidden = isMeteostat;
        els.openmeteoVars.hidden = isMeteostat;
        els.meteostatVars.hidden = !isMeteostat;

        if (isMeteostat) {
            els.granularity.value = "daily";
            els.sourceNote.textContent =
                "Sumber: observasi stasiun Meteostat (NOAA ISD/SYNOP). " +
                "Data harian, hingga 10 tahun ke belakang. Kecepatan angin dalam m/s.";
        } else {
            els.sourceNote.textContent =
                "Sumber: ERA5 reanalysis (1940 \u2013 ~5 hari yang lalu) untuk historis, " +
                "dan model forecast untuk 16 hari ke depan. Sistem otomatis memilih.";
        }
    }

    els.dataSource.addEventListener("change", syncSourceUI);
    syncSourceUI();
}

// ----- Station picker -----

function setupStationPicker() {
    populateStationDropdown(INDONESIA_STATIONS);

    els.stationSearch.addEventListener("input", () => {
        const q = els.stationSearch.value.trim().toLowerCase();
        if (!q) {
            populateStationDropdown(INDONESIA_STATIONS);
            return;
        }
        const filtered = INDONESIA_STATIONS.filter((s) =>
            s.name.toLowerCase().includes(q)
        );
        populateStationDropdown(filtered);
    });

    els.stationSelect.addEventListener("change", () => {
        const id = els.stationSelect.value;
        if (!id) {
            state.selectedStation = null;
            els.selectedStationInfo.textContent = "Belum ada stasiun yang dipilih.";
            els.selectedStationInfo.classList.remove("success");
            return;
        }
        const station = INDONESIA_STATIONS.find((s) => s.id === id);
        if (station) {
            state.selectedStation = station;
            els.selectedStationInfo.innerHTML =
                `Terpilih: <strong>${escapeHtml(station.name)}</strong> ` +
                `(${station.lat}, ${station.lon}, elevasi: ${station.elev}m)`;
            els.selectedStationInfo.classList.add("success");
        }
    });
}

function populateStationDropdown(stations) {
    const current = els.stationSelect.value;
    els.stationSelect.innerHTML = '<option value="">-- Pilih stasiun --</option>';
    for (const s of stations) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.name} (${s.lat}, ${s.lon}, ${s.elev}m)`;
        els.stationSelect.appendChild(opt);
    }
    if (current && stations.some((s) => s.id === current)) {
        els.stationSelect.value = current;
    }
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
    if (state.dataSource === "meteostat") {
        return handleMeteostatSubmit({ download });
    }

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

async function handleMeteostatSubmit({ download }) {
    if (!state.selectedStation) {
        showStatus("Pilih stasiun cuaca dulu.", "error");
        return;
    }
    const apiKey = els.rapidapiKey.value.trim();
    if (!apiKey) {
        showStatus("Masukkan RapidAPI key untuk mengakses Meteostat.", "error");
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

    const start = parseLocalDate(startDate);
    const end = parseLocalDate(endDate);
    const diffYears = (end - start) / (1000 * 60 * 60 * 24 * 365.25);
    if (diffYears > 10) {
        showStatus("Meteostat mendukung maksimal 10 tahun per request.", "error");
        return;
    }

    setLoading(true);
    showStatus("Mengambil data dari Meteostat...", "loading");

    try {
        const result = await fetchMeteostatDaily({
            station: state.selectedStation,
            startDate,
            endDate,
            apiKey,
            timezone: els.timezone.value,
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

async function fetchMeteostatDaily({ station, startDate, endDate, apiKey }) {
    const url = `${METEOSTAT_API}/stations/daily?station=${station.id}` +
        `&start=${startDate}&end=${endDate}&units=scientific`;

    const res = await fetch(url, {
        headers: {
            "X-RapidAPI-Key": apiKey,
            "X-RapidAPI-Host": "meteostat.p.rapidapi.com",
        },
    });

    if (!res.ok) {
        let detail = "";
        try {
            const j = await res.clone().json();
            detail = j.message || JSON.stringify(j);
        } catch (_) {
            detail = await res.text();
        }
        throw new Error(`Meteostat HTTP ${res.status}: ${detail}`);
    }

    const json = await res.json();
    const records = json.data || [];

    const headers = [
        "Tanggal",
        "Suhu Rata-rata (\u00b0C)",
        "Curah Hujan (mm)",
        "Kecepatan Angin (m/s)",
        "Arah Angin (\u00b0)",
        "Lama Penyinaran (jam)",
    ];

    const rows = records.map((d) => [
        d.date,
        d.tavg,
        d.prcp,
        d.wspd,
        d.wdir,
        d.tsun != null ? +(d.tsun / 60).toFixed(2) : null,
    ]);

    return {
        headers,
        rows,
        meta: {
            station,
            startDate,
            endDate,
            granularity: "daily",
            timezone: els.timezone.value,
            sources: ["meteostat"],
            dataSource: "meteostat",
        },
    };
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
            dataSource: "open-meteo",
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
        wind_speed_unit: "ms",
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

    const meta = result.meta;
    let infoText = "";
    if (meta.dataSource === "meteostat") {
        infoText =
            `Stasiun: ${meta.station.name} \u00b7 Periode: ${meta.startDate} \u2192 ${meta.endDate}` +
            ` \u00b7 Granularitas: daily \u00b7 Sumber: Meteostat` +
            ` \u00b7 Total baris: ${result.rows.length}`;
    } else {
        const { city, startDate, endDate, granularity, sources } = meta;
        const parts = [city.name];
        if (city.admin1) parts.push(city.admin1);
        if (city.country) parts.push(city.country);
        infoText =
            `Kota: ${parts.join(", ")} \u00b7 Periode: ${startDate} \u2192 ${endDate}` +
            ` \u00b7 Granularitas: ${granularity} \u00b7 Sumber: ${sources.join(" + ")}` +
            ` \u00b7 Total baris: ${result.rows.length}`;
    }
    els.previewInfo.textContent = infoText;

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
    const meta = result.meta;
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

    let metaRows;
    if (meta.dataSource === "meteostat") {
        metaRows = [
            ["Field", "Value"],
            ["Stasiun", meta.station.name],
            ["Station ID", meta.station.id],
            ["Latitude", meta.station.lat],
            ["Longitude", meta.station.lon],
            ["Elevasi (m)", meta.station.elev],
            ["Zona waktu (request)", meta.timezone],
            ["Tanggal mulai", meta.startDate],
            ["Tanggal akhir", meta.endDate],
            ["Granularitas", "daily"],
            ["Sumber data", "Meteostat (NOAA ISD/SYNOP)"],
            ["Satuan angin", "m/s"],
            ["Diunduh pada", new Date().toISOString()],
        ];
    } else {
        const city = meta.city;
        const cityParts = [city.name];
        if (city.admin1) cityParts.push(city.admin1);
        if (city.country) cityParts.push(city.country);
        metaRows = [
            ["Field", "Value"],
            ["Kota", cityParts.join(", ")],
            ["Latitude", city.latitude],
            ["Longitude", city.longitude],
            ["Zona waktu (kota)", city.timezone || ""],
            ["Zona waktu (request)", meta.timezone],
            ["Tanggal mulai", meta.startDate],
            ["Tanggal akhir", meta.endDate],
            ["Granularitas", meta.granularity],
            ["Sumber data", meta.sources.join(" + ")],
            ["API", "Open-Meteo (open-meteo.com)"],
            ["Satuan angin", "m/s"],
            ["Diunduh pada", new Date().toISOString()],
        ];
    }
    const metaWs = XLSX.utils.aoa_to_sheet(metaRows);
    metaWs["!cols"] = [{ wch: 22 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, metaWs, "Info");

    let filename;
    if (meta.dataSource === "meteostat") {
        const safeName = (meta.station.name || "station").replace(/[^a-z0-9]+/gi, "_");
        filename = `meteostat_${safeName}_${meta.startDate}_to_${meta.endDate}_daily.xlsx`;
    } else {
        const safeCity = (meta.city.name || "city").replace(/[^a-z0-9]+/gi, "_");
        filename = `weather_${safeCity}_${meta.startDate}_to_${meta.endDate}_${meta.granularity}.xlsx`;
    }
    XLSX.writeFile(wb, filename);
}

// ----- Windrose -----

const WIND_DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const SPEED_BINS = [
    { min: 0, max: 2, label: "0\u20132 m/s", color: "#a3d5ff" },
    { min: 2, max: 4, label: "2\u20134 m/s", color: "#4da6ff" },
    { min: 4, max: 6, label: "4\u20136 m/s", color: "#0066cc" },
    { min: 6, max: 8, label: "6\u20138 m/s", color: "#ff9933" },
    { min: 8, max: Infinity, label: "8+ m/s", color: "#cc3300" },
];

async function handleWindrose() {
    if (state.dataSource === "meteostat") {
        return handleMeteostatWindrose();
    }

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

    setLoading(true);
    els.windroseBtn.disabled = true;
    showStatus("Mengambil data angin untuk windrose...", "loading");

    try {
        const windData = await fetchWindData({
            city: state.selectedCity,
            startDate,
            endDate,
            timezone: els.timezone.value,
        });

        const fromBins = binWindData(windData, false);
        const toBins = binWindData(windData, true);

        drawWindrose(els.windroseFrom, fromBins);
        drawWindrose(els.windroseTo, toBins);
        renderWindroseLegend();

        const parts = [state.selectedCity.name];
        if (state.selectedCity.admin1) parts.push(state.selectedCity.admin1);
        if (state.selectedCity.country) parts.push(state.selectedCity.country);
        els.windroseInfo.textContent =
            `Kota: ${parts.join(", ")} \u00b7 Periode: ${startDate} \u2192 ${endDate}` +
            ` \u00b7 Total observasi: ${windData.length}`;
        els.windroseSection.hidden = false;

        showStatus(`Windrose ditampilkan. ${windData.length} data observasi angin.`, "success");
    } catch (err) {
        console.error(err);
        showStatus(`Gagal: ${err.message}`, "error");
    } finally {
        setLoading(false);
        els.windroseBtn.disabled = false;
    }
}

async function handleMeteostatWindrose() {
    if (!state.selectedStation) {
        showStatus("Pilih stasiun cuaca dulu.", "error");
        return;
    }
    const apiKey = els.rapidapiKey.value.trim();
    if (!apiKey) {
        showStatus("Masukkan RapidAPI key untuk mengakses Meteostat.", "error");
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

    setLoading(true);
    els.windroseBtn.disabled = true;
    showStatus("Mengambil data angin Meteostat untuk windrose...", "loading");

    try {
        const result = await fetchMeteostatDaily({
            station: state.selectedStation,
            startDate,
            endDate,
            apiKey,
        });

        const windData = [];
        for (const row of result.rows) {
            const wspd = row[3];
            const wdir = row[4];
            if (wspd != null && wdir != null) {
                windData.push({ speed: wspd, direction: wdir });
            }
        }

        const fromBins = binWindData(windData, false);
        const toBins = binWindData(windData, true);

        drawWindrose(els.windroseFrom, fromBins);
        drawWindrose(els.windroseTo, toBins);
        renderWindroseLegend();

        els.windroseInfo.textContent =
            `Stasiun: ${state.selectedStation.name} \u00b7 Periode: ${startDate} \u2192 ${endDate}` +
            ` \u00b7 Total observasi harian: ${windData.length}`;
        els.windroseSection.hidden = false;

        showStatus(`Windrose ditampilkan. ${windData.length} data observasi angin harian.`, "success");
    } catch (err) {
        console.error(err);
        showStatus(`Gagal: ${err.message}`, "error");
    } finally {
        setLoading(false);
        els.windroseBtn.disabled = false;
    }
}

async function fetchWindData({ city, startDate, endDate, timezone }) {
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

    const windData = [];
    for (const seg of segments) {
        const data = await callOpenMeteo({
            kind: seg.kind,
            latitude: city.latitude,
            longitude: city.longitude,
            startDate: isoDate(seg.start),
            endDate: isoDate(seg.end),
            apiVars: ["wind_speed_10m", "wind_direction_10m"],
            granularity: "hourly",
            timezone,
        });
        const block = data.hourly;
        if (!block || !block.time) continue;
        for (let i = 0; i < block.time.length; i++) {
            const speed = block.wind_speed_10m?.[i];
            const dir = block.wind_direction_10m?.[i];
            if (speed != null && dir != null) {
                windData.push({ speed, direction: dir });
            }
        }
    }
    return windData;
}

function binWindData(windData, blowingTo) {
    const numDirs = WIND_DIRS.length;
    const binSize = 360 / numDirs;
    const bins = Array.from({ length: numDirs }, () =>
        SPEED_BINS.map(() => 0)
    );

    for (const { speed, direction } of windData) {
        let dir = direction;
        if (blowingTo) dir = (dir + 180) % 360;
        let idx = Math.round(dir / binSize) % numDirs;
        let speedIdx = SPEED_BINS.findIndex((b) => speed >= b.min && speed < b.max);
        if (speedIdx === -1) speedIdx = SPEED_BINS.length - 1;
        bins[idx][speedIdx]++;
    }

    const total = windData.length || 1;
    return bins.map((dirBins) => dirBins.map((count) => (count / total) * 100));
}

function drawWindrose(canvas, bins) {
    const dpr = window.devicePixelRatio || 1;
    const size = 420;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const maxRadius = size / 2 - 40;

    const maxPct = Math.max(1, ...bins.map((d) => d.reduce((a, b) => a + b, 0)));
    const ringStep = Math.ceil(maxPct / 4);
    const numRings = Math.ceil(maxPct / ringStep);

    ctx.strokeStyle = "#e0e0e0";
    ctx.lineWidth = 0.5;
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let r = 1; r <= numRings; r++) {
        const radius = (r / numRings) * maxRadius;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillText(`${r * ringStep}%`, cx + 4, cy - radius + 10);
    }

    const numDirs = WIND_DIRS.length;
    const angleStep = (Math.PI * 2) / numDirs;
    const halfPetal = angleStep * 0.4;

    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 0.5;
    for (let i = 0; i < numDirs; i++) {
        const angle = i * angleStep - Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * (maxRadius + 15), cy + Math.sin(angle) * (maxRadius + 15));
        ctx.stroke();
    }

    for (let i = 0; i < numDirs; i++) {
        const angle = i * angleStep - Math.PI / 2;
        const dirBins = bins[i];
        let cumPct = 0;

        for (let s = 0; s < SPEED_BINS.length; s++) {
            const pct = dirBins[s];
            if (pct <= 0) { cumPct += pct; continue; }
            const innerR = (cumPct / maxPct) * maxRadius;
            const outerR = ((cumPct + pct) / maxPct) * maxRadius;

            ctx.beginPath();
            ctx.moveTo(
                cx + Math.cos(angle - halfPetal) * innerR,
                cy + Math.sin(angle - halfPetal) * innerR
            );
            ctx.arc(cx, cy, outerR, angle - halfPetal, angle + halfPetal);
            ctx.lineTo(
                cx + Math.cos(angle + halfPetal) * innerR,
                cy + Math.sin(angle + halfPetal) * innerR
            );
            if (innerR > 0) {
                ctx.arc(cx, cy, innerR, angle + halfPetal, angle - halfPetal, true);
            }
            ctx.closePath();
            ctx.fillStyle = SPEED_BINS[s].color;
            ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.6)";
            ctx.lineWidth = 0.5;
            ctx.stroke();

            cumPct += pct;
        }
    }

    ctx.fillStyle = "#1f2937";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < numDirs; i++) {
        const angle = i * angleStep - Math.PI / 2;
        const labelR = maxRadius + 25;
        const x = cx + Math.cos(angle) * labelR;
        const y = cy + Math.sin(angle) * labelR;
        if (i % 2 === 0) {
            ctx.fillText(WIND_DIRS[i], x, y);
        }
    }
}

function renderWindroseLegend() {
    els.windroseLegend.innerHTML = "";
    for (const bin of SPEED_BINS) {
        const item = document.createElement("div");
        item.className = "windrose-legend-item";
        item.innerHTML = `<span class="windrose-legend-swatch" style="background:${bin.color}"></span>${bin.label}`;
        els.windroseLegend.appendChild(item);
    }
}
