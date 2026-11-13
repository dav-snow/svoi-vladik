"use strict";

const labels = { study: "Учёба", culture: "Культура", history: "История", park: "Парки и скверы", food: "Еда", viewpoint: "Смотровые площадки", other: "Другое" };
const bounds = [[43.0974826, 131.8843306], [43.1499040, 132.0481927]];
const search = document.querySelector("#search");
const category = document.querySelector("#category");
const places = document.querySelector("#places");
const count = document.querySelector("#result-count");
const empty = document.querySelector("#empty-state");
const mapNotice = document.querySelector("#map-notice");
const dataNotice = document.querySelector("#data-notice");
const notices = new Set();
const markers = new Map();
let items = [], map = null, markerLayer = null, dataFailed = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(text) {
  notices.add(text);
  mapNotice.textContent = [...notices].join(" ");
  mapNotice.hidden = false;
}
function link(text, href) {
  const node = element("a", text);
  node.href = href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}
function osmSource(value) {
  try {
    const url = new URL(value);
    const hosts = ["openstreetmap.org", "www.openstreetmap.org", "osm.org", "www.osm.org"];
    if (url.protocol === "https:" && hosts.includes(url.hostname) && /^\/(node|way|relation)\/\d+\/?$/.test(url.pathname)) {
      return "https://www.openstreetmap.org" + url.pathname;
    }
  } catch (_) { /* Invalid sources are not rendered as links. */ }
  return null;
}
function links(item) {
  const group = element("div", undefined, "place-links");
  const source = osmSource(item.source);
  if (source) group.append(link("Источник OSM ↗", source));
  group.append(link("Пешком в 2ГИС ↗", "https://2gis.ru/directions/tab/pedestrian/points/%7C" + item.lng + "," + item.lat));
  return group;
}
function popup(item) {
  const box = element("div", undefined, "poi-popup");
  box.append(element("h3", item.name), element("p", labels[item.category]));
  box.append(element("p", "Кандидат OSM: условия и актуальность ещё не проверены"), links(item));
  return box;
}
function selectItem(item, card) {
  places.querySelectorAll(".is-selected").forEach(node => node.classList.remove("is-selected"));
  card.classList.add("is-selected");
  if (!map) return;
  const marker = markers.get(item.id);
  const options = { duration: 0.6, animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches };
  map.flyTo([item.lat, item.lng], Math.max(map.getZoom(), 16), options);
  if (marker) marker.openPopup();
}
function render() {
  const query = search.value.trim().toLocaleLowerCase("ru");
  const filtered = items.filter(item => (category.value === "all" || item.category === category.value) && item.name.toLocaleLowerCase("ru").includes(query));
  places.replaceChildren();
  markers.clear();
  if (markerLayer) markerLayer.clearLayers();
  count.textContent = dataFailed ? "Данные недоступны" : filtered.length + " из " + items.length;
  empty.hidden = filtered.length > 0;
  empty.textContent = dataFailed ? "Не удалось прочитать список точек. Проверьте файлы данных и откройте страницу через локальный HTTP-сервер." : items.length ? "По этим условиям точек нет. Попробуйте другое название или категорию." : "В исходных данных пока нет точек-кандидатов. Карта показывает границу района; проверенный каталог ещё предстоит собрать.";
  for (const item of filtered) {
    const card = element("li", undefined, "place-card");
    const button = element("button", undefined, "place-button");
    button.type = "button";
    button.append(element("span", labels[item.category], "place-category"), element("span", item.name, "place-name"), element("span", "Кандидат OSM · не проверен редактором", "place-status"));
    button.addEventListener("click", () => selectItem(item, card));
    card.append(button, links(item));
    places.append(card);
    if (markerLayer) {
      const marker = L.circleMarker([item.lat, item.lng], { radius: 6, color: "#ffffff", weight: 2, fillColor: "#ff8a00", fillOpacity: 1 }).bindPopup(popup(item)).addTo(markerLayer);
      marker.on("click", () => {
        places.querySelectorAll(".is-selected").forEach(node => node.classList.remove("is-selected"));
        card.classList.add("is-selected");
        card.scrollIntoView({ block: "nearest", behavior: "auto" });
      });
      markers.set(item.id, marker);
    }
  }
}
async function json(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Data request failed");
  return response.json();
}
async function loadBoundary() {
  try {
    const geo = await json("../../data/geo/leninsky-boundary.geojson");
    if (map) {
      const boundary = L.geoJSON(geo, { interactive: false, style: { color: "#ff8a00", weight: 3, fillColor: "#ff8a00", fillOpacity: 0.05 } }).addTo(map);
      if (!boundary.getBounds().isValid()) throw new Error("Empty boundary");
      map.fitBounds(boundary.getBounds(), { padding: [28, 28] });
    }
  } catch (_) {
    notice("Граница района не загрузилась. Точки и список доступны независимо от неё.");
  }
}
async function loadPlaces() {
  try {
    const geo = await json("../../data/geo/leninsky-poi-candidates.geojson");
    if (geo.type !== "FeatureCollection" || !Array.isArray(geo.features)) throw new Error("Invalid point data");
    items = geo.features.flatMap((feature, id) => {
      const point = feature.geometry, props = feature.properties || {};
      if (!point || point.type !== "Point" || !Array.isArray(point.coordinates)) return [];
      const [lng, lat] = point.coordinates;
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return [];
      return [{ id, lng, lat, name: typeof props.name === "string" && props.name.trim() ? props.name : "Точка без названия", category: Object.hasOwn(labels, props.category) ? props.category : "other", source: props.osm_url }];
    });
  } catch (_) {
    dataFailed = true;
    dataNotice.textContent = "Файл точек недоступен или имеет неверный формат. Это ошибка загрузки, а не отсутствие мест в районе.";
    dataNotice.hidden = false;
  }
  render();
}
if (window.L) {
  map = L.map("map", { zoomControl: false }).fitBounds(bounds, { padding: [20, 20] });
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }).on("tileerror", () => notice("Часть карты не загрузилась. Список, источники и внешняя навигация остаются доступны.")).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
} else {
  notice("Библиотека карты не загрузилась. Используйте список точек и ссылки под карточками.");
}
if (window.location.protocol === "file:") notice("Для загрузки GeoJSON откройте страницу через локальный HTTP-сервер из корня репозитория.");
search.addEventListener("input", render);
category.addEventListener("change", render);
Promise.allSettled([loadBoundary(), loadPlaces()]);
