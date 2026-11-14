/** Synthetic navigator only: no device permission, location, browser or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const syntheticTime = 1700000123456;
const positionOptions = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
const warning = /[Пп]риблизительный/;

function harness() {
  const elements = new Map(), callbacks = [], fetches = [], writes = [];
  const urlWrites = [], beacons = [], logs = [], watches = [], timers = [], markers = [];
  let now = syntheticTime;
  const node = () => ({
    hidden: false, disabled: false, textContent: '', value: '', children: [],
    listeners: new Map(),
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, toggleAttribute() {},
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    },
    dispatch(type) {
      for (const listener of this.listeners.get(type) || []) listener({ target: this });
    },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const location = { origin: 'https://example.test' };
  for (const [key, initial] of [['href', 'https://example.test/'], ['search', ''], ['hash', '']]) {
    Object.defineProperty(location, key, { get: () => initial, set: value => urlWrites.push([key, value]) });
  }
  const history = {
    pushState(...args) { urlWrites.push(['pushState', ...args]); },
    replaceState(...args) { urlWrites.push(['replaceState', ...args]); },
  };
  const storage = { getItem: () => null, setItem(key, value) { writes.push([key, value]); } };
  class SyntheticDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    document: { getElementById: element, createElement: node, querySelectorAll: () => [] },
    window: { isSecureContext: true, addEventListener() {}, location, history },
    location, history,
    navigator: {
      geolocation: {
        getCurrentPosition(success, error, options) { callbacks.push({ success, error, options }); },
        watchPosition(...args) { watches.push(args); },
      },
      sendBeacon(...args) { beacons.push(args); return true; },
    },
    localStorage: storage, sessionStorage: storage,
    // Boot reads remain pending: this isolates GPS behavior from map/render loading.
    fetch(url, options) { fetches.push({ url, options }); return new Promise(() => {}); },
    maplibregl: { Marker: class {
      constructor(options) { this.options = options; this.removed = false; markers.push(this); }
      setLngLat(coordinates) { this.coordinates = coordinates; return this; }
      addTo() { return this; }
      remove() { this.removed = true; }
    } },
    matchMedia: () => ({ matches: false }),
    setTimeout(...args) { timers.push(args); return timers.length; }, clearTimeout() {}, AbortSignal, URL,
    Date: SyntheticDate,
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(method => [method, (...args) => logs.push([method, ...args])])),
    innerWidth: 1280, innerHeight: 800,
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  const run = expression => vm.runInContext(expression, context);
  const snapshot = () => JSON.parse(run('JSON.stringify({origin:geo.origin, lat:geo.lat, lng:geo.lng, phase:geo.phase, accuracyM:geo.accuracyM})'));
  const details = () => JSON.parse(run('JSON.stringify({capturedAt:geo.capturedAt, radiusM:geo.radiusM, radiusFilter:geo.radiusFilter, hasMarker:geo.youMarker !== null})'));
  const status = () => element('nearby-status').textContent;
  const click = id => element(id).dispatch('click');
  const changeRadius = value => { element('nearby-radius').value = String(value); element('nearby-radius').dispatch('change'); };
  const advanceTime = milliseconds => { now += milliseconds; };
  const position = (latitude = 12.345678, longitude = 98.765432, accuracy = 15) => ({ coords: { latitude, longitude, accuracy } });
  const fail = code => ({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  return { run, snapshot, details, status, click, changeRadius, advanceTime, callbacks, fetches, writes, elements, position, fail, urlWrites, beacons, logs, watches, timers, markers };
}

test('no location request occurs on application load or insecure context', () => {
  const h = harness();
  assert.equal(h.callbacks.length, 0);
  h.run('window.isSecureContext = false; requestNearby(false)');
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.snapshot().origin, null);
  assert.equal(h.snapshot().phase, 'unavailable');
});

test('unsupported geolocation leaves the manual path available without a lookup', () => {
  const h = harness();
  h.run('delete navigator.geolocation; requestNearby()');
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.snapshot().phase, 'unavailable');
  assert.equal(h.elements.get('nearby-request').disabled, false);
  assert.equal(h.elements.get('nearby-manual').disabled, false);
  assert.match(h.status(), /вручную/);
});

for (const [code, expected] of [[1, 'denied'], [3, 'timeout'], [2, 'unavailable'], [99, 'unavailable']]) {
  test(`GPS ${expected} leaves no origin and enables another attempt`, () => {
    const h = harness();
    const initialTimerCount = h.timers.length;
    h.run('requestNearby(false)');
    assert.equal(h.elements.get('nearby-request').disabled, true);
    assert.equal(h.elements.get('nearby-manual').disabled, false);
    h.callbacks[0].error(h.fail(code));
    assert.equal(h.snapshot().phase, expected);
    assert.equal(h.snapshot().origin, null);
    assert.equal(h.snapshot().lat, null);
    assert.equal(h.elements.get('nearby-request').disabled, false);
    assert.equal(h.elements.get('nearby-refresh').disabled, false);
    assert.equal(h.elements.get('nearby-manual').disabled, false);
    assert.match(h.status(), /вручную/);
    assert.equal(h.callbacks.length, 1);
    assert.equal(h.watches.length, 0);
    assert.equal(h.timers.length, initialTimerCount);
    h.run('setManualOrigin({lat: 10, lng: 20})');
    assert.equal(h.snapshot().origin, 'manual');
    assert.equal(h.snapshot().phase, 'ready');
  });

  test(`GPS refresh error ${code} restores controls and still permits a manual origin`, () => {
    const h = harness();
    h.run('state.map = {getZoom: () => 14, flyCount: 0, flyTo() { this.flyCount++; }}');
    h.click('nearby-request');
    h.callbacks[0].success(h.position(12.345678, 98.765432, 35));
    const previousPosition = h.snapshot();
    const previousDetails = h.details();
    const determinedAt = h.run('formatTime(geo.capturedAt)');
    h.advanceTime(60000);
    h.click('nearby-refresh');
    assert.equal(h.elements.get('nearby-request').disabled, true);
    assert.match(h.status(), /[Пп]редыдущ/);
    assert.match(h.status(), /±35 м/);
    assert.ok(h.status().includes(`определено в ${determinedAt}`));
    h.callbacks[1].error(h.fail(code));
    assert.equal(h.snapshot().phase, expected);
    assert.deepEqual(h.snapshot(), { ...previousPosition, phase: expected });
    assert.deepEqual(h.details(), previousDetails);
    assert.match(h.status(), /[Пп]редыдущ/);
    assert.match(h.status(), /±35 м/);
    assert.ok(h.status().includes(`определено в ${determinedAt}`));
    assert.match(h.status(), code === 1 ? /без геолокации/ : code === 3 ? /не получилось/ : /Не удалось/);
    assert.equal(h.markers.length, 1);
    assert.equal(h.markers[0].removed, false);
    assert.equal(h.run('state.map.flyCount'), 1);
    for (const id of ['nearby-request', 'nearby-refresh', 'nearby-manual']) assert.equal(h.elements.get(id).disabled, false);
    assert.match(h.status(), /вручную/);
    h.run('setManualOrigin({lat: 10, lng: 20})');
    assert.equal(h.snapshot().origin, 'manual');
    assert.equal(h.snapshot().phase, 'ready');
  });
}

test('invalid refresh coordinates preserve the previous position and its original time', () => {
  const h = harness();
  h.run('state.map = {getZoom: () => 14, flyCount: 0, flyTo() { this.flyCount++; }}');
  h.click('nearby-request');
  h.callbacks[0].success(h.position(12.345678, 98.765432, 35));
  const previous = { snapshot: h.snapshot(), details: h.details() };
  h.advanceTime(60000);
  h.click('nearby-refresh');
  h.callbacks[1].success(h.position(NaN));
  assert.deepEqual(h.snapshot(), { ...previous.snapshot, phase: 'unavailable' });
  assert.deepEqual(h.details(), previous.details);
  assert.match(h.status(), /Не удалось определить координаты/);
  assert.match(h.status(), /[Пп]редыдущ/);
  assert.match(h.status(), /±35 м/);
  assert.ok(h.status().includes(`определено в ${h.run('formatTime(geo.capturedAt)')}`));
  assert.equal(h.markers.length, 1);
  assert.equal(h.markers[0].removed, false);
  assert.equal(h.run('state.map.flyCount'), 1);
  for (const id of ['nearby-request', 'nearby-refresh', 'nearby-manual']) assert.equal(h.elements.get(id).disabled, false);
  h.run('setManualOrigin({lat: 10, lng: 20})');
  assert.equal(h.snapshot().origin, 'manual');
});

test('clear invalidates both late success and error callbacks', () => {
  const h = harness();
  h.run('requestNearby(false); clearNearby()');
  h.callbacks[0].success(h.position());
  h.callbacks[0].error(h.fail(1));
  assert.deepEqual(h.snapshot(), { origin: null, lat: null, lng: null, phase: 'idle', accuracyM: null });
  assert.equal(h.details().capturedAt, null);
  assert.equal(h.elements.get('nearby-request').disabled, false);
  assert.equal(h.elements.get('nearby-status').hidden, true);
  assert.equal(h.status(), '');
});

test('clear removes an existing marker and late callbacks cannot restore it', () => {
  const h = harness();
  h.run('state.map = {getZoom: () => 14, flyTo() {}}; requestNearby()');
  h.callbacks[0].success(h.position());
  assert.equal(h.markers.length, 1);
  assert.equal(h.details().hasMarker, true);
  h.click('nearby-refresh');
  h.run('clearNearby()');
  assert.equal(h.markers[0].removed, true);
  assert.equal(h.details().hasMarker, false);
  h.callbacks[1].success(h.position(33, 44, 350));
  h.callbacks[1].error(h.fail(3));
  assert.equal(h.markers.length, 1);
  assert.deepEqual(h.snapshot(), { origin: null, lat: null, lng: null, phase: 'idle', accuracyM: null });
  assert.equal(h.details().capturedAt, null);
  assert.equal(h.status(), '');
});

test('manual origin wins against an earlier in-flight device lookup', () => {
  const h = harness();
  h.run('requestNearby(false); setManualOrigin({lat: 10, lng: 20})');
  h.callbacks[0].success(h.position());
  h.callbacks[0].error(h.fail(3));
  assert.deepEqual(h.snapshot(), { origin: 'manual', lat: 10, lng: 20, phase: 'ready', accuracyM: null });
  assert.equal(h.details().capturedAt, null);
  assert.match(h.status(), /Выбранная точка/);
  assert.doesNotMatch(h.status(), /точность|определено|±|[Пп]риблизительный/);
  assert.equal(h.elements.get('nearby-refresh').hidden, true);
});

test('first lookup and refresh use the exact fresh high-accuracy options', () => {
  const h = harness();
  h.click('nearby-request');
  assert.deepEqual({ ...h.callbacks[0].options }, positionOptions);
  assert.equal(h.elements.get('nearby-request').disabled, true);
  assert.equal(h.elements.get('nearby-manual').disabled, false);
  assert.match(h.status(), /15 секунд/);
  h.callbacks[0].success(h.position());
  assert.equal(h.elements.get('nearby-request').disabled, false);
  assert.equal(h.elements.get('nearby-refresh').hidden, false);
  assert.equal(h.elements.get('nearby-clear').textContent, 'Не использовать моё местоположение');
  h.click('nearby-refresh');
  assert.deepEqual({ ...h.callbacks[1].options }, positionOptions);
  assert.equal(h.callbacks.length, 2);
  assert.equal(h.watches.length, 0);
});

test('latest lookup wins and both requests bypass the position cache', () => {
  const h = harness();
  h.run('requestNearby(false); requestNearby(true)');
  assert.deepEqual({ ...h.callbacks[0].options }, positionOptions);
  assert.deepEqual({ ...h.callbacks[1].options }, positionOptions);
  const pendingStatus = h.status();
  h.callbacks[0].success(h.position(33, 44, 800));
  h.callbacks[0].error(h.fail(1));
  assert.equal(h.snapshot().phase, 'requesting');
  assert.equal(h.snapshot().origin, null);
  assert.equal(h.snapshot().accuracyM, null);
  assert.equal(h.details().capturedAt, null);
  assert.equal(h.elements.get('nearby-request').disabled, true);
  assert.equal(h.status(), pendingStatus);
  h.callbacks[1].success(h.position(11, 22));
  const completed = { snapshot: h.snapshot(), details: h.details(), status: h.status() };
  h.advanceTime(60000);
  h.callbacks[0].success(h.position(33, 44, 800));
  h.callbacks[0].error(h.fail(3));
  assert.deepEqual({ snapshot: h.snapshot(), details: h.details(), status: h.status() }, completed);
  assert.equal(h.snapshot().lat, 11);
  assert.equal(h.snapshot().lng, 22);
});

for (const [accuracy, radius] of [[350, 1000], [800, 1000], [300, 5000]]) {
  test(`accuracy ${accuracy} m warns at radius ${radius} m without changing it`, () => {
    const h = harness();
    h.changeRadius(radius);
    h.click('nearby-request');
    h.callbacks[0].success(h.position(12.345678, 98.765432, accuracy));
    assert.match(h.status(), warning);
    assert.ok(h.status().includes(`±${accuracy} м`));
    assert.match(h.status(), /расстояние считается по прямой/);
    assert.match(h.status(), /Обновить местоположение/);
    assert.match(h.status(), /Выбрать вручную/);
    assert.doesNotMatch(h.status(), /%/);
    assert.equal(h.details().radiusM, radius);
    assert.equal(h.details().capturedAt, syntheticTime);
    assert.ok(h.status().includes(`определено в ${h.run('formatTime(geo.capturedAt)')}`));
    assert.equal(h.elements.get('nearby-status').hidden, false);
  });
}

test('accurate position displays its estimate and determination time without a warning', () => {
  const h = harness();
  h.click('nearby-request');
  h.callbacks[0].success(h.position(12.345678, 98.765432, 35));
  assert.match(h.status(), /Рядом со мной/);
  assert.match(h.status(), /точность примерно ±35 м/);
  assert.ok(h.status().includes(`определено в ${h.run('formatTime(geo.capturedAt)')}`));
  assert.doesNotMatch(h.status(), warning);
  assert.equal(h.details().radiusM, 1000);
});

for (const [accuracy, shouldWarn] of [[100, false], [101, true]]) {
  test(`the accuracy warning threshold is strictly above 100 m (${accuracy} m) with filter off`, () => {
    const h = harness();
    h.changeRadius(5000);
    h.click('nearby-request');
    h.callbacks[0].success(h.position(12.345678, 98.765432, accuracy));
    h.run('toggleRadiusFilter()');
    assert.equal(warning.test(h.status()), shouldWarn);
    assert.equal(h.details().radiusFilter, false);
    assert.equal(h.details().radiusM, 5000);
    assert.equal(h.callbacks.length, 1);
  });
}

test('warning and disabled radius filter survive radius changes and GPS refresh', () => {
  const h = harness();
  h.click('nearby-request');
  h.callbacks[0].success(h.position(12.345678, 98.765432, 350));
  h.run('toggleRadiusFilter()');
  assert.match(h.status(), warning);
  assert.equal(h.details().radiusFilter, false);
  assert.equal(h.elements.get('nearby-show-all').textContent, 'Только рядом');
  for (const radius of [300, 5000, 1000]) {
    h.changeRadius(radius);
    assert.equal(h.details().radiusM, radius);
    assert.equal(h.details().radiusFilter, false);
    assert.match(h.status(), warning);
    assert.equal(h.callbacks.length, 1);
  }
  h.click('nearby-refresh');
  h.callbacks[1].success(h.position(12.345678, 98.765432, 300));
  assert.equal(h.details().radiusFilter, false);
  assert.equal(h.details().radiusM, 1000);
  assert.match(h.status(), warning);
  assert.equal(h.callbacks.length, 2);
});

test('radius changes recompute the warning without another GPS request', () => {
  const h = harness();
  h.click('nearby-request');
  h.callbacks[0].success(h.position(12.345678, 98.765432, 35));
  h.changeRadius(5000);
  assert.match(h.status(), /5 км/);
  assert.doesNotMatch(h.status(), warning);
  h.changeRadius(300);
  assert.match(h.status(), /300 м/);
  assert.doesNotMatch(h.status(), warning);
  assert.equal(h.callbacks.length, 1);
});

test('switching from GPS to manual clears accuracy, time, warning and refresh', () => {
  const h = harness();
  h.click('nearby-request');
  h.callbacks[0].success(h.position(12.345678, 98.765432, 350));
  assert.match(h.status(), warning);
  h.run('setManualOrigin({lat: 10, lng: 20})');
  assert.equal(h.snapshot().accuracyM, null);
  assert.equal(h.details().capturedAt, null);
  assert.match(h.status(), /Выбранная точка/);
  assert.doesNotMatch(h.status(), /точность|определено|±|[Пп]риблизительный/);
  assert.equal(h.elements.get('nearby-refresh').hidden, true);
  assert.equal(h.elements.get('nearby-clear').textContent, 'Не использовать моё местоположение');
});

test('successful GPS and later preference/progress saves do not transmit or persist coordinates, accuracy or time', () => {
  const h = harness();
  const initialFetchCount = h.fetches.length;
  const initialTimerCount = h.timers.length;
  h.run('requestNearby(false)');
  h.callbacks[0].success(h.position(12.345678, 98.765432, 345.678));
  assert.equal(h.snapshot().origin, 'device');
  assert.equal(h.details().capturedAt, syntheticTime);
  h.run('toggleRadiusFilter()');
  h.changeRadius(5000);
  h.run('writeStorage("boat"); saveProgress()');
  assert.equal(h.fetches.length, initialFetchCount);
  const stored = h.writes.map(([key, value]) => [key, JSON.parse(value)]);
  assert.equal(stored.length, 2);
  const persisted = JSON.stringify(stored);
  assert.doesNotMatch(persisted, /12\.345678|98\.765432|"lat"|"lng"|"accuracyM"|"capturedAt"|"geo"/);
  assert.doesNotMatch(persisted, /345\.678|1700000123456|"accuracy"|"timestamp"/);
  assert.doesNotMatch(JSON.stringify(h.fetches), /12\.345678|98\.765432|345\.678|1700000123456/);
  assert.deepEqual(h.urlWrites, []);
  assert.deepEqual(h.beacons, []);
  assert.deepEqual(h.logs, []);
  assert.deepEqual(h.watches, []);
  assert.equal(h.timers.length, initialTimerCount);
});

test('non-finite coordinates and invalid accuracy cannot become an origin', () => {
  for (const coords of [{ latitude: NaN, longitude: 10, accuracy: 1 }, { latitude: Infinity, longitude: 10, accuracy: 1 }, { latitude: 91, longitude: 10, accuracy: 1 }, { latitude: 10, longitude: 181, accuracy: 1 }, { latitude: 10, longitude: NaN, accuracy: 1 }, { latitude: 10, longitude: 20, accuracy: -1 }, { latitude: 10, longitude: 20, accuracy: NaN }, { latitude: 10, longitude: 20, accuracy: Infinity }, { latitude: 10, longitude: 20 }]) {
    const h = harness();
    h.run('requestNearby(false)');
    h.callbacks[0].success({ coords });
    assert.equal(h.snapshot().origin, null);
    assert.equal(h.snapshot().phase, 'unavailable');
    assert.equal(h.details().capturedAt, null);
    for (const id of ['nearby-request', 'nearby-refresh', 'nearby-manual']) assert.equal(h.elements.get(id).disabled, false);
    assert.match(h.status(), /вручную/);
    h.run('setManualOrigin({lat: 10, lng: 20})');
    assert.equal(h.snapshot().origin, 'manual');
  }
});
