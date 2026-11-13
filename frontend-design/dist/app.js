"use strict";

const $ = id => document.getElementById(id);
const ui = { map: $("map"), fallback: $("map-fallback"), status: $("map-status"), list: $("place-list"), count: $("place-count"), search: $("search"), selected: $("selected-place"), toast: $("toast") };
const state = { places: [], boundary: null, map: null, markers: new Map(), filter: "all", query: "", selected: null, savedOnly: false, saved: new Set(), view: "map" };
// Geolocation lives only in page memory (never persisted): origin device|manual|null,
// lat/lng/accuracyM/capturedAt, radiusM, phase (idle|requesting|ready|denied|unavailable|timeout),
// reqId guards against stale async callbacks, youMarker is the "Вы здесь" map marker.
const geo = { origin: null, lat: null, lng: null, accuracyM: null, capturedAt: null, radiusM: 1000, phase: "idle", reqId: 0, youMarker: null };
const storageKey = "svoi-vladik-design-v1";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const META = {
  "osm-node-676375880": { short: "Музей Тихоокеанского флота", label: "Музей ТОФ", image: "museum.svg", kind: "Культура · Музей", description: "Место для знакомства с морской стороной города. Сохраните его для своей прогулки и уточните условия посещения перед выходом." },
  "osm-way-26537156": { short: "Театр имени Горького", label: "Театр Горького", image: "theatre.svg", kind: "Культура · Театр", description: "Повод выбраться на спектакль или включить знакомство с театром в прогулку по району. Афишу и условия посещения уточняйте отдельно." },
  "osm-way-133436813": { short: "Владивостокский фуникулёр", label: "Фуникулёр", image: "funicular.svg", kind: "Город · Фуникулёр", description: "Ещё одна точка для знакомства с Ленинским районом. Перед поездкой проверьте, работает ли фуникулёр и где находится вход." }
};
const paths = {
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6z"/>',
  coffee: '<path d="M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM16 8h2a3 3 0 0 1 0 6h-2M7 3v2m5-2v2"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="m8 21 3-7m3 7-1-6-3-4 3-4 3 4 4 1M5 12l4-2 3-3"/>',
  book: '<path d="M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2zM12 6v15"/>'
};
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
function icon(name) {
  // These paths are fixed application artwork, never data or user input.
  const node = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + '</svg>', 'image/svg+xml').documentElement;
  node.setAttribute("aria-hidden", "true");
  return document.importNode(node, true);
}
function button(text, cls, action, iconName) {
  const b = el("button", cls, text); b.type = "button";
  if (iconName) b.append(icon(iconName));
  if (action) b.addEventListener("click", action);
  return b;
}
function image(file, cls) { const img = el("img", cls); img.src = "assets/" + file; img.alt = ""; return img; }
function notify(text) {
  ui.toast.textContent = text; ui.toast.hidden = false; ui.toast.classList.add("is-visible");
  clearTimeout(notify.timer); notify.timer = setTimeout(() => {ui.toast.classList.remove("is-visible");ui.toast.hidden=true;}, 3000);
}
function readStorage() {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || "{}");
    state.saved = new Set(Array.isArray(data.saved) ? data.saved.filter(id => state.places.some(p => p.id === id)) : []);
    return ["lighthouse", "boat", "sun"].includes(data.avatar) ? data.avatar : "lighthouse";
  } catch { return "lighthouse"; }
}
function writeStorage(avatar) {
  try {
    const old = JSON.parse(localStorage.getItem(storageKey) || "{}");
    localStorage.setItem(storageKey, JSON.stringify({ saved: [...state.saved], avatar: avatar || old.avatar || "lighthouse" }));
  } catch { notify("Браузер не разрешил сохранить выбор"); }
}
function setSaved(place) {
  const added = !state.saved.has(place.id);
  added ? state.saved.add(place.id) : state.saved.delete(place.id);
  writeStorage(); renderPlaces();
  if (state.selected?.id === place.id) renderSelected(place);
  notify(added ? "Место сохранено на этом устройстве" : "Место удалено из сохранённого");
}
function sourceURL(place) { return `https://www.openstreetmap.org/${place.osmType}/${place.osmId}`; }
function routeURL(place) { return `https://2gis.ru/directions/tab/pedestrian/points/%7C${place.lng},${place.lat}`; }
function external(text, href, cls) {
  const a = el("a", cls, text); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.append(icon("arrow")); return a;
}
function openDialog(id, content) {
  const dialog = $(id); const body = $(id.replace("-dialog", "-content"));
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  body.replaceChildren(...content); dialog.showModal();
}
function dialogHeading(eyebrow, title, copy) {
  const box = el("div", "detail-heading");
  box.append(el("p", "eyebrow", eyebrow), el("h2", "", title));
  if (copy) box.append(el("p", "dialog-copy", copy));
  return box;
}
function placeCard(place) {
  const row = el("li", "place-card" + (state.selected?.id === place.id ? " is-selected" : ""));
  const main = button("", "place-open", () => selectPlace(place));
  main.setAttribute("aria-label", "Показать на карте: " + place.title);
  main.append(image(place.image, "place-thumb"));
  const body = el("span", "place-body");
  body.append(el("span", "place-kind", place.kind), el("span", "place-title", place.title), el("span", "place-tag", "Ленинский район"));
  if (Number.isFinite(place.distanceM)) body.append(el("span", "place-distance", "≈" + formatDistance(place.distanceM) + " по прямой"));
  main.append(body);
  const save = button("", "save-place" + (state.saved.has(place.id) ? " is-saved" : ""), () => setSaved(place), "bookmark");
  save.setAttribute("aria-label", state.saved.has(place.id) ? "Убрать из сохранённого" : "Сохранить место");
  save.setAttribute("aria-pressed", String(state.saved.has(place.id)));
  row.append(main, save); return row;
}
function renderPlaces() {
  const q = state.query.toLocaleLowerCase("ru");
  const located = geo.origin && Number.isFinite(geo.lat) && Number.isFinite(geo.lng);
  let found = state.places.filter(p => (!state.savedOnly || state.saved.has(p.id)) && (state.filter === "all" || p.category === state.filter) && (p.title + " " + p.originalName).toLocaleLowerCase("ru").includes(q));
  if (located) {
    // Compute distance from the current position, filter by radius (on the raw
    // value), then sort ascending with a stable tie-break by id.
    for (const p of state.places) p.distanceM = haversineM(geo.lat, geo.lng, p.lat, p.lng);
    found = found.filter(p => p.distanceM <= geo.radiusM).sort((a, b) => a.distanceM - b.distanceM || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else {
    for (const p of state.places) p.distanceM = undefined;
  }
  ui.list.replaceChildren(...found.map(placeCard)); ui.count.textContent = String(found.length).padStart(2, "0");
  if (!found.length) {
    const empty = el("li", "empty-state");
    if (located) {
      empty.append(el("h3", "", "В выбранном радиусе нет мест из нашего каталога Ленинского района"), el("p", "", "Увеличьте радиус, измените фильтр или выберите старт вручную."));
    } else {
      empty.append(el("h3", "", state.savedOnly ? "Сохраним что-нибудь?" : "Пока ничего не нашлось"), el("p", "", state.savedOnly ? "Нажмите на закладку у места, к которому хочется вернуться." : "Попробуйте другое название или сбросьте фильтры."));
    }
    empty.append(button("Показать все места", "secondary-button", resetFilters)); ui.list.append(empty);
  }
  for (const [id, marker] of state.markers) marker.getElement().hidden = !found.some(p => p.id === id);
  for (const point of ui.fallback.querySelectorAll("[data-place-id]")) point.toggleAttribute('hidden', !found.some(p => p.id === point.dataset.placeId));
  $("bookmarks-open")?.setAttribute("aria-pressed", String(state.savedOnly));
}
function resetFilters() {
  revealPlaces();
  state.filter = "all"; state.query = ""; state.savedOnly = false; ui.search.value = "";
  document.querySelectorAll("[data-category]").forEach(b => {b.setAttribute("aria-pressed", String(b.dataset.category === "all"));b.classList.toggle("is-active",b.dataset.category==='all');});
  renderPlaces();
}
function revealPlaces() {
  document.querySelector('.sidebar')?.classList.remove('is-collapsed');
  $('mobile-sheet-toggle')?.setAttribute('aria-expanded','true');
}
function renderSelected(place) {
  ui.selected.replaceChildren(); ui.selected.hidden = false;
  const info = el("div", "selected-copy");
  info.append(el("span", "place-kind", place.kind), el("h2", "", place.title), el("p", "", "Узнайте больше перед прогулкой"));
  const details = button("О месте", "primary-button", () => showPlace(place), "arrow");
  const close = button("", "selected-close", () => { ui.selected.hidden = true; state.selected = null; updateSelectedMarkers(); renderPlaces(); }, "close"); close.setAttribute("aria-label", "Закрыть карточку");
  ui.selected.append(image(place.image, "selected-thumb"), info, details, close);
}
function updateSelectedMarkers() {
  for (const [id, marker] of state.markers) marker.getElement().classList.toggle("is-selected", state.selected?.id === id);
}
function selectPlace(place) {
  state.selected = place; renderPlaces(); renderSelected(place); updateSelectedMarkers();
  if (state.map) state.map.flyTo({ center: [place.lng, place.lat], zoom: Math.max(state.map.getZoom(), 15.7), duration: reducedMotion ? 0 : 650, padding: { bottom: innerWidth < 780 ? 220 : 100, top: 60, left: 40, right: 40 } });
  if (innerWidth < 780) {document.querySelector(".sidebar")?.classList.add("is-collapsed");$('mobile-sheet-toggle')?.setAttribute('aria-expanded','false');}
}
function showPlace(place) {
  const art = image(place.image, "detail-art");
  const head = dialogHeading(place.kind, place.title, place.description);
  const note = el("p", "info-note", "Условия посещения ещё уточняем. Перед выходом проверьте режим работы и доступность входа. Геометка может не совпадать со входом.");
  const actions = el("div", "dialog-actions");
  actions.append(external("Пешком в 2ГИС", routeURL(place), "primary-button"), button(state.saved.has(place.id) ? "Сохранено" : "Сохранить", "secondary-button", () => { setSaved(place); showPlace(place); }, "bookmark"));
  const source = external("Посмотреть источник", sourceURL(place), "source-link");
  openDialog("detail-dialog", [art, head, note, actions, source]);
}
function showWalk() {
  const intro = dialogHeading("ПРОГУЛКИ ПО ЛЕНИНСКОМУ", "Три повода выйти из дома", "Театр, морская история и фуникулёр — идея для знакомства с районом. Выберите, с какого места начать.");
  const order = ["osm-way-26537156", "osm-node-676375880", "osm-way-133436813"];
  const steps = el("div", "walk-stops");
  order.map(id => state.places.find(p => p.id === id)).filter(Boolean).forEach((p, i) => {
    const b = button("", "walk-stop", () => { $("detail-dialog").close(); selectPlace(p); });
    b.append(el("span", "step-number", String(i + 1)), image(p.image, "walk-thumb"), el("span", "", p.title), icon("chevron")); steps.append(b);
  });
  const note = el("p", "info-note", "Это идея прогулки. Проход между точками ещё нужно проверить; пеший путь к выбранному месту откроется отдельно в навигаторе.");
  openDialog("detail-dialog", [intro, steps, note]);
}
function showQuest() {
  const art = image("guide.svg", "guide-art");
  const head = dialogHeading("ГОРОД РАССКАЗЫВАЕТ ИСТОРИИ", "У каждой улицы есть сюжет", "Собираем первый исторический квест по Ленинскому району. Здесь появятся задания, персонаж-проводник и маленькая награда за любопытство.");
  openDialog("detail-dialog", [art, head, button("Пока исследовать места", "primary-button", () => { $("detail-dialog").close(); resetFilters(); }, "compass")]);
}
function showFirstTime() {
  const intro = dialogHeading("РАДЫ ЗНАКОМСТВУ", "Освойся в Ленинском", "Начнём с нескольких мест. Не нужно знать город — достаточно выбрать, что интересно.");
  const steps = el("div", "welcome-steps");
  ["Выберите место по настроению", "Откройте карточку и проверьте условия", "Отправляйтесь гулять с навигатором"].forEach((text, i) => { const row = el("div", "step-row"); row.append(el("span", "step-number", String(i + 1)), el("p", "", text)); steps.append(row); });
  const actions = el("div", "intent-grid");
  [["За культурой", "culture", "book"], ["Просто погулять", "all", "walk"]].forEach(([title, cat, name]) => actions.append(button(title, "intent-button", () => { $("firsttime-dialog").close(); chooseCategory(cat); }, name)));
  openDialog("firsttime-dialog", [image("guide.svg", "guide-art"), intro, steps, actions]);
}
function chooseCategory(category) {
  revealPlaces();
  state.filter = category; state.savedOnly = false;
  document.querySelectorAll("[data-category]").forEach(b => {b.setAttribute("aria-pressed", String(b.dataset.category === category));b.classList.toggle("is-active",b.dataset.category===category);}); renderPlaces();
}
function showGuide() {
  const head = dialogHeading("МАЯК НА СВЯЗИ", "Чем займёмся?", "Подскажу, с чего начать знакомство с районом.");
  const choices = el("div", "intent-grid");
  choices.append(button("Найти место", "intent-button", () => { $("guide-dialog").close(); resetFilters(); ui.search.focus(); }, "pin"), button("Выбрать прогулку", "intent-button", showWalk, "walk"), button("Я здесь впервые", "intent-button", showFirstTime, "compass"));
  openDialog("guide-dialog", [image("guide.svg", "guide-art"), head, choices]);
}
function showAvatar() {
  const head = dialogHeading("ТВОЙ МАЛЕНЬКИЙ ПРОФИЛЬ", "Какой ты сегодня?", "Выбор останется только в этом браузере. Начнём без регистрации.");
  const choices = el("div", "avatar-options");
  [["lighthouse", "Маяк", "☀"], ["boat", "Кораблик", "⛵"], ["sun", "Солнце", "☀"]].forEach(([id, label, glyph]) => { const b = button("", "avatar-option", () => { writeStorage(id); $("avatar-open").dataset.avatar = id; notify("Образ выбран"); $("detail-dialog").close(); }); b.append(id === "lighthouse" ? image("lighthouse.svg", "") : el("span", "avatar-glyph", glyph), el("span", "", label)); choices.append(b); });
  openDialog("detail-dialog", [head, choices]);
}
async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("Unable to read local map data"); return response.json();
}
function preparePlaces(geo) {
  if (geo.type !== "FeatureCollection") throw new Error("Invalid geographic data");
  return geo.features.filter(f => META[f.id] && f.geometry?.type === "Point").map(f => {
    const p = f.properties, m = META[f.id], [lng, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("Invalid point coordinates");
    return { id: f.id, title: m.short, originalName: p.name, lng, lat, category: p.category, osmType: p.osm_type, osmId: p.osm_id, ...m };
  });
}
function mapStatus(text) { ui.status.textContent = text; ui.status.hidden = false; }
function showFallback() {
  if (!state.boundary || !ui.fallback.hidden) return;
  ui.fallback.hidden = false; ui.map.hidden = true;
  const oldMap=state.map;state.map=null;state.markers.clear();geo.youMarker=null;
  if(oldMap)oldMap.remove();
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 1000 650"); svg.setAttribute("preserveAspectRatio", "xMidYMid slice"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Схема границы Ленинского района по настоящим координатам");
  const bounds = [131.880,43.090,132.055,43.155];
  const project = ([x,y]) => [(x-bounds[0])/(bounds[2]-bounds[0])*1000,650-(y-bounds[1])/(bounds[3]-bounds[1])*650];
  const polys = state.boundary.features[0].geometry;
  const polygons = polys.type === "Polygon" ? [polys.coordinates] : polys.coordinates;
  for (const polygon of polygons) {
    const path = document.createElementNS(ns,"path");
    path.setAttribute("d",polygon.map(ring=>ring.map((point,i)=>(i?'L':'M')+project(point).join(',')).join(' ')+' Z').join(' '));
    path.setAttribute("fill", "#f7f2e8"); path.setAttribute("fill-rule", "evenodd"); path.setAttribute("stroke", "#ed9c51"); path.setAttribute("stroke-width", "2"); svg.append(path);
  }
  for (const place of state.places) {
    const [x,y] = project([place.lng,place.lat]);
    const dot = document.createElementNS(ns,"circle"); dot.setAttribute("cx",x);dot.setAttribute("cy",y);dot.setAttribute("r","7");dot.setAttribute("fill","#ff8500");dot.setAttribute('data-place-id',place.id); svg.append(dot);
  }
  ui.fallback.replaceChildren(svg); renderPlaces();mapStatus("Схематичный режим · уличная подложка недоступна");
}
function initialiseMap() {
  if (!window.maplibregl) { showFallback(); return; }
  try {
    const map = new maplibregl.Map({ container: "map", style: "map-style.json", center: [131.901,43.119], zoom: 14.6, minZoom: 11.3, maxZoom: 18, maxBounds: [[131.87,43.08],[132.06,43.17]], attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
    state.map = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    let loaded = false;
    const timer = setTimeout(() => { if (!loaded) mapStatus("Карта загружается дольше обычного. Места доступны в списке."); }, 12000);
    map.once("style.load", () => {
      loaded = true; clearTimeout(timer); ui.status.hidden = true;
      map.addSource("leninsky", { type: "geojson", data: state.boundary });
      map.addLayer({ id: "district-fill", type: "fill", source: "leninsky", paint: { "fill-color": "#ff8500", "fill-opacity": 0.025 } });
      map.addLayer({ id: "district-outline", type: "line", source: "leninsky", paint: { "line-color": "#ed9a49", "line-width": 1.7, "line-opacity": 0.65, "line-dasharray": [3,3] } });
      for (const place of state.places) {
        const pin = button("", "map-marker", () => selectPlace(place)); pin.setAttribute("aria-label", place.title);
        const bubble = el("span", "map-marker-bubble"); bubble.append(image(place.image,""));
        pin.append(bubble, el("span", "map-marker-label", place.label));
        const marker = new maplibregl.Marker({ element: pin, anchor: "bottom" }).setLngLat([place.lng,place.lat]).addTo(map);
        pin.setAttribute('aria-label',place.title);
        state.markers.set(place.id, marker);
      }
      renderPlaces(); updateSelectedMarkers();
      if(innerWidth<780)map.jumpTo({center:[131.899,43.1165],zoom:14.7,padding:{top:10,bottom:Math.min(innerHeight*0.46,430),left:10,right:10}});
    });
    map.on("error", () => { if (!loaded) mapStatus("Подложка временно недоступна. Выберите место в списке."); });
    map.on("webglcontextlost", showFallback);
  } catch { showFallback(); }
}
// --- Geolocation: "Что рядом со мной". Position is kept only in memory (geo
// object), never written to storage/URL/network/logs. ---
const RAD = Math.PI / 180;
function haversineM(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RAD, dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDistance(m) { return m < 950 ? Math.round(m / 10) * 10 + " м" : (m / 1000).toFixed(m < 9500 ? 1 : 0) + " км"; }
function formatTime(ts) { return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
function nearbyStatus(text, show = true) { const s = $("nearby-status"); if (!s) return; s.textContent = text || ""; s.hidden = !show || !text; }
function setGeoPhase(phase) {
  geo.phase = phase;
  const btn = $("nearby-request"); if (btn) btn.disabled = phase === "requesting";
  const actions = $("nearby-actions"); if (actions) actions.hidden = geo.origin !== "device";
}
function clearYouMarker() { if (geo.youMarker) { geo.youMarker.remove(); geo.youMarker = null; } }
function placeYouMarker() {
  clearYouMarker();
  if (!state.map || geo.origin !== "device") return;
  const pin = el("div", "you-marker"); pin.setAttribute("aria-hidden", "true");
  pin.append(el("span", "you-dot"), el("span", "you-label", "Вы здесь"));
  geo.youMarker = new maplibregl.Marker({ element: pin, anchor: "center" }).setLngLat([geo.lng, geo.lat]).addTo(state.map);
}
function afterPositionSet() {
  // Shared result for list and map; also warn when accuracy exceeds the radius.
  placeYouMarker(); renderPlaces();
  let text = "Вы здесь · точность около " + Math.round(geo.accuracyM) + " м · определено в " + formatTime(geo.capturedAt);
  if (Number.isFinite(geo.accuracyM) && geo.accuracyM > geo.radiusM) text += ". Точность ниже радиуса — результат приблизительный, обновите позицию или выберите точку вручную.";
  nearbyStatus(text);
  if (state.map) state.map.flyTo({ center: [geo.lng, geo.lat], zoom: Math.max(state.map.getZoom(), 14.6), duration: reducedMotion ? 0 : 600 });
}
function requestNearby(fresh) {
  if (!("geolocation" in navigator)) { setGeoPhase("unavailable"); nearbyStatus("Браузер не поддерживает геолокацию. Выберите место в списке или на карте вручную."); return; }
  const reqId = ++geo.reqId; setGeoPhase("requesting"); nearbyStatus("Определяем местоположение…");
  navigator.geolocation.getCurrentPosition(pos => {
    if (reqId !== geo.reqId) return; // stale callback: a newer request or a clear happened
    const { latitude, longitude, accuracy } = pos.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) { setGeoPhase("unavailable"); nearbyStatus("Не удалось определить координаты. Попробуйте обновить позицию или выбрать точку вручную."); return; }
    geo.origin = "device"; geo.lat = latitude; geo.lng = longitude; geo.accuracyM = accuracy; geo.capturedAt = Date.now();
    setGeoPhase("ready"); afterPositionSet();
  }, err => {
    if (reqId !== geo.reqId) return;
    if (err.code === err.PERMISSION_DENIED) { setGeoPhase("denied"); nearbyStatus("Доступ к геолокации отклонён. Выберите стартовую точку вручную в списке или на карте."); }
    else if (err.code === err.TIMEOUT) { setGeoPhase("timeout"); nearbyStatus("Не успели определить местоположение. Обновите позицию или выберите точку вручную."); }
    else { setGeoPhase("unavailable"); nearbyStatus("Не удалось определить местоположение. Обновите позицию или выберите точку вручную."); }
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: fresh ? 0 : 60000 });
}
function clearNearby() {
  geo.reqId++; // invalidate any in-flight callback
  geo.origin = null; geo.lat = geo.lng = geo.accuracyM = geo.capturedAt = null;
  clearYouMarker(); setGeoPhase("idle"); nearbyStatus("", false); renderPlaces();
}
$("nearby-request")?.addEventListener("click", () => requestNearby(false));
$("nearby-refresh")?.addEventListener("click", () => requestNearby(true));
$("nearby-clear")?.addEventListener("click", clearNearby);
$("nearby-radius")?.addEventListener("change", e => { const v = parseInt(e.target.value, 10); if (v >= 100 && v <= 5000) { geo.radiusM = v; renderPlaces(); if (geo.origin === "device") afterPositionSet(); } });
$("zoom-in").addEventListener("click", () => state.map ? state.map.zoomIn({duration:200}) : notify("Масштабирование доступно при загрузке карты"));
$("zoom-out").addEventListener("click", () => state.map ? state.map.zoomOut({duration:200}) : notify("Масштабирование доступно при загрузке карты"));
$("fit-district").addEventListener("click", () => state.map ? state.map.fitBounds([[131.8843306,43.0974826],[132.0481927,43.1499040]],{padding:55,duration:reducedMotion?0:700}) : notify("На схеме показан весь район"));
ui.search.addEventListener("input", () => { state.query = ui.search.value.trim(); renderPlaces(); });
document.querySelectorAll("[data-category]").forEach(b=>b.addEventListener("click",()=>chooseCategory(b.dataset.category)));
document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>{ if(b.dataset.view==='walks')showWalk();else if(b.dataset.view==='quests')showQuest();else{resetFilters();state.map?.flyTo({center:[131.901,43.119],zoom:14.6,duration:reducedMotion?0:650});} }));
$("first-time").addEventListener("click",showFirstTime);
$("guide-open").addEventListener("click",showGuide);
$("walk-promo")?.addEventListener("click",showWalk);
$("bookmarks-open")?.addEventListener("click",()=>{state.savedOnly=!state.savedOnly;renderPlaces();if(innerWidth<780)revealPlaces();});
$("avatar-open")?.addEventListener("click",showAvatar);
$("mobile-sheet-toggle")?.addEventListener("click",()=>{ const sheet=document.querySelector('.sidebar');sheet.classList.toggle('is-collapsed');$('mobile-sheet-toggle').setAttribute('aria-expanded',String(!sheet.classList.contains('is-collapsed'))); });
document.querySelectorAll("[data-close-dialog]").forEach(b=>b.addEventListener("click",()=>b.closest('dialog').close()));
document.querySelectorAll("dialog").forEach(d=>d.addEventListener("click",e=>{if(e.target===d)d.close();}));
let mobileViewport=innerWidth<780;
window.addEventListener('resize',()=>{const mobile=innerWidth<780;if(state.map&&mobile!==mobileViewport){state.map.resize();state.map.setPadding(mobile?{top:10,bottom:Math.min(innerHeight*0.46,430),left:10,right:10}:{top:0,bottom:0,left:0,right:0});}mobileViewport=mobile;});
Promise.all([getJSON('data/leninsky-boundary.geojson'),getJSON('data/leninsky-poi-candidates.geojson')]).then(([boundary,pois])=>{
  state.boundary=boundary;state.places=preparePlaces(pois);const avatar=readStorage();if($('avatar-open'))$('avatar-open').dataset.avatar=avatar;
  renderPlaces();initialiseMap();
}).catch(error=>{console.error('Unable to initialise district data', error);ui.list.replaceChildren(el('li','empty-state','Не удалось загрузить места. Обновите страницу чуть позже.'));ui.count.textContent='—';mapStatus('Не удалось загрузить данные района');});
