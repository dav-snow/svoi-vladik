"use strict";

const $ = id => document.getElementById(id);
const ui = { map: $("map"), fallback: $("map-fallback"), status: $("map-status"), list: $("place-list"), count: $("place-count"), search: $("search"), selected: $("selected-place"), toast: $("toast") };
const state = { places: [], walks: [], quests: [], boundary: null, map: null, markers: new Map(), filter: "all", query: "", selected: null, savedOnly: false, saved: new Set(), view: "map", activeWalk: null, walkStep: 0, activeQuest: null };
// Geolocation lives only in page memory (never persisted): origin device|manual|null,
// lat/lng/accuracyM/capturedAt, radiusM, phase (idle|requesting|ready|denied|unavailable|timeout),
// reqId guards against stale async callbacks, youMarker is the "Вы здесь" map marker.
const geo = { origin: null, lat: null, lng: null, accuracyM: null, capturedAt: null, radiusM: 1000, radiusFilter: true, phase: "idle", reqId: 0, youMarker: null };
const storageKey = "svoi-vladik-design-v1";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobileLayout = () => matchMedia("(max-width: 760px)").matches;
const progressKey = 'svoi-vladik-progress-v1';
let progress = { quests: {} };
let dialogRevision = 0;
let activeDialogTrigger = null;
// iOS taps and accessibility clicks do not always focus the pressed button.
document.addEventListener?.('click', event => {
  const target = event.target instanceof Element ? event.target.closest('button, a, [role="button"]') : null;
  activeDialogTrigger = target;
  queueMicrotask(() => { if (activeDialogTrigger === target) activeDialogTrigger = null; });
}, true);
try {
  const saved = JSON.parse(localStorage.getItem(progressKey) || '{}');
  if (saved?.quests && typeof saved.quests === 'object' && !Array.isArray(saved.quests)) progress.quests = saved.quests;
  if (saved?.walk && typeof saved.walk.id === 'string') progress.walk = { id: saved.walk.id, done: Array.isArray(saved.walk.done) ? saved.walk.done : [], verifiedByGps: saved.walk.verifiedByGps };
  if (saved?.activeQuest && typeof saved.activeQuest.id === 'string') progress.activeQuest = { id: saved.activeQuest.id, surveyStarted: saved.activeQuest.surveyStarted === true };
} catch {}
function saveProgress() { try { localStorage.setItem(progressKey, JSON.stringify(progress)); } catch { notify('Не удалось сохранить прогресс на этом устройстве'); } }
function guideCard(pose, title, copy, actions = []) { return window.SvoiMascot.show(pose, title, copy, actions); }
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
  } catch { state.saved = new Set(); }
}
function writeStorage() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ saved: [...state.saved] }));
  } catch { notify("Браузер не разрешил сохранить выбор"); }
}
function setSaved(place) {
  const added = !state.saved.has(place.id);
  added ? state.saved.add(place.id) : state.saved.delete(place.id);
  writeStorage(); renderPlaces();
  if (state.selected?.id === place.id) renderSelected(place);
  notify(added ? "Место сохранено на этом устройстве" : "Место удалено из сохранённого");
}
function sourceURL(place) { return place.source_url || `https://www.openstreetmap.org/${place.osmType}/${place.osmId}`; }
// Задача 014: ссылку в 2ГИС собирает сервер (route_url, с литеральным «|»).
// Клиент её не строит и не кодирует; без route_url кнопка не показывается.
function routeURL(place) { return place.route_url || null; }
function routeButton(text, place, cls) { return routeURL(place) ? [external(text, routeURL(place), cls)] : []; }
function external(text, href, cls) {
  let url; try { url = new URL(href); } catch { return el('span', cls, text); }
  if (url.protocol !== 'https:' || url.username || url.password) return el('span', cls, text);
  // href присваиваем исходной строкой: сериализация URL закодировала бы «|»
  // в %7C, а 2ГИС ждёт сырой разделитель «старт|финиш».
  const a = el("a", cls, text); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.append(icon("arrow")); return a;
}
function openDialog(id, content) {
  dialogRevision++;
  const dialog = $(id); const body = $(id.replace("-dialog", "-content"));
  const trigger = activeDialogTrigger || document.activeElement;
  activeDialogTrigger = null;
  if (window.SvoiMotion) return window.SvoiMotion.open(dialog, () => { body.replaceChildren(...content); dialog.scrollTop = 0; }, trigger);
  for (const d of document.querySelectorAll("dialog[open]")) if (d !== dialog) d.close();
  body.replaceChildren(...content); if (!dialog.open) dialog.showModal();
  return Promise.resolve();
}
function closeDialog(id) {
  dialogRevision++;
  const dialog = typeof id === 'string' ? $(id) : id;
  if (window.SvoiMotion) return window.SvoiMotion.close(dialog);
  if (dialog?.open) dialog.close();
  return Promise.resolve();
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
  body.append(el("span", "place-kind", place.kind), el("span", "place-title", place.title));
  if (Number.isFinite(place.distanceM)) body.append(el("span", "place-distance", "≈" + formatDistance(place.distanceM) + " по прямой · ~" + walkMinutes(place.distanceM) + " мин пешком"));
  main.append(body);
  const save = button("", "save-place" + (state.saved.has(place.id) ? " is-saved" : ""), () => setSaved(place), "bookmark");
  save.setAttribute("aria-label", state.saved.has(place.id) ? "Убрать из сохранённого" : "Сохранить место");
  save.setAttribute("aria-pressed", String(state.saved.has(place.id)));
  row.append(main, save); return row;
}
function renderPlaces() {
  const q = state.query.toLocaleLowerCase("ru");
  const located = geo.origin && Number.isFinite(geo.lat) && Number.isFinite(geo.lng);
  let found = state.places.filter(p => (!state.savedOnly || state.saved.has(p.id)) && (state.filter === "all" || p.category === state.filter || state.filter === 'outdoors' && ['park', 'viewpoint', 'other'].includes(p.category)) && (p.title + " " + p.originalName).toLocaleLowerCase("ru").includes(q));
  if (located) {
    // Always compute distances and sort ascending (stable tie-break by id).
    // The radius only filters the list when geo.radiusFilter is on.
    for (const p of state.places) p.distanceM = haversineM(geo.lat, geo.lng, p.lat, p.lng);
    if (geo.radiusFilter) found = found.filter(p => p.distanceM <= geo.radiusM);
    found.sort((a, b) => a.distanceM - b.distanceM || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } else {
    for (const p of state.places) p.distanceM = undefined;
  }
  ui.list.replaceChildren(...found.map(placeCard)); ui.count.textContent = String(found.length).padStart(2, "0");
  if (!found.length) {
    const empty = el("li", "empty-state");
    if (located && geo.radiusFilter) {
      empty.append(el("h3", "", "В выбранном радиусе нет мест из нашего каталога Ленинского района"), el("p", "", "Увеличьте радиус, измените фильтр или выберите старт вручную."));
    } else {
      empty.append(el("h3", "", state.savedOnly ? "Сохраним что-нибудь?" : ['food', 'toilet'].includes(state.filter) ? 'Пока нет проверенных мест этой категории' : "Пока ничего не нашлось"), el("p", "", state.savedOnly ? "Нажмите на закладку у места, к которому хочется вернуться." : "Попробуйте другое название или сбросьте фильтры."));
    }
    empty.append(button("Показать все места", "secondary-button", resetFilters)); ui.list.append(empty);
  }
  for (const [id, marker] of state.markers) marker.getElement().hidden = !found.some(p => p.id === id);
  for (const point of ui.fallback.querySelectorAll("[data-place-id]")) point.toggleAttribute('hidden', !found.some(p => p.id === point.dataset.placeId));
  $("bookmarks-open")?.setAttribute("aria-pressed", String(state.savedOnly));
}
function resetFilters(keepPosition = false) {
  revealPlaces();
  if (keepPosition === true) geo.radiusFilter = false; else clearNearby(false);
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
function selectPlace(place, keepSidebar = false) {
  state.selected = place; renderPlaces(); renderSelected(place); updateSelectedMarkers();
  if (state.map) state.map.flyTo({ center: [place.lng, place.lat], zoom: Math.max(state.map.getZoom(), 15.7), duration: reducedMotion ? 0 : 650, padding: { bottom: isMobileLayout() ? Math.min(innerHeight * .26, 180) : 100, top: 60, left: 40, right: 40 } });
  if (isMobileLayout() && !keepSidebar) {document.querySelector(".sidebar")?.classList.add("is-collapsed");$('mobile-sheet-toggle')?.setAttribute('aria-expanded','false');}
}
function showPlace(place) {
  const art = image(place.image, "detail-art");
  const head = dialogHeading(place.kind, place.title, place.description);
  const note = el("p", "info-note", "Условия посещения ещё уточняем. Перед выходом проверьте режим работы и доступность входа. Геометка может не совпадать со входом.");
  const actions = el("div", "dialog-actions");
  actions.append(...routeButton("Пешком в 2ГИС", place, "primary-button"), button(state.saved.has(place.id) ? "Сохранено" : "Сохранить", "secondary-button", () => { setSaved(place); showPlace(place); }, "bookmark"));
  const source = external("Посмотреть источник", sourceURL(place), "source-link");
  const address = el('p', 'place-address', place.address || 'Точное место входа уточняйте по источнику.');
  const manual = button('Выбрать как старт для поиска рядом', 'secondary-button', () => { setManualOrigin(place); closeDialog('detail-dialog'); revealPlaces(); });
  openDialog("detail-dialog", [art, head, address, socialBlock(place), note, actions, source, manual]);
}
function showWalk() {
  const cards = el('div', 'adventure-list');
  for (const walk of state.walks) {
    const card = el('article', 'adventure-card');
    card.append(el('p', 'eyebrow', `ОСТАНОВОК: ${walk.place_ids.length} · ПЕШКОМ`), el('h3', '', walk.title), el('p', '', walk.description), button('Посмотреть прогулку', 'primary-button', () => showWalkDetail(walk), 'arrow'));
    cards.append(card);
  }
  openDialog('detail-dialog', [guideCard('talking', 'Выбери свою прогулку', 'Выбирай настроение. За истории отвечаю я, за удобную обувь — ты.'), el('p', 'info-note', 'Редакционные прогулки: условия входа и переходы на местности ещё не проверены. Соединение точек на карте показывает порядок, а не пешеходный путь.'), cards]);
}
function showQuest() {
  const cards = el('div', 'adventure-list');
  for (const quest of state.quests) {
    const saved = questProgress(quest);
    const card = el('article', 'adventure-card');
    const descriptions = { 'quest-leninsky-culture-001': 'Начни с трёх историй: морской музей, театр и фуникулёр.', 'quest-three-keys': 'Собери три ключа: люди, архитектура и культура.', 'quest-letter-vladivostok': 'Собери пять фрагментов воображаемой открытки из Владивостока.', 'quest-city-code': 'Открой пять смыслов города: форму, творчество, движение, историю и отдых.' };
    card.append(el('p', 'eyebrow', `ОСТАНОВОК: ${quest.stops.length} · ПРОЙДЕНО: ${saved.visited.length}`), el('h3', '', quest.title), el('p', '', descriptions[quest.id] || quest.description.replace(/draft/g, 'предварительный')), button(saved.completed ? 'Квест завершён' : saved.visited.length ? 'Продолжить квест' : 'Начать квест', 'primary-button', () => openQuest(quest), 'arrow'));
    cards.append(card);
  }
  openDialog('detail-dialog', [guideCard('interesting-places', 'У города есть истории', 'Сначала обойди остановки и прочитай истории, затем пройди один итоговый опрос.'), el('p', 'info-note', 'GPS помогает понять, что вы рядом с точкой. Без геолокации доступна отдельная ручная отметка. Прогресс хранится только в этом браузере.'), cards]);
}
function showFirstTime() {
  const intro = guideCard('first-visit', 'Впервые во Владике?', 'У нас тут море, истории и внезапная тренировка ног. Что тебе интереснее?');
  const steps = el("div", "welcome-steps");
  ["Выберите место по настроению", "Откройте карточку и проверьте условия", "Отправляйтесь гулять с навигатором"].forEach((text, i) => { const row = el("div", "step-row"); row.append(el("span", "step-number", String(i + 1)), el("p", "", text)); steps.append(row); });
  const actions = el("div", "intent-grid");
  [["За культурой", "culture", "book"], ["Просто погулять", "all", "walk"]].forEach(([title, cat, name]) => actions.append(button(title, "intent-button", () => { closeDialog("firsttime-dialog"); chooseCategory(cat); }, name)));
  actions.append(button('Что рядом со мной', 'intent-button', () => { closeDialog('firsttime-dialog'); revealPlaces(); $('nearby-options').open = true; requestNearby(false); }, 'pin'), button('Выбрать старт вручную', 'intent-button', showManualOrigin, 'compass'));
  openDialog("firsttime-dialog", [intro, steps, actions]);
}
function chooseCategory(category) {
  revealPlaces();
  state.filter = category; state.savedOnly = false;
  document.querySelectorAll("[data-category]").forEach(b => {b.setAttribute("aria-pressed", String(b.dataset.category === category));b.classList.toggle("is-active",b.dataset.category===category);}); renderPlaces();
}
function showGuide() {
  const head = guideCard(geo.origin ? 'talking' : 'location-unknown', 'Привет! Я твоя помощница', geo.origin ? 'Можем найти место, выбрать прогулку или продолжить историю.' : 'Пока не знаю, где ты. Разреши геолокацию или выбери старт вручную.');
  const choices = el("div", "intent-grid");
  choices.append(button('Что рядом со мной', 'intent-button', () => { closeDialog('guide-dialog'); revealPlaces(); $('nearby-options').open = true; requestNearby(false); }, 'pin'), button('Старт вручную', 'intent-button', showManualOrigin, 'compass'), button('Прогулки', 'intent-button', showWalk, 'walk'), button('Квесты', 'intent-button', showQuest, 'book'));
  const categories = el('div', 'helper-category-row');
  for (const [label, category] of [['Поесть', 'food'], ['Туалет', 'toilet'], ['Досуг', 'culture']]) categories.append(button(label, 'secondary-button', () => { closeDialog('guide-dialog'); chooseCategory(category); }));
  const session = auth.user
    ? button(`Выйти (${auth.user.login})`, 'text-button', () => { closeDialog('guide-dialog'); logoutUser(); })
    : button('Войти в демо-аккаунт', 'text-button', () => showAuthDialog('login'));
  openDialog("guide-dialog", [head, choices, categories, session]);
}
// Аватары и кастомизация исключены из продукта (b88a6d4): вместо локального
// аватара в шапке живёт демо-вход, профиль открывается через showProfile.
async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("Unable to read local map data"); return response.json();
}
function preparePlaces(collection) {
  if (collection.type !== "FeatureCollection") throw new Error("Invalid geographic data");
  // META is now an optional editorial override: any Point feature renders, even
  // without a META entry. Coordinates and category come from properties.
  return collection.features.filter(f => f.geometry?.type === "Point").map(f => {
    const p = f.properties || {}, m = META[f.id], [lng, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("Invalid point coordinates");
    const title = m?.short || p.name || "Место без названия";
    return {
      id: f.id, title, originalName: p.name || title, lng, lat, category: p.category,
      osmType: p.osm_type, osmId: p.osm_id,
      label: m?.label || title,
      kind: m?.kind || p.category || "Ленинский район",
      description: m?.description || "Точка из каталога Ленинского района. Условия посещения проверьте по источнику.",
      image: m?.image || "guide.svg"
    };
  });
}
function prepareAPIPlaces(items) {
  const kinds = { culture: 'Культура', park: 'Парк и отдых', viewpoint: 'Вид на город', food: 'Еда', toilet: 'Полезное', other: 'Место города' };
  return items.filter(p => p.active !== false && p.district_verified !== false && Number.isFinite(p.coordinates?.lat) && Number.isFinite(p.coordinates?.lng)).map(p => {
    const meta = META[p.id];
    return { ...p, lat: p.coordinates.lat, lng: p.coordinates.lng, title: meta?.short || p.name, originalName: p.name, label: p.short_name || meta?.label || p.name, image: meta?.image || (p.category === 'culture' ? 'museum.svg' : 'lighthouse.svg'), kind: meta?.kind || kinds[p.category] || kinds.other, description: p.description || meta?.description || 'Условия посещения пока уточняются.' };
  });
}
function renderSources(sources = []) {
  const box = el('div', 'source-list');
  for (const source of sources.slice(0, 6)) box.append(external(source.title || 'Источник факта', source.url, 'source-link'));
  return box;
}
function showWalkDetail(walk) {
  const stops = el('div', 'walk-stops');
  walk.place_ids.forEach((id, index) => {
    const place = state.places.find(p => p.id === id); if (!place) return;
    const item = el('div', 'walk-stop');
    item.append(el('span', 'step-number', String(index + 1)), image(place.image, 'walk-thumb'), el('span', '', place.title), icon('chevron')); stops.append(item);
  });
  const actions = el('div', 'dialog-actions');
  actions.append(button('Начать прогулку', 'primary-button', () => startWalk(walk), 'walk'));
  const quest = state.quests.find(q => q.id === walk.quest_id);
  if (quest) actions.append(button('Пройти связанный квест', 'secondary-button', () => openQuest(quest), 'book'));
  openDialog('detail-dialog', [guideCard('directions', walk.title, walk.description), el('p', 'info-note', walk.route_note || 'Переходы ещё не проверены. Путь до остановки строит внешний навигатор.'), stops, actions, renderSources(walk.sources)]);
}
const visitControls = new WeakMap();
const ARRIVAL_RADIUS_M = 150;
const POSITION_MAX_AGE_MS = 120000;
function validIds(value, ids) { return [...new Set(Array.isArray(value) ? value.filter(id => ids.includes(id)) : [])]; }
function verificationMap(value, ids) { return Object.fromEntries(ids.map(id => [id, value?.[id] === true])); }
function walkProgress(walk) {
  if (progress.walk?.id !== walk.id) progress.walk = { id: walk.id, done: [], verifiedByGps: {} };
  const saved = progress.walk;
  saved.done = validIds(saved.done, walk.place_ids);
  saved.verifiedByGps = verificationMap(saved.verifiedByGps, saved.done);
  return saved;
}
function questProgress(quest) {
  let saved = progress.quests[quest.id];
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const visited = validIds(saved.visited, quest.stops.map(stop => stop.id));
  const answers = {};
  // Legacy answers alone do not establish that the new tour phase was done.
  if (visited.length === quest.stops.length) {
    for (const stop of quest.stops) if (stop.options.some(option => option.id === saved.answers?.[stop.id])) answers[stop.id] = saved.answers[stop.id];
  }
  const clean = { visited, answers, completed: saved.completed === true && Object.keys(answers).length === quest.stops.length, verifiedByGps: verificationMap(saved.verifiedByGps, visited) };
  if (visited.length !== quest.stops.length && progress.activeQuest?.id === quest.id) progress.activeQuest.surveyStarted = false;
  for (const key of Object.keys(saved)) if (!Object.hasOwn(clean, key)) delete saved[key];
  Object.assign(saved, clean); progress.quests[quest.id] = saved; return saved;
}
function journeyFor(kind, item) {
  return { kind, item, saved: kind === 'quest' ? questProgress(item) : walkProgress(item), stops: kind === 'quest' ? item.stops.map(stop => ({ ...stop, place: state.places.find(p => p.id === stop.place_id) })) : item.place_ids.map(id => ({ id, place: state.places.find(p => p.id === id) })) };
}
function currentJourney() { return state.activeQuest ? journeyFor('quest', state.activeQuest) : state.activeWalk ? journeyFor('walk', state.activeWalk) : null; }
function visitedIds(journey) { return journey.kind === 'quest' ? journey.saved.visited : journey.saved.done; }
function currentStopIndex(journey) { return journey.stops.findIndex(stop => !visitedIds(journey).includes(stop.id)); }
function sameJourney(journey) {
  return journey.kind === 'quest' ? state.activeQuest?.id === journey.item.id && progress.quests[journey.item.id] === journey.saved : state.activeWalk?.id === journey.item.id && progress.walk === journey.saved;
}
function surveyActive(quest) { return progress.activeQuest?.id === quest.id && progress.activeQuest.surveyStarted; }
function startWalk(walk) {
  state.activeQuest = null; delete progress.activeQuest;
  state.activeWalk = walk;
  const journey = journeyFor('walk', walk); state.walkStep = Math.max(0, currentStopIndex(journey));
  saveProgress(); resetFilters(true); updateWalkLine(); renderJourney();
  closeDialog('detail-dialog');
  const stop = journey.stops[currentStopIndex(journey)]; if (stop?.place) selectPlace(stop.place, true);
}
function stopWalk() {
  state.activeWalk = null; state.walkStep = 0; delete progress.walk;
  saveProgress(); updateWalkLine(); renderJourney(); closeDialog('detail-dialog');
  notify('Прогулка завершена. Отметки очищены.');
}
function updateWalkLine() {
  const journey = currentJourney();
  const source = state.map?.getSource('walk-path');
  const points = journey?.stops.map(stop => stop.place).filter(Boolean) || [];
  source?.setData({ type: 'FeatureCollection', features: points.length < 2 ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map(p => [p.lng, p.lat]) } }] });
  for (const [id, marker] of state.markers) {
    const bubble = marker.getElement().querySelector('.map-marker-bubble');
    const index = points.findIndex(place => place.id === id);
    const node = marker.getElement();
    node.classList.toggle('is-route', index >= 0);
    const passed = index >= 0 && visitedIds(journey).includes(journey.stops[index].id);
    const current = index >= 0 && index === currentStopIndex(journey);
    node.classList.toggle('is-passed', passed);
    node.classList.toggle('is-current-stop', current);
    if (current) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    const place = state.places.find(place => place.id === id);
    if (place) node.setAttribute('aria-label', place.title + (passed ? ' · Остановка отмечена' : current ? ' · Текущая остановка' : ''));
    if (bubble) { if (index >= 0) bubble.dataset.step = index + 1; else delete bubble.dataset.step; }
  }
  for (const point of ui.fallback.querySelectorAll('[data-place-id]')) {
    const index = points.findIndex(place => place.id === point.dataset.placeId);
    point.classList.toggle('is-passed', index >= 0 && visitedIds(journey).includes(journey.stops[index].id));
    point.classList.toggle('is-current-stop', index >= 0 && index === currentStopIndex(journey));
  }
}
function presenceFor(place) {
  if (geo.phase === 'requesting') return { mode: 'requesting', text: 'Определяем, где вы. Координаты остаются на устройстве.' };
  if (['denied', 'unavailable', 'timeout'].includes(geo.phase)) return { mode: 'fallback', text: 'Без проверки рядом. Геолокация недоступна; отметка будет ручной.' };
  if (geo.origin !== 'device' || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng) || !Number.isFinite(geo.capturedAt) || Date.now() - geo.capturedAt > POSITION_MAX_AGE_MS) return { mode: 'idle', text: 'Без проверки рядом. Позиция устройства неизвестна или устарела. Включите GPS или отметьте остановку вручную.' };
  const distanceM = haversineM(geo.lat, geo.lng, place.lat, place.lng);
  const near = distanceM <= ARRIVAL_RADIUS_M + 1e-6; // floating-point roundoff at exactly 150 m
  const warning = geo.accuracyM > ARRIVAL_RADIUS_M ? ' Позиция неточная (погрешность больше 150 м). Можно обновить GPS.' : '';
  return { mode: near ? 'near' : 'far', text: (near ? 'Вы рядом с точкой (≈' + Math.round(distanceM) + ' м)' : 'До точки ≈' + Math.round(distanceM) + ' м') + warning };
}
function arrivalControls(journey, stop) {
  const box = el('div', 'journey-presence'); box.dataset.visitControls = '';
  visitControls.set(box, { journey, stop }); updateArrivalControls(box); return box;
}
function updateArrivalControls(box) {
  const context = visitControls.get(box); if (!context) return;
  const { journey, stop } = context, presence = presenceFor(stop.place);
  if (box.dataset.presenceKey === presence.mode + presence.text) return;
  const hadFocus = box.contains(document.activeElement);
  box.dataset.presenceKey = presence.mode + presence.text;
  const status = el('p', 'journey-location', presence.text); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', 'journey-actions');
  const withoutGps = ['fallback', 'idle'].includes(presence.mode);
  const mark = button(withoutGps ? 'Отметить без проверки' : 'Я на месте', 'primary-button', () => markArrival(journey, stop.id, withoutGps), 'check');
  mark.dataset.focusKey = 'arrival-mark';
  mark.disabled = !['near', 'fallback', 'idle'].includes(presence.mode);
  actions.append(mark);
  if (presence.mode !== 'near' && presence.mode !== 'requesting') actions.append(button(presence.mode === 'idle' ? 'Проверить GPS' : 'Обновить GPS', 'secondary-button', () => requestNearby(true), 'pin'));
  if (presence.mode === 'far') actions.append(...routeButton('Идти в 2ГИС', stop.place, 'secondary-button'));
  if (presence.mode === 'requesting') actions.append(button('Продолжить без GPS', 'text-button', () => { clearNearby(false); setGeoPhase('unavailable'); }));
  box.replaceChildren(status, actions);
  if (hadFocus) (actions.querySelector('button:not(:disabled)') || mark).focus({ preventScroll: true });
}
function refreshPresence() { for (const box of document.querySelectorAll('[data-visit-controls]')) updateArrivalControls(box); }
function markArrival(journey, stopId, withoutGps = false) {
  if (!sameJourney(journey)) return;
  const index = currentStopIndex(journey), stop = journey.stops[index];
  if (!stop || stop.id !== stopId || journey.kind === 'quest' && surveyActive(journey.item)) return;
  const presence = presenceFor(stop.place);
  if (withoutGps ? !['fallback', 'idle'].includes(presence.mode) : presence.mode !== 'near') { refreshPresence(); return; }
  visitedIds(journey).push(stop.id); journey.saved.verifiedByGps[stop.id] = !withoutGps;
  saveProgress(); renderJourney(); updateWalkLine();
  const next = journey.stops[currentStopIndex(journey)];
  if (next) {
    if (next.place) selectPlace(next.place, true);
    if ($('detail-dialog').open) showJourneyStop(journey, currentStopIndex(journey));
    notify('Остановка отмечена' + (withoutGps ? ' без проверки рядом' : '') + '.');
  } else if (journey.kind === 'quest') showTourComplete(journey.item);
  else showWalkComplete(journey.item);
}
function renderJourney() {
  const panel = $('journey-progress'); if (!panel) return;
  const detailsOpen = panel.querySelector('details')?.open;
  const focusedKey = panel.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
  const journey = currentJourney();
  panel.replaceChildren(); panel.hidden = !journey;
  document.querySelector('.map-stage')?.classList.toggle('has-journey', !!journey);
  document.querySelector('.district-badge > span:last-child').textContent = journey ? 'Схема остановок · путь в 2ГИС' : 'Только Ленинский';
  document.querySelector('.intro-section').hidden = !!journey;
  document.querySelector('.sheet-toggle-label').textContent = 'Исследовать район';
  if (!journey) return;
  const done = visitedIds(journey), total = journey.stops.length, index = currentStopIndex(journey);
  const isSurvey = journey.kind === 'quest' && surveyActive(journey.item);
  const box = el('div', 'journey-card'), heading = el('div', 'journey-heading'), title = el('div');
  const label = journey.saved.completed ? 'Квест завершён' : index < 0 ? (isSurvey ? 'Итоговый опрос' : `Обход завершён ${total}/${total}`) : `Остановка ${index + 1} из ${total}`;
  title.append(el('p', 'eyebrow', (journey.kind === 'quest' ? 'КВЕСТ · ' : 'ПРОГУЛКА · ') + label), el('h3', '', journey.item.title)); heading.append(title);
  const meter = el('progress', 'journey-meter'); meter.max = total; meter.value = done.length; meter.setAttribute('aria-label', `Пройдено ${done.length} из ${total} остановок`);
  box.append(heading, meter);
  if (index >= 0) {
    const stop = journey.stops[index];
    box.append(el('p', 'journey-current', stop.place.title), arrivalControls(journey, stop));
  } else {
    const actions = el('div', 'journey-actions');
    if (journey.kind === 'walk') actions.append(button('Завершить', 'primary-button', stopWalk, 'check'));
    else actions.append(button(journey.saved.completed ? 'Посмотреть итог' : isSurvey ? 'Продолжить итоговый опрос' : 'Начать итоговый опрос', 'primary-button', () => journey.saved.completed ? showQuestFinal(journey.item) : beginSurvey(journey.item), 'arrow'));
    actions.querySelector('button').dataset.focusKey = 'journey-next';
    box.append(el('p', 'journey-current', `Пройдено ${done.length} из ${total}`), actions);
  }
  const details = el('details', 'journey-details'); details.open = !!detailsOpen;
  details.append(el('summary', '', `Остановки и отметки · ${done.length}/${total}`));
  const checklist = el('ol', 'journey-checklist');
  journey.stops.forEach((stop, i) => {
    const visited = done.includes(stop.id), item = el('li', visited ? 'is-done' : i === index ? 'is-current' : '');
    const view = button(stop.place.title, 'journey-checkpoint', () => showJourneyStop(journey, i));
    view.disabled = !visited && i !== index; view.setAttribute('aria-pressed', String(i === index)); view.dataset.focusKey = 'stop-' + stop.id;
    item.append(view);
    if (visited) item.append(el('span', 'journey-verification', journey.saved.verifiedByGps[stop.id] ? 'Вы были рядом с точкой по GPS' : 'Без проверки рядом'));
    checklist.append(item);
  });
  const controls = el('div', 'journey-actions');
  if (index >= 0) {
    const view = button('История остановки', 'secondary-button', () => showJourneyStop(journey, index)); view.dataset.focusKey = 'story'; controls.append(view);
    controls.append(...routeButton('Идти в 2ГИС', journey.stops[index].place, 'secondary-button'));
  }
  controls.append(button('Сбросить прогресс', 'text-button', () => journey.kind === 'quest' ? resetQuest(journey.item) : resetWalk(journey.item)));
  if (journey.kind === 'quest') controls.append(button('К другим квестам', 'text-button', leaveQuest));
  details.append(checklist, controls); box.append(details, el('p', 'micro-copy', 'Пунктир — порядок остановок, не рассчитанный путь.')); panel.append(box);
  if (focusedKey) {
    const target = [...panel.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusedKey && !node.disabled);
    (target || panel.querySelector('.journey-actions button:not(:disabled)'))?.focus({ preventScroll: true });
  }
}
function showJourneyStop(journey, index) {
  if (!sameJourney(journey)) return;
  const stop = journey.stops[index], done = visitedIds(journey);
  if (!stop || !done.includes(stop.id) && index !== currentStopIndex(journey)) return;
  const content = [el('p', 'eyebrow', `Остановка ${index + 1} из ${journey.stops.length}`), guideCard('interesting-places', stop.place.title, '')];
  if (journey.kind === 'quest') {
    if (stop.fiction_text) content.push(el('p', 'fiction-copy', 'Проводница · художественная история: ' + stop.fiction_text));
    const fact = el('section', 'fact-card'); fact.append(el('p', 'eyebrow', 'ИСТОРИЧЕСКАЯ СПРАВКА'), el('p', '', stop.fact_text), renderSources(stop.sources)); content.push(fact);
  } else content.push(el('p', 'dialog-copy', stop.place.description), renderSources(journey.item.sources));
  content.push(...routeButton('Идти в 2ГИС', stop.place, 'secondary-button'));
  if (done.includes(stop.id)) content.push(el('p', 'info-note', journey.saved.verifiedByGps[stop.id] ? 'Остановка отмечена: вы были рядом с точкой по GPS.' : 'Остановка отмечена без проверки рядом.'));
  else content.push(arrivalControls(journey, stop));
  content.push(button('Вернуться к карте', 'secondary-button', () => { closeDialog('detail-dialog'); selectPlace(stop.place, true); }));
  openDialog('detail-dialog', content);
}
function resetWalk(walk) { progress.walk = { id: walk.id, done: [], verifiedByGps: {} }; startWalk(walk); notify('Отметки прогулки сброшены'); }
function showWalkComplete(walk) {
  openDialog('detail-dialog', [guideCard('surprised', 'Обход завершён', walk.title), el('p', 'info-note', `Пройдено ${walk.place_ids.length} из ${walk.place_ids.length}`), button('Завершить', 'primary-button', stopWalk)]);
}
function openQuest(quest) {
  const saved = questProgress(quest);
  state.activeWalk = null; state.activeQuest = quest;
  if (progress.activeQuest?.id !== quest.id) progress.activeQuest = { id: quest.id, surveyStarted: Object.keys(saved.answers).length > 0 };
  saveProgress(); resetFilters(true); renderJourney(); updateWalkLine();
  if (saved.completed) { showQuestFinal(quest); return; }
  const journey = journeyFor('quest', quest), next = currentStopIndex(journey);
  if (next >= 0) { selectPlace(journey.stops[next].place, true); showJourneyStop(journey, next); }
  else if (surveyActive(quest)) showSurveyQuestion(quest);
  else showTourComplete(quest);
}
function showTourComplete(quest) {
  const saved = questProgress(quest); if (saved.visited.length !== quest.stops.length) return;
  renderJourney();
  openDialog('detail-dialog', [guideCard('surprised', `Обход завершён ${saved.visited.length}/${quest.stops.length}`, quest.title), el('p', 'info-note', 'Все остановки отмечены. Теперь вспомним их истории в одном итоговом опросе.'), button('Начать итоговый опрос', 'primary-button', () => beginSurvey(quest), 'arrow'), button('Вернуться к карте', 'secondary-button', () => closeDialog('detail-dialog'))]);
}
function beginSurvey(quest) {
  const saved = questProgress(quest); if (saved.visited.length !== quest.stops.length || state.activeQuest?.id !== quest.id) return;
  progress.activeQuest = { id: quest.id, surveyStarted: true }; saveProgress(); renderJourney(); showSurveyQuestion(quest);
}
function showSurveyQuestion(quest) {
  const saved = questProgress(quest);
  if (!surveyActive(quest) || saved.visited.length !== quest.stops.length || state.activeQuest?.id !== quest.id) return;
  const index = quest.stops.findIndex(stop => !saved.answers[stop.id]);
  if (index < 0) { finishQuest(quest); return; }
  const stop = quest.stops[index], meter = el('div', 'quest-meter'); meter.setAttribute('aria-label', `Верных ответов ${Object.keys(saved.answers).length} из ${quest.stops.length}`);
  quest.stops.forEach(item => meter.append(el('span', saved.answers[item.id] ? 'is-done' : item.id === stop.id ? 'is-current' : '')));
  const options = el('div', 'quest-options'), feedback = el('div', 'quest-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
  const next = button(index + 1 === quest.stops.length ? 'Завершить квест' : 'Следующий вопрос', 'primary-button', () => showSurveyQuestion(quest), 'arrow'); next.hidden = true;
  for (const option of stop.options) {
    const choice = button(option.text, 'quest-option', async () => {
      // Check phase again at the request boundary; detached old buttons cannot submit.
      if (state.activeQuest?.id !== quest.id || progress.quests[quest.id] !== saved || !surveyActive(quest) || saved.visited.length !== quest.stops.length || saved.answers[stop.id]) return;
      const revision = dialogRevision;
      const returnFocus = options.contains(document.activeElement);
      const restoreChoiceFocus = () => { if (returnFocus && (document.activeElement === document.body || document.activeElement === $('detail-dialog'))) choice.focus({ preventScroll: true }); };
      options.querySelectorAll('button').forEach(b => { b.disabled = true; }); feedback.hidden = false; feedback.textContent = 'Проверяем ответ…';
      try {
        const result = await postJSON(`/api/v1/quest/${encodeURIComponent(quest.id)}/answer`, { stop_id: stop.id, option_id: option.id });
        if (progress.quests[quest.id] !== saved || state.activeQuest?.id !== quest.id || !surveyActive(quest)) return;
        if (revision !== dialogRevision || !$('detail-dialog').open) return;
        if (result.correct === true) { saved.answers[stop.id] = option.id; saveProgress(); renderJourney(); }
        feedback.className = 'quest-feedback ' + (result.correct === true ? 'is-correct' : 'is-wrong');
        feedback.textContent = (result.correct === true ? 'Верно. ' : 'Не совсем. Попробуйте ещё раз. ') + (result.explanation || '');
        if (result.correct === true) {
          choice.classList.add('is-correct'); choice.setAttribute('aria-pressed', 'true');
          if (Object.keys(saved.answers).length === quest.stops.length) finishQuest(quest);
          else { next.hidden = false; next.focus({ preventScroll: true }); }
        }
        else { options.querySelectorAll('button').forEach(b => { b.disabled = false; }); restoreChoiceFocus(); }
      } catch {
        if (revision !== dialogRevision || progress.quests[quest.id] !== saved) return;
        feedback.textContent = 'Не удалось проверить ответ. Проверьте соединение и попробуйте снова.'; options.querySelectorAll('button').forEach(b => { b.disabled = false; }); restoreChoiceFocus();
      }
    }); choice.setAttribute('aria-pressed', 'false'); options.append(choice);
  }
  const reference = el('details', 'survey-reference'); reference.append(el('summary', '', 'Перечитать справку'), el('p', '', stop.fact_text), renderSources(stop.sources));
  openDialog('detail-dialog', [el('p', 'eyebrow', `ИТОГОВЫЙ ОПРОС · ВОПРОС ${index + 1} ИЗ ${quest.stops.length}`), meter, dialogHeading(quest.title, stop.question), options, feedback, next, reference, button('Сбросить прогресс', 'text-button', () => resetQuest(quest))]);
}
const completing = new WeakMap();
async function finishQuest(quest) {
  const saved = questProgress(quest);
  if (!surveyActive(quest) || saved.visited.length !== quest.stops.length || Object.keys(saved.answers).length !== quest.stops.length || state.activeQuest?.id !== quest.id) return;
  const feedback = el('p', 'info-note', 'Проверяем итоговый опрос…'); feedback.setAttribute('role', 'status');
  const opening = openDialog('detail-dialog', [guideCard('talking', 'История почти собрана', 'Остался последний шаг.'), feedback]);
  const revision = dialogRevision; await opening;
  if (revision !== dialogRevision || !$('detail-dialog').open || progress.quests[quest.id] !== saved) return;
  let request = completing.get(saved);
  if (!request) {
    request = postJSON(`/api/v1/quest/${encodeURIComponent(quest.id)}/complete`, { answers: quest.stops.map(stop => ({ stop_id: stop.id, option_id: saved.answers[stop.id] })) });
    completing.set(saved, request);
  }
  try {
    const result = await request;
    if (progress.quests[quest.id] !== saved || state.activeQuest?.id !== quest.id || revision !== dialogRevision || !$('detail-dialog').open) return;
    if (result.completed !== true) {
      if (revision === dialogRevision) { feedback.textContent = 'Сервер пока не подтвердил завершение. Ответы сохранены.'; feedback.after(button('Повторить', 'primary-button', () => finishQuest(quest)), button('Сбросить прогресс', 'text-button', () => resetQuest(quest))); }
      return;
    }
    // The legacy payload may contain extra fields; only this completion flag is used.
    saved.completed = true; saveProgress(); renderJourney();
    if (revision === dialogRevision) showQuestFinal(quest);
  } catch {
    if (revision === dialogRevision && progress.quests[quest.id] === saved) { feedback.textContent = 'Не удалось завершить проверку. Прогресс сохранён, попробуйте ещё раз.'; feedback.after(button('Повторить', 'primary-button', () => finishQuest(quest))); }
  } finally { if (completing.get(saved) === request) completing.delete(saved); }
}
function resetQuest(quest) {
  progress.quests[quest.id] = { visited: [], answers: {}, completed: false, verifiedByGps: {} };
  progress.activeQuest = { id: quest.id, surveyStarted: false }; openQuest(quest); notify('Прогресс квеста сброшен');
}
function leaveQuest() { state.activeQuest = null; delete progress.activeQuest; saveProgress(); renderJourney(); updateWalkLine(); showQuest(); }
function showQuestFinal(quest) {
  const saved = questProgress(quest); if (!saved.completed) return;
  const actions = el('div', 'dialog-actions'); actions.append(button('К другим квестам', 'primary-button', leaveQuest), button('Сбросить прогресс', 'text-button', () => resetQuest(quest)));
  openDialog('detail-dialog', [guideCard('surprised', 'Квест завершён', quest.title), el('p', 'info-note', `Пройдено ${saved.visited.length} из ${quest.stops.length}`), actions]);
}
async function postJSON(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Не удалось выполнить запрос');
  return response.json();
}
// --- Задача 013: демо-вход, отметки «был здесь» и «нравится», профиль и топ.
// Сессия живёт только в HttpOnly-куке: JS не видит токен и ничего не хранит в
// localStorage; same-origin запросы несут куку сами. Пароль существует только
// внутри обработчика отправки формы. ---
const auth = { user: null };
const AUTH_ERRORS = {
  401: 'Неверный логин или пароль',
  409: 'Такой логин уже занят',
  422: 'Логин 3–32 символа: латиница, цифры, _ . - Пароль — от 8 до 128 символов.',
  429: 'Слишком много попыток. Подождите минуту и попробуйте снова.'
};
async function apiSend(url, method = 'GET', body) {
  const options = { method, signal: AbortSignal.timeout(15000) };
  if (body !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(body); }
  const response = await fetch(url, options);
  let data = null;
  if (response.status !== 204) { try { data = await response.json(); } catch {} }
  if (!response.ok) { const error = new Error(data?.error?.message || 'Запрос не выполнен'); error.status = response.status; throw error; }
  return data;
}
function renderAuthButton() {
  const toggle = $('auth-open'); if (!toggle) return;
  toggle.textContent = auth.user ? auth.user.login : 'Войти';
  toggle.classList.toggle('is-authed', Boolean(auth.user));
  toggle.setAttribute('aria-label', auth.user ? 'Мой профиль: ' + auth.user.login : 'Войти в демо-аккаунт');
  toggle.title = auth.user ? 'Мой профиль' : 'Войти';
}
async function refreshMe() {
  // 401 — обычный гость, не ошибка; сетевой сбой тоже не блокирует карту.
  try { auth.user = (await apiSend('/api/v1/me'))?.user || null; } catch { auth.user = null; }
  renderAuthButton();
}
async function refreshSocial() {
  // Единственный источник счётчиков и личных отметок — ответ API.
  try {
    const payload = await getJSON('/api/v1/places');
    const fresh = new Map((payload.items || []).map(p => [p.id, p]));
    for (const place of state.places) {
      const next = fresh.get(place.id); if (!next) continue;
      place.visits = next.visits; place.likes = next.likes;
      place.visited_by_me = next.visited_by_me; place.liked_by_me = next.liked_by_me;
    }
  } catch {}
}
function authField(labelText, type, autocomplete) {
  const label = el('label', 'auth-field');
  const input = el('input');
  input.type = type; input.autocomplete = autocomplete; input.required = true;
  if (type === 'password') { input.minLength = 8; input.maxLength = 128; }
  else { input.minLength = 3; input.maxLength = 32; input.pattern = '[A-Za-z0-9_.\\-]+'; input.autocapitalize = 'none'; input.spellcheck = false; }
  label.append(el('span', 'auth-label', labelText), input);
  return { label, input };
}
function showAuthDialog(mode = 'login', message = '', afterLogin = null) {
  const head = dialogHeading('ДЕМО-АККАУНТ', mode === 'login' ? 'С возвращением' : 'Создать аккаунт', message || 'Достаточно логина и пароля.');
  const form = el('form', 'auth-form');
  const login = authField('Логин', 'text', 'username');
  const password = authField('Пароль', 'password', mode === 'login' ? 'current-password' : 'new-password');
  const error = el('p', 'auth-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const submit = button(mode === 'login' ? 'Войти' : 'Создать аккаунт', 'primary-button', null); submit.type = 'submit';
  form.append(login.label, password.label, error, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const loginValue = login.input.value.trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(loginValue) || password.input.value.length < 8 || password.input.value.length > 128) {
      error.hidden = false; error.textContent = AUTH_ERRORS[422]; return;
    }
    submit.disabled = true; error.hidden = true;
    try {
      const result = await apiSend('/api/v1/auth/' + (mode === 'login' ? 'login' : 'register'), 'POST', { login: loginValue, password: password.input.value });
      password.input.value = '';
      auth.user = result.user; renderAuthButton();
      await closeDialog('auth-dialog');
      notify(mode === 'login' ? 'Вы вошли как ' + auth.user.login : 'Аккаунт создан. Привет, ' + auth.user.login + '!');
      await refreshSocial(); renderPlaces();
      if (afterLogin) afterLogin();
    } catch (requestError) {
      submit.disabled = false; error.hidden = false;
      error.textContent = AUTH_ERRORS[requestError.status] || 'Не удалось связаться с сервером. Проверьте соединение и попробуйте снова.';
    }
  });
  const switchMode = button(mode === 'login' ? 'Нет аккаунта? Создать' : 'Уже есть аккаунт? Войти', 'text-button', () => showAuthDialog(mode === 'login' ? 'register' : 'login', '', afterLogin));
  const note = el('p', 'info-note', 'Демо-вход без email: пароль не восстановить. Не используйте реальные пароли от других сервисов. Логин видно всем в топе исследователей.');
  openDialog('auth-dialog', [head, form, switchMode, note]);
}
async function logoutUser() {
  if (auth.loggingOut) return;
  auth.loggingOut = true;
  try { await apiSend('/api/v1/auth/logout', 'POST'); }
  catch (requestError) {
    if (requestError.status !== 401) {
      notify('Не удалось подтвердить выход. Проверьте соединение и повторите.');
      return;
    }
  } finally { auth.loggingOut = false; }
  auth.user = null; renderAuthButton();
  for (const place of state.places) { place.visited_by_me = false; place.liked_by_me = false; }
  await closeDialog('detail-dialog');
  await refreshSocial(); renderPlaces();
  notify('Вы вышли. Отметки остались в аккаунте.');
}
function sessionExpired(afterLogin) {
  auth.user = null; renderAuthButton();
  showAuthDialog('login', 'Сессия закончилась — войдите снова.', afterLogin);
}
function socialBlock(place) {
  const box = el('div', 'social-box');
  const counters = el('p', 'social-counters');
  const visit = button('Я был здесь', 'social-toggle', () => toggleMark(visit, 'visit'));
  const like = button('Нравится', 'social-toggle', () => toggleMark(like, 'like'));
  const sync = () => {
    counters.textContent = `Посетили: ${place.visits ?? 0} · Нравится: ${place.likes ?? 0}`;
    visit.textContent = place.visited_by_me ? 'Я был здесь ✓' : 'Я был здесь';
    visit.setAttribute('aria-pressed', String(Boolean(place.visited_by_me)));
    like.textContent = place.liked_by_me ? 'Нравится ✓' : 'Нравится';
    like.setAttribute('aria-pressed', String(Boolean(place.liked_by_me)));
  };
  async function toggleMark(toggle, kind) {
    if (!auth.user) { showAuthDialog('login', 'Войдите, чтобы отметить место.', () => showPlace(place)); return; }
    const active = kind === 'visit' ? place.visited_by_me : place.liked_by_me;
    toggle.disabled = true;
    try {
      const result = await apiSend(`/api/v1/places/${encodeURIComponent(place.id)}/${kind}`, active ? 'DELETE' : 'POST');
      if (kind === 'visit') { place.visited_by_me = result.visited; place.visits = result.visits; }
      else { place.liked_by_me = result.liked; place.likes = result.likes; }
    } catch (requestError) {
      if (requestError.status === 401) { toggle.disabled = false; sessionExpired(() => showPlace(place)); return; }
      notify('Не удалось сохранить отметку. Проверьте соединение и попробуйте ещё раз.');
    }
    toggle.disabled = false; sync();
  }
  const actions = el('div', 'social-actions'); actions.append(visit, like);
  box.append(counters, actions, el('p', 'micro-copy', '«Посетили» — отметки пользователей демо, не подтверждённые визиты.'));
  sync(); return box;
}
async function showProfile() {
  if (!auth.user) { showAuthDialog('login'); return; }
  const body = el('div', 'profile-body'); body.append(el('p', 'info-note', 'Загружаем профиль…'));
  const opening = openDialog('detail-dialog', [dialogHeading('МОЙ ПРОФИЛЬ', auth.user.login, 'Отметки живут в демо-аккаунте.'), body]);
  const revision = dialogRevision;
  await opening;
  try {
    const profile = await apiSend('/api/v1/me/profile');
    if (revision !== dialogRevision || !$('detail-dialog').open) return;
    const stats = el('div', 'profile-stats');
    for (const [value, caption] of [[profile.stats.visits, 'посетил'], [profile.stats.likes, 'понравилось']]) {
      const cell = el('div', 'profile-stat'); cell.append(el('strong', '', String(value)), el('span', '', caption)); stats.append(cell);
    }
    const lists = el('div', 'profile-lists');
    for (const [title, ids] of [['Посетил', profile.visited_place_ids], ['Понравились', profile.liked_place_ids]]) {
      const section = el('div', 'profile-list'); section.append(el('h3', '', `${title}: ${ids.length}`));
      const names = el('ul', 'profile-places');
      for (const id of ids.slice(0, 30)) names.append(el('li', '', state.places.find(p => p.id === id)?.title || 'Место вне текущего каталога'));
      if (!ids.length) names.append(el('li', 'profile-empty', 'Пока пусто'));
      section.append(names); lists.append(section);
    }
    const actions = el('div', 'dialog-actions');
    actions.append(button('Мой топ', 'primary-button', showLeaderboard, 'arrow'), button('Выйти', 'secondary-button', logoutUser));
    body.replaceChildren(stats, lists, el('p', 'micro-copy', '«Посетил» — это ваши отметки, а не подтверждённые визиты.'), actions);
  } catch (requestError) {
    if (revision !== dialogRevision || !$('detail-dialog').open) return;
    if (requestError.status === 401) { sessionExpired(); return; }
    body.replaceChildren(el('p', 'info-note', 'Не удалось загрузить профиль. Проверьте соединение.'), button('Повторить', 'primary-button', showProfile));
  }
}
async function showLeaderboard() {
  const body = el('div', 'board-body'); body.append(el('p', 'info-note', 'Загружаем топ…'));
  const opening = openDialog('detail-dialog', [dialogHeading('ТОП ИССЛЕДОВАТЕЛЕЙ', 'Кто отметил больше мест', 'По отметкам посещений. Демо-данные: визит не подтверждается, лайки на место в топе не влияют.'), body]);
  const revision = dialogRevision;
  await opening;
  try {
    const board = await apiSend('/api/v1/leaderboard?limit=10');
    if (revision !== dialogRevision || !$('detail-dialog').open) return;
    if (!board.items.length) { body.replaceChildren(el('p', 'info-note', 'Пока никто не отметил ни одного места. Станьте первым!')); return; }
    const list = el('ol', 'board-list');
    board.items.forEach((row, index) => {
      const item = el('li', 'board-row' + (auth.user && row.login === auth.user.login ? ' is-me' : ''));
      item.append(el('span', 'board-rank', String(index + 1)), el('span', 'board-login', row.login), el('span', 'board-count', `посещений: ${row.visits}`), el('span', 'board-likes', `лайков: ${row.likes}`));
      list.append(item);
    });
    body.replaceChildren(list);
    if (board.total > board.items.length) body.append(el('p', 'micro-copy', `Показаны первые ${board.items.length} из ${board.total}.`));
  } catch {
    if (revision !== dialogRevision || !$('detail-dialog').open) return;
    body.replaceChildren(el('p', 'info-note', 'Не удалось загрузить топ. Проверьте соединение.'), button('Повторить', 'primary-button', showLeaderboard));
  }
}
function showManualOrigin() {
  const select = el('select', 'manual-select'); select.setAttribute('aria-label', 'Начальная точка');
  for (const place of state.places) { const option = el('option', '', place.title); option.value = place.id; select.append(option); }
  const use = button('Искать рядом с этой точкой', 'primary-button', () => { const place = state.places.find(p => p.id === select.value); if (place) setManualOrigin(place); closeDialog('firsttime-dialog'); $('nearby-options').open = true; revealPlaces(); });
  // Задача 014: свои координаты вручную — для плохой геолокации. Значения
  // валидируются и живут только в памяти страницы (geo), никуда не уходят.
  const coords = el('form', 'manual-coords');
  const coordInput = labelText => {
    const label = el('label', 'manual-coord');
    const input = el('input'); input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off'; input.spellcheck = false; input.required = true;
    label.append(el('span', '', labelText), input);
    return { label, input };
  };
  const lat = coordInput('Широта (−90…90)');
  const lng = coordInput('Долгота (−180…180)');
  const coordError = el('p', 'auth-error'); coordError.setAttribute('role', 'alert'); coordError.hidden = true;
  const applyCoords = button('Использовать координаты', 'secondary-button', null); applyCoords.type = 'submit';
  coords.append(el('p', 'eyebrow', 'ИЛИ ВВЕДИТЕ КООРДИНАТЫ'), lat.label, lng.label, coordError, applyCoords);
  coords.addEventListener('submit', event => {
    event.preventDefault();
    const latText = lat.input.value.trim().replace(',', '.');
    const lngText = lng.input.value.trim().replace(',', '.');
    const latValue = Number(latText);
    const lngValue = Number(lngText);
    if (!latText || !lngText || !Number.isFinite(latValue) || Math.abs(latValue) > 90 || !Number.isFinite(lngValue) || Math.abs(lngValue) > 180) {
      coordError.hidden = false; coordError.textContent = 'Нужны числа: широта от −90 до 90, долгота от −180 до 180.'; return;
    }
    setManualPoint(latValue, lngValue);
    closeDialog('firsttime-dialog'); $('nearby-options').open = true; revealPlaces();
  });
  openDialog('firsttime-dialog', [guideCard('location-unknown', 'Выбери старт вручную', 'Это выбранная точка, а не местоположение устройства.'), select, use, coords]);
}
function setManualPoint(lat, lng) {
  geo.reqId++; geo.origin = 'manual'; geo.lat = lat; geo.lng = lng; geo.accuracyM = null; geo.capturedAt = null;
  geo.radiusFilter = true;
  setGeoPhase('ready'); afterPositionSet();
}
function setManualOrigin(place) { setManualPoint(place.lat, place.lng); }
function mapStatus(text) { ui.status.textContent = text; ui.status.hidden = false; }
function frameMobilePlaces() {
  if (!state.map || !state.places.length || !isMobileLayout()) return;
  const stage = document.querySelector('.map-stage');
  const sheetHeight = document.querySelector('.sidebar').getBoundingClientRect().height;
  const visibleHeight = Math.max(1, stage.clientHeight - sheetHeight);
  const lngs = state.places.map(p => p.lng), lats = state.places.map(p => p.lat);
  state.map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], {
    padding: { top: Math.min(112, visibleHeight * .48), bottom: sheetHeight + Math.min(50, visibleHeight * .22), left: 64, right: 76 },
    maxZoom: 14.1, duration: 0
  });
}
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
    // Camera buffer lets fitBounds place POIs above the mobile sheet without
    // clamping the padded viewport north. The catalogue remains Leninsky only.
    const map = new maplibregl.Map({ container: "map", style: "map-style.json", center: [131.901,43.119], zoom: 14.6, minZoom: 11.3, maxZoom: 18, maxBounds: [[131.72,42.94],[132.22,43.30]], attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
    state.map = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    let loaded = false;
    const timer = setTimeout(() => { if (!loaded) mapStatus("Карта загружается дольше обычного. Места доступны в списке."); }, 12000);
    map.once("style.load", () => {
      loaded = true; clearTimeout(timer); ui.status.hidden = true;
      map.addSource("leninsky", { type: "geojson", data: state.boundary });
      map.addLayer({ id: "district-fill", type: "fill", source: "leninsky", paint: { "fill-color": "#ff8500", "fill-opacity": 0.025 } });
      map.addLayer({ id: "district-outline", type: "line", source: "leninsky", paint: { "line-color": "#ed9a49", "line-width": 1.7, "line-opacity": 0.65, "line-dasharray": [3,3] } });
      map.addSource('walk-path', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'walk-path', type: 'line', source: 'walk-path', paint: { 'line-color': '#df7200', 'line-width': 3, 'line-dasharray': [2, 3], 'line-opacity': .8 } });
      for (const place of state.places) {
        const pin = button("", "map-marker", () => selectPlace(place)); pin.setAttribute("aria-label", place.title);
        const bubble = el("span", "map-marker-bubble"); bubble.append(image(place.image,""));
        pin.append(bubble, el("span", "map-marker-label", place.label));
        const marker = new maplibregl.Marker({ element: pin, anchor: "bottom" }).setLngLat([place.lng,place.lat]).addTo(map);
        pin.setAttribute('aria-label',place.title);
        state.markers.set(place.id, marker);
      }
      renderPlaces(); updateSelectedMarkers(); updateWalkLine(); placeYouMarker();
      frameMobilePlaces();
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
// Оценочное время пешком: ~80 м/мин (≈4.8 км/ч), по прямой, без учёта маршрута.
function walkMinutes(m) { return Math.max(1, Math.round(m / 80)); }
function formatTime(ts) { return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
function nearbyStatus(text, show = true) { const s = $("nearby-status"); if (!s) return; s.textContent = text || ""; s.hidden = !show || !text; }
function setGeoPhase(phase) {
  geo.phase = phase;
  const btn = $("nearby-request"); if (btn) btn.disabled = phase === "requesting";
  const actions = $("nearby-actions"); if (actions) actions.hidden = !geo.origin && phase !== 'requesting';
  if ($('nearby-refresh')) $('nearby-refresh').hidden = geo.origin !== 'device';
  if ($('nearby-clear')) $('nearby-clear').textContent = phase === 'requesting' ? 'Отменить запрос' : 'Очистить старт';
  refreshPresence();
}
function clearYouMarker() { if (geo.youMarker) { geo.youMarker.remove(); geo.youMarker = null; } }
function placeYouMarker() {
  clearYouMarker();
  if (!state.map || !geo.origin) return;
  const pin = el("div", "you-marker"); pin.setAttribute("aria-hidden", "true");
  pin.append(el("span", "you-dot"), el("span", "you-label", geo.origin === 'device' ? 'Вы здесь' : 'Выбранная точка'));
  geo.youMarker = new maplibregl.Marker({ element: pin, anchor: "center" }).setLngLat([geo.lng, geo.lat]).addTo(state.map);
}
function nearbyWithinRadius() {
  // Count catalogue places within the current radius (list filters also apply
  // to the rendered list, but the status counter reflects the radius scope).
  return state.places.filter(p => haversineM(geo.lat, geo.lng, p.lat, p.lng) <= geo.radiusM).length;
}
function syncShowAllButton() {
  const b = $("nearby-show-all"); if (b) b.textContent = geo.radiusFilter ? "Показать все места" : "Только рядом";
}
function radiusLabel() { return geo.radiusM < 1000 ? geo.radiusM + " м" : (geo.radiusM / 1000) + " км"; }
function updateNearbyStatus() {
  if (!geo.origin) return;
  const total = state.places.length, within = nearbyWithinRadius();
  const shown = geo.radiusFilter ? within : total;
  let text = (geo.origin === 'device' ? 'Рядом со мной' : 'Выбранная точка') + ' · ' + radiusLabel() + ' · ' + shown + ' из ' + total + ' мест';
  if (geo.origin === 'device') text += " · точность около " + Math.round(geo.accuracyM) + " м · определено в " + formatTime(geo.capturedAt);
  if (geo.radiusFilter && Number.isFinite(geo.accuracyM) && geo.accuracyM > geo.radiusM) text += ". Точность ниже радиуса — результат приблизительный, обновите позицию или выберите точку вручную.";
  nearbyStatus(text);
}
function afterPositionSet() {
  // Shared result for list and map; status carries counter, accuracy and time.
  placeYouMarker(); renderPlaces(); syncShowAllButton(); updateNearbyStatus();
  if (state.map) state.map.flyTo({ center: [geo.lng, geo.lat], zoom: Math.max(state.map.getZoom(), 14.6), duration: reducedMotion ? 0 : 600 });
}
function requestNearby(fresh) {
  if (!window.isSecureContext) { setGeoPhase('unavailable'); nearbyStatus('Для геолокации нужен HTTPS или localhost. Выберите старт вручную.'); return; }
  if (!("geolocation" in navigator)) { setGeoPhase("unavailable"); nearbyStatus("Браузер не поддерживает геолокацию. Выберите место в списке или на карте вручную."); return; }
  const reqId = ++geo.reqId; setGeoPhase("requesting"); nearbyStatus("Ищу твою точку. Пока далеко не убегай.");
  navigator.geolocation.getCurrentPosition(pos => {
    if (reqId !== geo.reqId) return; // stale callback: a newer request or a clear happened
    const { latitude, longitude, accuracy } = pos.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || !Number.isFinite(accuracy) || accuracy < 0) { setGeoPhase("unavailable"); nearbyStatus("Не удалось определить координаты. Попробуйте обновить позицию или выбрать точку вручную."); return; }
    geo.origin = "device"; geo.lat = latitude; geo.lng = longitude; geo.accuracyM = accuracy; geo.capturedAt = Date.now();
    setGeoPhase("ready"); afterPositionSet();
  }, err => {
    if (reqId !== geo.reqId) return;
    if (err.code === err.PERMISSION_DENIED) { setGeoPhase("denied"); nearbyStatus("Хорошо, без геолокации. Выбери старт вручную — этого достаточно."); }
    else if (err.code === err.TIMEOUT) { setGeoPhase("timeout"); nearbyStatus("Поймать твоё положение не получилось. Попробуем ещё раз или выберем старт вручную?"); }
    else { setGeoPhase("unavailable"); nearbyStatus("Не удалось определить местоположение. Обновите позицию или выберите точку вручную."); }
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: fresh ? 0 : 60000 });
}
function clearNearby(render = true) {
  geo.reqId++; // invalidate any in-flight callback
  geo.origin = null; geo.lat = geo.lng = geo.accuracyM = geo.capturedAt = null; geo.radiusFilter = true;
  clearYouMarker(); setGeoPhase("idle"); nearbyStatus("", false); syncShowAllButton(); if (render) renderPlaces();
}
function toggleRadiusFilter() {
  if (!geo.origin) return;
  geo.radiusFilter = !geo.radiusFilter;
  renderPlaces(); syncShowAllButton(); updateNearbyStatus();
}
$("nearby-request")?.addEventListener("click", () => requestNearby(false));
$("nearby-refresh")?.addEventListener("click", () => requestNearby(true));
$("nearby-clear")?.addEventListener("click", clearNearby);
$("nearby-manual")?.addEventListener('click', showManualOrigin);
$("nearby-show-all")?.addEventListener("click", toggleRadiusFilter);
// Changing the radius never force-enables the filter; it only recomputes the
// list/counter. If the filter was off, it stays off.
$("nearby-radius")?.addEventListener("change", e => { const v = parseInt(e.target.value, 10); if (v >= 100 && v <= 5000) { geo.radiusM = v; renderPlaces(); if (geo.origin) updateNearbyStatus(); } });
$("zoom-in").addEventListener("click", () => state.map ? state.map.zoomIn({duration:200}) : notify("Масштабирование доступно при загрузке карты"));
$("zoom-out").addEventListener("click", () => state.map ? state.map.zoomOut({duration:200}) : notify("Масштабирование доступно при загрузке карты"));
$("fit-district").addEventListener("click", () => state.map ? state.map.fitBounds([[131.8843306,43.0974826],[132.0481927,43.1499040]],{padding:55,duration:reducedMotion?0:700}) : notify("На схеме показан весь район"));
ui.search.addEventListener("input", () => { state.query = ui.search.value.trim(); renderPlaces(); });
document.querySelectorAll("[data-category]").forEach(b=>b.addEventListener("click",()=>chooseCategory(b.dataset.category)));
document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>{ if(b.dataset.view==='walks')showWalk();else if(b.dataset.view==='quests')showQuest();else{resetFilters();if(isMobileLayout())frameMobilePlaces();else state.map?.flyTo({center:[131.901,43.119],zoom:14.6,duration:reducedMotion?0:650});} }));
$("first-time").addEventListener("click",showFirstTime);
$("guide-open").addEventListener("click",showGuide);
$("walk-promo")?.addEventListener("click",showWalk);
$("bookmarks-open")?.addEventListener("click",()=>{state.savedOnly=!state.savedOnly;renderPlaces();if(isMobileLayout())revealPlaces();});
$("auth-open")?.addEventListener("click", () => auth.user ? showProfile() : showAuthDialog('login'));
$("mobile-sheet-toggle")?.addEventListener("click",()=>{ const sheet=document.querySelector('.sidebar');sheet.classList.toggle('is-collapsed');$('mobile-sheet-toggle').setAttribute('aria-expanded',String(!sheet.classList.contains('is-collapsed'))); });
document.querySelectorAll('[data-close-dialog]').forEach(b => b.addEventListener('click', () => closeDialog(b.closest('dialog'))));
document.querySelectorAll('dialog').forEach(d => {
  d.addEventListener('cancel', event => { event.preventDefault(); closeDialog(d); });
  d.addEventListener('click', event => {
    if (event.target !== d) return;
    const rect = d.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(d);
  });
});
let mobileViewport=isMobileLayout();
window.addEventListener('resize',()=>{const mobile=isMobileLayout();if(state.map){state.map.resize();if(mobile&&!state.selected)frameMobilePlaces();else if(mobile!==mobileViewport)state.map.setPadding({top:0,bottom:0,left:0,right:0});}mobileViewport=mobile;});
async function loadCity() {
  try {
    const [boundary, places, walks, quests] = await Promise.all([getJSON('/data/leninsky-boundary.geojson'), getJSON('/api/v1/places'), getJSON('/api/v1/walks'), getJSON('/api/v1/quest')]);
    state.boundary = boundary; state.places = prepareAPIPlaces(places.items || []);
    const ids = new Set(state.places.map(p => p.id));
    state.walks = (walks.items || []).filter(w => w.place_ids?.length && w.place_ids.every(id => ids.has(id)));
    state.quests = (quests.items || []).filter(q => q.stops?.length && q.stops.every(stop => ids.has(stop.place_id)));
    readStorage(); writeStorage();
    progress.quests = Object.fromEntries(state.quests.map(quest => [quest.id, questProgress(quest)]));
    if (progress.walk) {
      state.activeWalk = state.walks.find(w => w.id === progress.walk.id) || null;
      if (state.activeWalk) walkProgress(state.activeWalk); else delete progress.walk;
    }
    state.activeQuest = state.quests.find(q => q.id === progress.activeQuest?.id) || null;
    if (state.activeQuest) state.activeWalk = null; else delete progress.activeQuest;
    saveProgress();
    refreshMe();
    $('catalog-note').textContent = `${state.places.length} мест из районного каталога. Условия посещения уточняются; перед выходом проверьте источник.`;
    renderPlaces(); renderJourney(); initialiseMap();
    if (state.activeQuest) openQuest(state.activeQuest);
  } catch {
    const box = el('li', 'empty-state'); box.append(el('h3', '', 'Не удалось загрузить город'), el('p', '', 'Запустите весь проект через start.cmd. Для работы нужен API, а не отдельная статическая страница.'), button('Повторить загрузку', 'secondary-button', loadCity));
    ui.list.replaceChildren(box); ui.count.textContent = '—'; mapStatus('Каталог временно недоступен');
  }
}
loadCity();
if ('serviceWorker' in navigator && window.isSecureContext) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
