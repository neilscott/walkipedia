(function () {
  "use strict";

  // Walks at an easy 4.8 km/h: 20 minutes, 40 minutes or 2 hours. If that turns up very
  // little, widen the net to Wikipedia's 10 km maximum and keep just the nearest few.
  const WALKS = [["short", "short", 1600], ["medium", "medium", 3200], ["long", "long", 9600]];
  const WALK_RADIUS = Object.fromEntries(WALKS.map(([key, , r]) => [key, r]));
  const WIDE_RADIUS = 10000;
  const MIN_RESULTS = 25;
  const MAX_RESULTS = 500;            // the most geosearch will return in one go
  const METRES_PER_MINUTE = 80;

  // Each language edition geotags its own articles, so switching language changes what's found,
  // not just how it reads. Names are given in their own language. Welsh, Gaelic and Irish are
  // missing because their articles take coordinates from Wikidata, which geosearch can't see.
  const LANGUAGES = [
    ["en", "English"], ["simple", "Simple English"], ["sco", "Scots"], ["fr", "Français"], ["de", "Deutsch"], ["es", "Español"],
    ["it", "Italiano"], ["nl", "Nederlands"], ["pt", "Português"], ["pl", "Polski"], ["sv", "Svenska"],
    ["ru", "Русский"], ["uk", "Українська"], ["ar", "العربية"], ["zh", "中文"], ["ja", "日本語"],
  ];
  const LANG_NAME = Object.fromEntries(LANGUAGES);
  let lang = "en";
  try { if (LANG_NAME[localStorage.getItem("walkipedia-lang")]) lang = localStorage.getItem("walkipedia-lang"); } catch (_) {}
  const urlLang = new URL(location.href).searchParams.get("lang");
  if (LANG_NAME[urlLang]) lang = urlLang;

  let walk = "short";
  const urlWalk = new URL(location.href).searchParams.get("walk");
  if (WALK_RADIUS[urlWalk]) walk = urlWalk;

  const wikiHost = (l = lang) => `https://${l}.wikipedia.org`;
  const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

  // Each article's kind is guessed from its Wikidata short description (e.g. "railway station
  // in Glasgow, Scotland") and title. First match wins, so the order matters.
  const KINDS = [
    { key: "transport", label: "Transport",              color: "#2a6fb0",
      re: /\b(station|railway|tramway|subway|metro|underground|bridge|viaduct|tunnel|canal|road|street|avenue|motorway|airport|harbour|port|dock|quay|bus|ferry|junction|lane)\b/ },
    { key: "nature",    label: "Parks & nature",         color: "#3f8a3a",
      re: /\b(park|garden|gardens|river|burn|stream|loch|lake|reservoir|hill|mountain|woodland|wood|forest|nature reserve|beach|island|bay|common|green|meadow|moor|glen|valley|waterfall)\b/ },
    { key: "history",   label: "History & memorials",    color: "#a3502f",
      re: /\b(memorial|monument|statue|cemetery|graveyard|necropolis|archaeological|ruin|ruins|battle|fort|roman|abbey|priory|castle|war|heritage|historic|listed|scheduled)\b/ },
    { key: "faith",     label: "Places of worship",      color: "#7a4fa0",
      re: /\b(church|cathedral|chapel|kirk|mosque|synagogue|temple|gurdwara|parish|minster|basilica|diocese|convent|monastery)\b/ },
    { key: "culture",   label: "Culture & leisure",      color: "#c2397a",
      re: /\b(museum|gallery|theatre|theater|cinema|concert|music venue|arts?|library|pub|bar|restaurant|cafe|hotel|club|stadium|arena|ground|sports|leisure|festival|shop|shopping|market|nightclub|venue)\b/ },
    { key: "civic",     label: "Schools & civic",        color: "#b07a12",
      re: /\b(school|university|college|academy|hospital|infirmary|police|fire station|court|council|town hall|city chambers|prison|barracks|embassy|office|headquarters|company|bank)\b/ },
    { key: "place",     label: "Areas & neighbourhoods", color: "#4a7d86",
      re: /\b(area|district|suburb|neighbourhood|neighborhood|village|town|city|ward|constituency|parish|locality|estate|quarter|square|human settlement|hamlet)\b/ },
    { key: "building",  label: "Buildings",              color: "#56606b",
      re: /\b(building|house|tower|hall|mansion|villa|tenement|terrace|block|skyscraper|factory|mill|warehouse|works|exchange|arcade|centre|center|structure)\b/ },
    { key: "other",     label: "Everything else",        color: "#8a9199", re: /.^/ },
  ];
  const KIND = Object.fromEntries(KINDS.map(k => [k.key, k]));
  // Away from English, the English Wikidata description (kindText) does the guessing.
  const kindOf = a => {
    const s = `${a.kindText ?? a.description ?? ""} ${a.title}`.toLowerCase();
    return KINDS.find(k => k.re.test(s)) || KIND.other;
  };

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const wikiUrl = (title, l) => `${wikiHost(l)}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const walkText = d => {
    const mins = Math.max(1, Math.round(d / METRES_PER_MINUTE));
    const dist = d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`;
    return mins > 60 ? dist : `${mins} min walk · ${dist}`;
  };

  // A busy or rate-limited service often answers on a second try, so retry once after a pause.
  async function getJSON(url, retry = true) {
    const res = await fetch(url);
    if (retry && (res.status === 429 || res.status >= 500)) {
      await new Promise(r => setTimeout(r, 1500));
      return getJSON(url, false);
    }
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  }
  const api = (base, params) => getJSON(`${base}?${new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params })}`);
  const wiki = params => api(`${wikiHost()}/w/api.php`, params);

  // ---------- map ----------
  // maxZoom is set here because the MapLibre layers don't declare one, and the clusterer needs it.
  const map = L.map("map", { zoomControl: true, maxZoom: 19 }).setView([54.6, -3.2], 5);
  // OpenFreeMap's vector styles are drawn from OSM data but calmer than the standard OSM
  // tiles, and stay sharp at any zoom or screen density. No API key needed (CARTO now wants one).
  // MapLibre draws them inside Leaflet, so clusters and popups work as before.
  // The classic OSM raster tiles are the fallback without WebGL.
  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const OFM = `<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ${OSM}`;
  const hasWebGL = (() => {
    try { return !!document.createElement("canvas").getContext("webgl"); } catch (_) { return false; }
  })();
  (hasWebGL && L.maplibreGL
    ? L.maplibreGL({ style: "https://tiles.openfreemap.org/styles/liberty", attribution: OFM })
    : L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: OSM, className: "osm-classic" })
  ).addTo(map);

  // The masthead is sticky and its height changes as it wraps, so publish it for the CSS
  // that pins the map and list controls beneath it.
  const masthead = $(".masthead");
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--mast-h", `${masthead.offsetHeight}px`);
    map.invalidateSize();
  }).observe(masthead);

  const cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 38,
    spiderfyOnMaxZoom: true,
    // Keep off-screen markers on the map, so an open popup isn't taken away with its marker.
    removeOutsideVisibleBounds: false,
    iconCreateFunction: c => {
      const n = c.getChildCount();
      const size = n < 10 ? "sm" : n < 50 ? "md" : "lg";
      const px = { sm: 30, md: 38, lg: 46 }[size];
      return L.divIcon({ html: `<div class="wiki-cluster ${size}">${n}</div>`, className: "", iconSize: [px, px] });
    },
  }).addTo(map);

  const overlay = L.layerGroup().addTo(map);   // walking circle and "you are here"

  // ---------- state ----------
  const state = {
    run: 0,                  // bumps on every search, so late replies from an old one are ignored
    centre: null,
    radius: WALK_RADIUS[walk],
    articles: [],
    kind: "all",
    q: "",
    sort: "distance",
    activeId: null,
  };
  const markers = new Map();
  const extracts = new Map();

  // Articles saved for a walk stay in this browser. Page ids belong to one wiki, so each keeps its language.
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("walkipedia-saved")) || []; } catch (_) {}
  const isSaved = a => saved.some(s => s.lang === lang && s.id === a.id);

  const loader = $("#map-loader");
  const notice = $("#notice");
  const setStatus = (msg, isError = false) => {
    $("#status").textContent = msg || "";
    notice.classList.toggle("is-error", isError);
    notice.hidden = !msg;
  };
  $("#notice-close").addEventListener("click", () => setStatus(""));
  const setLoading = msg => {
    loader.hidden = !msg;
    if (msg) $("#loader-text").textContent = msg;
    document.querySelectorAll(".place-form .btn").forEach(b => (b.disabled = !!msg));
  };

  // ---------- finding a place ----------
  const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
  const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

  // Returns every plausible match, best first. A UK postcode only ever has one.
  async function geocode(q) {
    // UK postcodes are more reliable via postcodes.io than a general geocoder.
    if (POSTCODE.test(q) || OUTCODE.test(q)) {
      const kind = POSTCODE.test(q) ? "postcodes" : "outcodes";
      try {
        const { result: r } = await getJSON(`https://api.postcodes.io/${kind}/${encodeURIComponent(q.replace(/\s+/g, ""))}`);
        if (r && r.latitude != null) {
          const where = r.admin_ward || (r.admin_district && [].concat(r.admin_district)[0]);
          return [{ lat: r.latitude, lon: r.longitude, label: (r.postcode || r.outcode || q.toUpperCase()), detail: where, importance: 1 }];
        }
      } catch (_) { /* not a real postcode, or postcodes.io is down: let Nominatim have a go */ }
    }
    try {
      return await nominatim(q);
    } catch (e) {
      console.error(e);
      return photon(q);
    }
  }

  // Nominatim ranks towns and landmarks far better than Photon (which sent
  // "Tongue, Sutherland" to Sydney). One request per search keeps within its usage policy.
  async function nominatim(q) {
    const results = await getJSON(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({
      q, format: "jsonv2", limit: "8", "accept-language": "en",
    })}`);
    const places = [];
    results.forEach(r => {
      // drop postcodes and ZIP codes (G2 1AL, 04530, 1012 AB…) from the address
      const parts = r.display_name.split(", ").filter(p => !/^(?=.*\d)[A-Z0-9 -]{3,10}$/i.test(p));
      const label = r.name || parts[0] || q;
      const rest = parts.filter(p => p !== label);
      // the nearest bit of context, plus the region and country
      const detail = [...new Set([rest[0], rest[rest.length - 2], rest[rest.length - 1]].filter(Boolean))].join(", ");
      const place = {
        lat: Number(r.lat), lon: Number(r.lon), label, detail,
        type: String(r.addresstype || r.type || "").replace(/_/g, " "),
        importance: r.importance || 0,
      };
      // A town often comes back twice (its centre and its boundary): keep one.
      if (!places.some(p => p.label === place.label && L.latLng(p).distanceTo(place) < 5000)) places.push(place);
    });
    return places;
  }

  // Photon is the backup for when Nominatim is busy or blocking us. It gives no importance
  // score, so its order stands and the first match is taken without asking.
  async function photon(q) {
    const d = await getJSON(`https://photon.komoot.io/api/?${new URLSearchParams({ q, limit: "8", lang: "en" })}`);
    return (d.features || []).map((f, i) => {
      const p = f.properties;
      const label = p.name || p.street || p.postcode || q;
      return {
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label,
        detail: [...new Set([p.city || p.county, p.state, p.country].filter(x => x && x !== label))].join(", "),
        type: String(p.type || p.osm_value || "").replace(/_/g, " "),
        importance: 1 - i * 0.2,
      };
    });
  }

  // Close enough in prominence that we shouldn't just guess. At 0.85, Glasgow and Bath go
  // straight to the UK ones; Springfield, Newport and Whitby ask.
  const isAmbiguous = places => places.length > 1 && places[1].importance >= places[0].importance * 0.85;

  async function placeName(lat, lon) {
    try {
      const r = await getJSON(`https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({
        lat, lon, format: "jsonv2", zoom: "14", "accept-language": "en",
      })}`);
      const a = r.address || {};
      return a.suburb || a.neighbourhood || a.village || a.town || a.city || r.name || null;
    } catch (_) {
      try {
        const d = await getJSON(`https://photon.komoot.io/reverse?${new URLSearchParams({ lat, lon, lang: "en" })}`);
        const p = d.features?.[0]?.properties || {};
        return p.district || p.locality || p.city || p.name || null;
      } catch (_) { return null; }
    }
  }

  // ---------- fetching articles ----------
  const geosearch = (lat, lon, radius) => wiki({
    action: "query", list: "geosearch", gscoord: `${lat}|${lon}`, gsradius: String(radius),
    gslimit: String(MAX_RESULTS), gsnamespace: "0", gsprimary: "primary",
  }).then(d => d.query?.geosearch || []);

  async function findNearby(lat, lon) {
    let radius = WALK_RADIUS[walk];
    let found = await geosearch(lat, lon, radius);
    if (found.length < MIN_RESULTS) {
      found = (await geosearch(lat, lon, WIDE_RADIUS)).slice(0, MIN_RESULTS);
      radius = found.length ? found[found.length - 1].dist : WIDE_RADIUS;
    }
    return { radius, articles: found.map(g => ({ id: String(g.pageid), title: g.title, lat: g.lat, lon: g.lon, dist: g.dist })) };
  }

  // Thumbnails and short descriptions, 50 at a time, filled in as they arrive.
  async function fetchDetails(run) {
    const byId = new Map(state.articles.map(a => [a.id, a]));
    const ids = [...byId.keys()];
    const batches = [];
    for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
    const fetchBatch = async batch => {
      const d = await wiki({
        action: "query", pageids: batch.join("|"), prop: "pageimages|description|pageprops",
        piprop: "thumbnail", pithumbsize: "320", pilimit: "50", ppprop: "wikibase_item",
      });
      if (run !== state.run) return;
      const pages = d.query?.pages || [];
      pages.forEach(p => {
        const a = byId.get(String(p.pageid));
        if (!a) return;
        a.description = p.description || "";
        a.thumb = p.thumbnail?.source || "";
        a.kind = kindOf(a);
      });
      refresh();
      if (lang === "en" || lang === "simple") return;
      const byItem = new Map(pages.filter(p => p.pageprops?.wikibase_item).map(p => [p.pageprops.wikibase_item, byId.get(String(p.pageid))]));
      if (!byItem.size) return;
      const w = await api(WIKIDATA_API, { action: "wbgetentities", ids: [...byItem.keys()].join("|"), props: "descriptions", languages: "en" });
      if (run !== state.run) return;
      byItem.forEach((a, q) => {
        if (!a) return;
        a.kindText = w.entities?.[q]?.descriptions?.en?.value || "";
        a.kind = kindOf(a);
      });
      refresh();
    };
    // Three requests at a time keeps it quick without hammering the API.
    for (let i = 0; i < batches.length; i += 3) {
      await Promise.all(batches.slice(i, i + 3).map(b => fetchBatch(b).catch(console.error)));
      if (run !== state.run) return;
    }
  }

  async function fetchExtract(a) {
    if (extracts.has(a.id)) return extracts.get(a.id);
    const d = await wiki({ action: "query", pageids: a.id, prop: "extracts", exintro: "1", explaintext: "1", exsentences: "3" });
    // exsentences isn't always honoured, so keep to the first couple of sentences here.
    const sentences = (d.query?.pages?.[0]?.extract || "").trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
    let text = sentences.shift() || "";
    while (sentences.length && text.length + sentences[0].length < 280) text += " " + sentences.shift();
    if (text.length > 400) text = text.slice(0, 380).replace(/\s+\S*$/, "") + "…";
    extracts.set(a.id, text);
    return text;
  }

  // ---------- searching ----------
  async function search({ lat, lon, label, detail, shareQuery }) {
    const run = ++state.run;
    closeTour();
    state.centre = L.latLng(lat, lon);
    state.last = { lat, lon, label, detail };
    $("#search-here").hidden = true;
    choicesEl.hidden = true;
    alsoEl.hidden = true;
    choiceLayer.clearLayers();
    map.closePopup();
    setStatus("");
    setLoading("Mapping the articles…");

    if (shareQuery !== undefined) {
      const url = new URL(location.href);
      if (shareQuery) url.searchParams.set("q", shareQuery); else url.searchParams.delete("q");
      history.replaceState(null, "", url);
    }

    try {
      const { radius, articles } = await findNearby(lat, lon);
      if (run !== state.run) return;
      articles.forEach(a => (a.kind = KIND.other));
      state.articles = articles;
      state.radius = radius;
      state.kind = "all";
      state.q = "";
      $("#filter-text").value = "";

      overlay.clearLayers();
      const circle = L.circle(state.centre, {
        radius, color: "#36c", weight: 1.5, dashArray: "5 6", fillColor: "#36c", fillOpacity: .04, interactive: false,
      }).addTo(overlay);
      L.marker(state.centre, {
        icon: L.divIcon({ html: '<div class="you-marker"></div>', className: "", iconSize: [18, 18] }),
        interactive: false, keyboard: false, zIndexOffset: -1000,
      }).addTo(overlay);
      map.fitBounds(circle.getBounds(), { padding: [20, 20] });

      buildMarkers();
      $("#intro").hidden = true;
      $("#results").hidden = false;
      setTitle(label, detail, radius, articles.length);
      refresh();
      setLoading(null);

      fetchDetails(run);
    } catch (e) {
      if (run !== state.run) return;
      console.error(e);
      setLoading(null);
      setStatus("Couldn’t reach Wikipedia just now. Check your connection and try again.", true);
    }
  }

  function setTitle(label, detail, radius, n) {
    const where = label === "you" ? "you" : label;
    const wide = radius > WALK_RADIUS[walk] || n < MIN_RESULTS;
    $("#results-title").innerHTML = !n ? `Nothing near ${esc(where)}`
      : wide ? `Not much within a ${walkSelect()} walk of ${esc(where)}`
      : `Within a ${walkSelect()} walk of ${esc(where)}`;
    $("#results-title").title = detail || "";
    state.titleNote = !n ? ""
      : wide
      ? `The nearest reach out to ${walkText(radius).split(" · ").pop()}.`
      : n >= MAX_RESULTS ? `There’s a lot round here — showing the closest ${MAX_RESULTS}.` : "";
    document.title = `${where === "you" ? "Near you" : where} · Walkipedia`;
  }

  const NOTHING_NEARBY = `
    <strong>Wikipedia has nothing within 10 km of here.</strong>
    That’s a good two hours on foot, so wherever this is, it’s properly off the beaten track: pack a backpack, some water and a paper map.
    Or drag the map towards somewhere busier and tap <em>Search this area</em>.`;

  // ---------- markers ----------
  const markerIcon = a => L.divIcon({
    html: `<div class="wiki-marker${isSaved(a) ? " is-saved" : ""}" style="--kind:${a.kind.color}" data-id="${a.id}"></div>`,
    className: "", iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10],
  });

  function buildMarkers() {
    cluster.clearLayers();
    markers.clear();
    state.activeId = null;
    state.articles.forEach(a => {
      const m = L.marker([a.lat, a.lon], { icon: markerIcon(a), title: a.title, riseOnHover: true });
      m.iconKind = a.kind;
      m.bindPopup(() => popupHtml(a), { maxWidth: 280, minWidth: 280, autoPanPadding: [24, 24] });
      m.on("popupopen", e => onPopupOpen(a, e.popup));
      m.on("popupclose", () => setActive(null));
      markers.set(a.id, m);
    });
  }

  const popupHtml = a => `
    <div class="popup" style="--kind:${a.kind.color}">
      ${a.thumb ? `<img src="${esc(a.thumb)}" alt="" loading="lazy">` : ""}
      <div class="popup-body">
        <span class="kind-tag">${esc(a.kind.label)}</span>
        <h3>${esc(a.title)}</h3>
        ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ""}
        <p class="extract${extracts.has(a.id) ? "" : " is-loading"}">${extracts.has(a.id) ? esc(extracts.get(a.id)) : "Loading summary…"}</p>
        <button type="button" class="btn btn-save" data-save="${a.id}" aria-pressed="${isSaved(a)}">${STAR}<span class="save-text">${saveText(isSaved(a))}</span></button>
        <div class="popup-foot">
          <span class="walk">${esc(walkText(a.dist))}</span>
          <a href="${wikiUrl(a.title)}" target="_blank" rel="noopener">Read on Wikipedia →</a>
        </div>
      </div>
    </div>`;

  function onPopupOpen(a, popup) {
    setActive(a.id, { scroll: true });
    const el = popup.getElement();
    el?.classList.toggle("no-photo", !a.thumb);
    const maxHeight = Math.max(180, map.getSize().y - 60);
    if (popup.options.maxHeight !== maxHeight) { popup.options.maxHeight = maxHeight; popup.update(); }
    if (extracts.has(a.id)) return;
    fetchExtract(a).then(text => {
      const p = popup.getElement()?.querySelector(".extract");
      if (!p || !map.hasLayer(popup)) return;
      p.classList.remove("is-loading");
      p.textContent = text || "No summary available.";
      popup.update();
    }).catch(() => {
      const p = popup.getElement()?.querySelector(".extract");
      if (p) p.textContent = "Couldn’t load the summary.";
    });
  }

  // ---------- list & filters ----------
  const listEl = $("#article-list");

  function matches(a) {
    if (state.kind !== "all" && a.kind.key !== state.kind) return false;
    if (!state.q) return true;
    const hay = `${a.title} ${a.description || ""}`.toLowerCase();
    return state.q.split(/\s+/).every(w => hay.includes(w));
  }

  const sortKey = a => a.title.replace(/^(the|a) /i, "");
  const sorted = list => state.sort === "title"
    ? [...list].sort((x, y) => sortKey(x).localeCompare(sortKey(y), lang === "en" || lang === "simple" ? "en-GB" : lang, { numeric: true }))
    : [...list].sort((x, y) => x.dist - y.dist);

  // Called whenever results, details, filters or sorting change. Batched to one frame,
  // since detail batches can land in quick succession.
  let refreshQueued = false;
  function refresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshQueued = false; render(); });
  }

  function render() {
    const all = state.articles;

    const counts = Object.fromEntries(KINDS.map(k => [k.key, 0]));
    all.forEach(a => counts[a.kind.key]++);
    $("#filters").innerHTML =
      `<button class="chip" type="button" data-kind="all" aria-pressed="${state.kind === "all"}">All <span class="n">${all.length}</span></button>` +
      KINDS.filter(k => counts[k.key] || state.kind === k.key).map(k =>
        `<button class="chip" type="button" data-kind="${k.key}" aria-pressed="${state.kind === k.key}" style="--kind:${k.color}">
          <span class="swatch"></span>${esc(k.label)} <span class="n">${counts[k.key]}</span></button>`).join("");

    // Markers: refresh any whose kind (colour) has just become known, and show only matches.
    const visible = all.filter(matches);
    const keep = new Set(visible.map(a => markers.get(a.id)));
    all.forEach(a => {
      const m = markers.get(a.id);
      if (m.iconKind !== a.kind) { m.iconKind = a.kind; m.setIcon(markerIcon(a)); }
    });
    cluster.removeLayers([...markers.values()].filter(m => !keep.has(m) && cluster.hasLayer(m)));
    cluster.addLayers([...keep].filter(m => !cluster.hasLayer(m)));

    listEl.innerHTML = sorted(visible).map(a => `
      <li class="article${a.id === state.activeId ? " is-active" : ""}" data-id="${a.id}" tabindex="0" style="--kind:${a.kind.color}"
          aria-label="${esc(a.title)}, ${esc(walkText(a.dist))} — show on map">
        ${a.thumb
          ? `<img class="thumb" src="${esc(a.thumb)}" alt="" loading="lazy">`
          : `<span class="thumb is-blank" aria-hidden="true">${esc(sortKey(a).charAt(0).toUpperCase())}</span>`}
        <div class="article-body">
          <h3><a href="${wikiUrl(a.title)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
          ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ""}
          <p class="walk"><span class="kind-dot"></span>${esc(walkText(a.dist))}</p>
        </div>
        <button type="button" class="save" data-save="${a.id}" aria-pressed="${isSaved(a)}" title="Add to your walk">${STAR}<span class="visually-hidden">Add to your walk</span></button>
      </li>`).join("") || `<li class="empty">${all.length ? "Nothing here matches." : NOTHING_NEARBY}</li>`;

    const n = visible.length;
    $("#results").classList.toggle("is-empty", !all.length);
    $("#result-count").textContent = [
      n === all.length ? `${n} article${n === 1 ? "" : "s"}` : `${n} of ${all.length} articles`,
      state.titleNote,
    ].filter(Boolean).join(" · ");
    if (state.activeId) setActive(state.activeId);
  }

  function setActive(id, { scroll = false } = {}) {
    document.querySelectorAll(".article.is-active, .wiki-marker.is-active").forEach(el => el.classList.remove("is-active"));
    state.activeId = id;
    if (!id) return;
    const row = listEl.querySelector(`.article[data-id="${id}"]`);
    row?.classList.add("is-active");
    document.querySelector(`.wiki-marker[data-id="${id}"]`)?.classList.add("is-active");
    if (scroll && row && window.matchMedia("(min-width: 901px)").matches) {
      const bar = $(".controls").getBoundingClientRect().bottom;
      const r = row.getBoundingClientRect();
      if (r.top < bar + 8 || r.bottom > window.innerHeight - 8) {
        window.scrollBy({ top: r.top - bar - 80, behavior: "smooth" });
      }
    }
  }

  function showOnMap(id) {
    const m = markers.get(id);
    if (!m || !cluster.hasLayer(m)) return;
    if (window.matchMedia("(max-width: 900px)").matches) {
      $(".map-panel").scrollIntoView({ behavior: "smooth" });
    }
    cluster.zoomToShowLayer(m, () => m.openPopup());
  }

  listEl.addEventListener("click", e => {
    if (e.target.closest("a, button")) return;
    const row = e.target.closest(".article");
    if (row) showOnMap(row.dataset.id);
  });
  listEl.addEventListener("keydown", e => {
    const row = e.target.closest(".article");
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      showOnMap(row.dataset.id);
    }
  });

  $("#filters").addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.kind = chip.dataset.kind;
    render();
  });

  let typing;
  $("#filter-text").addEventListener("input", e => {
    clearTimeout(typing);
    typing = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); render(); }, 120);
  });

  document.querySelector(".sort").addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state.sort = btn.dataset.sort;
    document.querySelectorAll(".sort button").forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
    render();
  });

  // ---------- which place did you mean? ----------
  const choicesEl = $("#choices");
  const alsoEl = $("#also");
  const choiceLayer = L.layerGroup().addTo(map);
  let choices = [];

  const placeLine = p => [p.type && p.type[0].toUpperCase() + p.type.slice(1), p.detail].filter(Boolean).join(" · ");

  function showChoices(q, places) {
    choices = places;
    closeTour();
    $("#intro").hidden = true;
    $("#results").hidden = true;
    choicesEl.hidden = false;
    choicesEl.innerHTML = `
      <h2>Which ${esc(q)} did you mean?</h2>
      <ol class="choice-list">${places.map((p, i) => `
        <li><button type="button" class="choice" data-i="${i}">
          <span class="choice-n" aria-hidden="true">${i + 1}</span>
          <span><strong>${esc(p.label)}</strong><span class="choice-detail">${esc(placeLine(p))}</span></span>
        </button></li>`).join("")}
      </ol>`;

    // numbered pins, so you can pick from the map too
    cluster.clearLayers();
    overlay.clearLayers();
    choiceLayer.clearLayers();
    places.forEach((p, i) => L.marker([p.lat, p.lon], {
      icon: L.divIcon({ html: `<div class="choice-pin">${i + 1}</div>`, className: "", iconSize: [28, 28] }),
      title: `${p.label}, ${p.detail}`,
    }).on("click", () => pick(i)).addTo(choiceLayer));
    map.fitBounds(L.latLngBounds(places.map(p => [p.lat, p.lon])), { padding: [50, 50], maxZoom: 10 });
    choicesEl.querySelector(".choice")?.focus({ preventScroll: true });
  }

  function pick(i) {
    const p = choices[i];
    if (!p) return;
    // Share the fuller name, so the link lands on this place rather than asking again.
    search({ ...p, shareQuery: [p.label, p.detail].filter(Boolean).join(", ") });
  }

  // After a confident match, still offer the runners-up quietly.
  function showAlternatives(places) {
    choices = places;
    alsoEl.hidden = !places.length;
    alsoEl.innerHTML = `Not this one? ${places.map((p, i) =>
      `<button type="button" class="link-button" data-i="${i}">${esc(p.label)}<span class="also-where">, ${esc(p.detail.split(", ").slice(-2).join(", "))}</span></button>`
    ).join(" · ")}`;
  }

  choicesEl.addEventListener("click", e => {
    const btn = e.target.closest(".choice");
    if (btn) pick(Number(btn.dataset.i));
  });
  alsoEl.addEventListener("click", e => {
    const btn = e.target.closest(".link-button");
    if (btn) pick(Number(btn.dataset.i));
  });

  // ---------- inputs ----------
  async function searchFor(q) {
    q = q.trim();
    if (!q) return;
    setLoading(`Looking for ${q}…`);
    setStatus("");
    try {
      const places = await geocode(q);
      if (!places.length) {
        setLoading(null);
        setStatus(`Couldn’t find “${q}”. Try a place name or postcode.`, true);
        return;
      }
      $("#place").value = q;
      if (isAmbiguous(places)) {
        setLoading(null);
        showChoices(q, places);
        return;
      }
      await search({ ...places[0], shareQuery: q });
      showAlternatives(places.slice(1, 4));
    } catch (e) {
      console.error(e);
      setLoading(null);
      setStatus("Couldn’t look that place up just now. Please try again.", true);
    }
  }

  $("#place-form").addEventListener("submit", e => {
    e.preventDefault();
    $("#place").blur();
    searchFor($("#place").value);
  });

  // Apps' built-in browsers (Instagram, Facebook, TikTok…) mostly block location, and some
  // never answer the request at all, so name the problem and the way round it.
  const inAppBrowser = (() => {
    const ua = navigator.userAgent;
    const apps = { Instagram: /Instagram/, Facebook: /FBAN|FBAV|FB_IAB/, TikTok: /TikTok|musical_ly|BytedanceWebview/,
      Snapchat: /Snapchat/, LinkedIn: /LinkedInApp/, Pinterest: /Pinterest/, Threads: /Barcelona/, X: /Twitter/ };
    return Object.keys(apps).find(name => apps[name].test(ua)) || null;
  })();
  const locationFailed = err => {
    setLoading(null);
    let msg = "Couldn’t get your location. You can type a place instead.";
    if (inAppBrowser) msg = `${inAppBrowser}’s built-in browser won’t share your location. Open this page in Safari or Chrome (try the ••• menu), or type a place instead.`;
    else if (err && err.code === 1) msg = "Location access is turned off for this site. Allow it in your browser’s settings, or type a place instead.";
    setStatus(msg, true);
  };

  $("#near-me").addEventListener("click", () => {
    setStatus("");
    if (!navigator.geolocation) { locationFailed(); return; }
    setLoading("Finding where you are…");
    // Some in-app browsers ignore the timeout below and never call back, so keep our own.
    let settled = false;
    const watchdog = setTimeout(() => { if (!settled) { settled = true; locationFailed(); } }, 15000);
    const settle = () => { if (settled) return false; settled = true; clearTimeout(watchdog); return true; };
    navigator.geolocation.getCurrentPosition(async pos => {
      if (!settle()) return;
      const { latitude: lat, longitude: lon } = pos.coords;
      $("#place").value = "";
      // The URL never carries your coordinates, so a shared link can't give you away.
      await search({ lat, lon, label: "you", shareQuery: "" });
      const run = state.run;
      const name = await placeName(lat, lon);
      if (name && run === state.run) $("#results-title").title = `Near ${name}`;
    }, err => {
      if (settle()) locationFailed(err);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });

  // Offer a search once the map is zoomed in to roughly city scale, either before any
  // search or once the map has been moved off the last one: about a 15-minute walk, so
  // a wide or empty search doesn't need a long drag first.
  const SEARCH_HERE_ZOOM = 11;
  const searchHere = $("#search-here");
  map.on("moveend", () => {
    if (!loader.hidden) return;
    const moved = !state.centre || map.getCenter().distanceTo(state.centre) >= Math.min(state.radius, WALK_RADIUS[walk]) / 2;
    searchHere.hidden = map.getZoom() < SEARCH_HERE_ZOOM || !moved || !tourEl.hidden;
  });
  searchHere.addEventListener("click", async () => {
    const c = map.getCenter();
    $("#place").value = "";
    searchHere.hidden = true;
    setLoading("Mapping the articles…");   // naming the spot can take a moment
    const name = await placeName(c.lat, c.lng);
    search({ lat: c.lat, lon: c.lng, label: name || "here", shareQuery: "" });
  });

  // ---------- random place ----------
  // Drop in beside a random geotagged article. Most articles have no coordinates, so ask
  // for a batch and keep the first that's on Earth (some sit on the Moon or Mars).
  async function randomPlace() {
    for (let tries = 0; tries < 5; tries++) {
      const d = await wiki({
        action: "query", generator: "random", grnnamespace: "0", grnlimit: "50",
        prop: "coordinates", coprimary: "primary", colimit: "max",
      });
      const hit = (d.query?.pages || []).find(p => p.coordinates?.[0]?.globe === "earth");
      if (hit) return { lat: hit.coordinates[0].lat, lon: hit.coordinates[0].lon, label: hit.title };
    }
    return null;
  }

  $("#random-place").addEventListener("click", async () => {
    setStatus("");
    setLoading("Picking somewhere at random…");
    try {
      const place = await randomPlace();
      if (!place) throw new Error("no geotagged article found");
      $("#place").value = "";
      search({ ...place, shareQuery: "" });
    } catch (e) {
      console.error(e);
      setLoading(null);
      setStatus("Couldn’t pick a random place just now. Please try again.", true);
    }
  });

  // ---------- language ----------
  const langEl = $("#lang");
  langEl.innerHTML = LANGUAGES.map(([code, name]) => `<option value="${code}" lang="${code}">${esc(name)}</option>`).join("");
  const applyLang = () => {
    langEl.value = lang;
    $("#wiki-credit").href = `${wikiHost()}/`;
    $("#wiki-credit").textContent = lang === "en" ? "Wikipedia" : `${LANG_NAME[lang]} Wikipedia`;
  };
  applyLang();
  langEl.addEventListener("change", () => {
    lang = langEl.value;
    try { localStorage.setItem("walkipedia-lang", lang); } catch (_) {}
    const url = new URL(location.href);
    if (lang === "en") url.searchParams.delete("lang"); else url.searchParams.set("lang", lang);
    history.replaceState(null, "", url);
    extracts.clear();         // page ids belong to one wiki, so nothing carries over
    applyLang();
    if (state.last) search(state.last);
  });

  // ---------- walk length ----------
  // One dropdown in the intro heading and another in the results heading, kept in step.
  const walkSelect = () => `<select class="lang-select walk-select" aria-label="How long a walk">${
    WALKS.map(([key, name]) => `<option value="${key}"${key === walk ? " selected" : ""}>${name}</option>`).join("")}</select>`;
  $("#walk-intro").outerHTML = walkSelect();
  document.addEventListener("change", e => {
    if (!e.target.classList.contains("walk-select")) return;
    walk = e.target.value;
    document.querySelectorAll(".walk-select").forEach(s => (s.value = walk));
    const url = new URL(location.href);
    if (walk === "short") url.searchParams.delete("walk"); else url.searchParams.set("walk", walk);
    history.replaceState(null, "", url);
    renderTries();
    if (state.last) search(state.last);
  });

  // ---------- your walk ----------
  const STAR = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17l-5.6 3 1.1-6.2-4.6-4.4 6.3-.9z"/></svg>';
  const saveText = on => on ? "In your walk" : "Add to your walk";
  // A Google Maps directions link takes a start, nine stops in between and an end. (A phone's
  // browser takes only three in between; the app takes the lot.)
  const STOPS_PER_LINK = 11;
  const walkBtn = $("#walk-btn");
  const tourEl = $("#tour");
  const tourLayer = L.layerGroup().addTo(map);
  let tourStops = [];
  let tourFrom = null;    // the view and panels to go back to

  const storeSaved = () => { try { localStorage.setItem("walkipedia-saved", JSON.stringify(saved)); } catch (_) {} };
  const updateWalkBtn = () => {
    walkBtn.hidden = !saved.length || !tourEl.hidden;
    $("#walk-n").textContent = saved.length;
  };
  updateWalkBtn();

  function toggleSaved(a) {
    const i = saved.findIndex(s => s.lang === lang && s.id === a.id);
    if (i >= 0) saved.splice(i, 1);
    else saved.push({ lang, id: a.id, title: a.title, lat: a.lat, lon: a.lon });
    storeSaved();
    updateWalkBtn();
    markers.get(a.id)?.setIcon(markerIcon(a));
    if (state.activeId) setActive(state.activeId);
    document.querySelectorAll(`[data-save="${a.id}"]`).forEach(b => {
      b.setAttribute("aria-pressed", String(isSaved(a)));
      const t = b.querySelector(".save-text");
      if (t) t.textContent = saveText(isSaved(a));
    });
  }

  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-save]");
    const a = btn && state.articles.find(x => x.id === btn.dataset.save);
    if (a) toggleSaved(a);
  });

  // Go to the nearest stop next, trying each stop as the first and keeping the shortest walk.
  function walkOrder(stops) {
    let best = stops, bestLength = 0;
    stops.forEach((first, n) => {
      const order = [first], left = stops.filter(s => s !== first);
      let length = 0;
      while (left.length) {
        const here = L.latLng(order[order.length - 1]);
        let i = 0;
        left.forEach((s, j) => { if (here.distanceTo(s) < here.distanceTo(left[i])) i = j; });
        length += here.distanceTo(left[i]);
        order.push(...left.splice(i, 1));
      }
      if (!n || length < bestLength) { best = order; bestLength = length; }
    });
    return { order: best, length: bestLength };
  }

  // One link per leg of up to STOPS_PER_LINK stops, each leg starting where the last one ended.
  // A single stop gets directions from wherever you are.
  function mapsLinks(stops) {
    const at = s => `${s.lat},${s.lon}`;
    const link = params => `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", travelmode: "walking", ...params })}`;
    if (stops.length === 1) return [{ first: 1, last: 1, url: link({ destination: at(stops[0]) }) }];
    const legs = [];
    for (let i = 0; i < stops.length - 1; i += STOPS_PER_LINK - 1) {
      const leg = stops.slice(i, i + STOPS_PER_LINK);
      legs.push({
        first: i + 1, last: i + leg.length,
        url: link({ origin: at(leg[0]), destination: at(leg[leg.length - 1]), ...(leg.length > 2 && { waypoints: leg.slice(1, -1).map(at).join("|") }) }),
      });
    }
    return legs;
  }

  function downloadGpx(stops) {
    const pt = (tag, s) => `<${tag} lat="${s.lat}" lon="${s.lon}"><name>${esc(s.title)}</name><link href="${esc(wikiUrl(s.title, s.lang))}"/></${tag}>`;
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Walkipedia" xmlns="http://www.topografix.com/GPX/1/1">
${stops.map(s => `  ${pt("wpt", s)}`).join("\n")}
  <rte>
    <name>Walkipedia walk</name>
${stops.map(s => `    ${pt("rtept", s)}`).join("\n")}
  </rte>
</gpx>
`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
    a.download = "walkipedia-walk.gpx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function renderTour(fit) {
    const { order, length } = walkOrder(saved);
    tourStops = order;
    tourLayer.clearLayers();
    if (order.length) {
      L.polyline(order.map(s => [s.lat, s.lon]), { color: "#36c", weight: 3, dashArray: "6 8", interactive: false }).addTo(tourLayer);
      order.forEach((s, i) => L.marker([s.lat, s.lon], {
        icon: L.divIcon({ html: `<div class="choice-pin">${i + 1}</div>`, className: "", iconSize: [28, 28] }),
        title: s.title,
      }).addTo(tourLayer));
      if (fit) map.fitBounds(L.latLngBounds(order.map(s => [s.lat, s.lon])), { padding: [50, 50], maxZoom: 17 });
    }
    const links = mapsLinks(order);
    tourEl.innerHTML = `
      <h2>Your walk</h2>
      ${order.length ? `
        <p class="result-count">${order.length} stop${order.length === 1 ? "" : "s"}${order.length > 1 ? ` · about ${walkText(length).split(" · ").pop()} as the crow flies` : ""}</p>
        <ol class="tour-list">${order.map((s, i) => `
          <li>
            <span class="choice-n" aria-hidden="true">${i + 1}</span>
            <a href="${wikiUrl(s.title, s.lang)}" target="_blank" rel="noopener">${esc(s.title)}</a>
            <button type="button" class="tour-remove" data-unsave="${i}" aria-label="Remove ${esc(s.title)}">×</button>
          </li>`).join("")}
        </ol>
        <div class="tour-actions">
          ${links.map(l => `<a class="btn btn-primary" href="${esc(l.url)}" target="_blank" rel="noopener">${
            links.length > 1 ? `Stops ${l.first}–${l.last} in Google Maps` : "Open in Google Maps"}</a>`).join("")}
          <button type="button" class="btn" data-gpx>Download GPX</button>
        </div>
        <p class="small">Google Maps takes up to ${STOPS_PER_LINK} stops per link (or 5 in a phone’s browser without the Google Maps app), so longer walks come in parts.
          The GPX file has the whole walk, for apps like Komoot, OsmAnd or Organic Maps.</p>`
      : `<p class="empty">Nothing in your walk yet. Tap the star on any article to add it.</p>`}
      <p class="tour-foot"><button type="button" class="link-button" data-back>← Back</button></p>`;
  }

  function openTour() {
    tourFrom = { centre: map.getCenter(), zoom: map.getZoom(), panels: ["#intro", "#results", "#choices"].map($).filter(el => !el.hidden) };
    tourFrom.panels.forEach(el => (el.hidden = true));
    map.closePopup();
    [cluster, overlay, choiceLayer].forEach(l => map.removeLayer(l));
    tourEl.hidden = false;
    searchHere.hidden = true;
    updateWalkBtn();
    renderTour(true);
    if (window.matchMedia("(max-width: 900px)").matches) $(".map-panel").scrollIntoView({ behavior: "smooth" });
  }

  function closeTour() {
    if (tourEl.hidden) return;
    tourEl.hidden = true;
    tourLayer.clearLayers();
    [cluster, overlay, choiceLayer].forEach(l => l.addTo(map));
    tourFrom.panels.forEach(el => (el.hidden = false));
    map.setView(tourFrom.centre, tourFrom.zoom);
    updateWalkBtn();
  }

  walkBtn.addEventListener("click", openTour);
  tourEl.addEventListener("click", e => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if ("back" in btn.dataset) closeTour();
    else if ("gpx" in btn.dataset) downloadGpx(tourStops);
    else if ("unsave" in btn.dataset) {
      const s = tourStops[Number(btn.dataset.unsave)];
      saved = saved.filter(x => x !== s);
      storeSaved();
      const a = s.lang === lang && state.articles.find(x => x.id === s.id);
      if (a) markers.get(a.id).setIcon(markerIcon(a));
      refresh();
      renderTour(false);
    }
  });

  // ---------- image fallback ----------
  document.addEventListener("error", e => {
    const img = e.target;
    if (img instanceof HTMLImageElement && (img.classList.contains("thumb") || img.closest(".popup"))) img.remove();
  }, true);

  // ---------- suggestions ----------
  // Two places in the UK, one further afield and a postcode, picked afresh each visit. All match
  // clearly enough not to ask which one you meant. They search in place, keeping the walk length.
  const SUGGESTIONS = [
    ["Glasgow", "Bath", "Oxford", "Belfast", "Cardiff", "St Andrews", "Brighton", "Tower of London", "Lindisfarne"],
    ["Kyoto", "Lisbon", "Venice", "Reykjavik", "Valletta", "Barcelona", "Prague", "Hobart", "Quebec City"],
    ["EH1 1YZ", "SW1A 1AA"],
  ];
  const pickFrom = (list, n) => [...list].sort(() => Math.random() - .5).slice(0, n);
  const tries = [...pickFrom(SUGGESTIONS[0], 2), ...pickFrom(SUGGESTIONS[1], 1), ...pickFrom(SUGGESTIONS[2], 1)];
  function renderTries() {
    const links = tries.map(q => {
      const url = new URL(location.href);
      url.searchParams.set("q", q);
      return `<a href="${esc(url.search)}" data-q="${esc(q)}">${esc(q)}</a>`;
    });
    $(".try").innerHTML = `Try ${links.slice(0, -1).join(", ")} or ${links[links.length - 1]}.`;
  }
  renderTries();
  $(".try").addEventListener("click", e => {
    const a = e.target.closest("a");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    searchFor(a.dataset.q);
  });

  // ---------- start ----------
  const initial = new URL(location.href).searchParams.get("q");
  if (initial) searchFor(initial);
  else $("#place").focus({ preventScroll: true });
})();
