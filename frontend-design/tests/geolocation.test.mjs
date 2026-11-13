/** Synthetic navigator only: no device permission, location, browser or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

function harness() {
  const elements = new Map(), callbacks = [], fetches = [], writes = [];
  const node = () => ({
    hidden: false, disabled: false, textContent: '', value: '', children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, toggleAttribute() {}, addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, createElement: node, querySelectorAll: () => [] },
    window: { isSecureContext: true, addEventListener() {} },
    navigator: { geolocation: { getCurrentPosition(success, error, options) { callbacks.push({ success, error, options }); } } },
    localStorage: { getItem: () => null, setItem(key, value) { writes.push([key, value]); } },
    // Boot reads remain pending: this isolates GPS behavior from map/render loading.
    fetch(url, options) { fetches.push({ url, options }); return new Promise(() => {}); },
    matchMedia: () => ({ matches: false }),
    setTimeout: () => 0, clearTimeout() {}, AbortSignal, URL, console,
    innerWidth: 1280, innerHeight: 800,
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  const run = expression => vm.runInContext(expression, context);
  const snapshot = () => JSON.parse(run('JSON.stringify({origin:geo.origin, lat:geo.lat, lng:geo.lng, phase:geo.phase, accuracyM:geo.accuracyM})'));
  const position = (latitude = 12.345678, longitude = 98.765432) => ({ coords: { latitude, longitude, accuracy: 15 } });
  const fail = code => ({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  return { run, snapshot, callbacks, fetches, writes, elements, position, fail };
}

test('no location request occurs on application load or insecure context', () => {
  const h = harness();
  assert.equal(h.callbacks.length, 0);
  h.run('window.isSecureContext = false; requestNearby(false)');
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.snapshot().origin, null);
  assert.equal(h.snapshot().phase, 'unavailable');
});

for (const [code, expected] of [[1, 'denied'], [3, 'timeout']]) {
  test(`GPS ${expected} leaves no origin and enables another attempt`, () => {
    const h = harness();
    h.run('requestNearby(false)');
    assert.equal(h.elements.get('nearby-request').disabled, true);
    h.callbacks[0].error(h.fail(code));
    assert.equal(h.snapshot().phase, expected);
    assert.equal(h.snapshot().origin, null);
    assert.equal(h.snapshot().lat, null);
    assert.equal(h.elements.get('nearby-request').disabled, false);
    assert.match(h.elements.get('nearby-status').textContent, /вручную/);
  });
}

test('clear invalidates both late success and error callbacks', () => {
  const h = harness();
  h.run('requestNearby(false); clearNearby()');
  h.callbacks[0].success(h.position());
  h.callbacks[0].error(h.fail(1));
  assert.deepEqual(h.snapshot(), { origin: null, lat: null, lng: null, phase: 'idle', accuracyM: null });
});

test('manual origin wins against an earlier in-flight device lookup', () => {
  const h = harness();
  h.run('requestNearby(false); setManualOrigin({lat: 10, lng: 20})');
  h.callbacks[0].success(h.position());
  h.callbacks[0].error(h.fail(3));
  assert.deepEqual(h.snapshot(), { origin: 'manual', lat: 10, lng: 20, phase: 'ready', accuracyM: null });
});

test('latest lookup wins and refresh requests bypass the position cache', () => {
  const h = harness();
  h.run('requestNearby(false); requestNearby(true)');
  assert.equal(h.callbacks[0].options.maximumAge, 60000);
  assert.equal(h.callbacks[1].options.maximumAge, 0);
  assert.equal(h.callbacks[1].options.timeout, 10000);
  h.callbacks[1].success(h.position(11, 22));
  h.callbacks[0].success(h.position(33, 44));
  assert.equal(h.snapshot().lat, 11);
  assert.equal(h.snapshot().lng, 22);
});

test('successful GPS and later preference/progress saves do not transmit or persist coordinates', () => {
  const h = harness();
  const initialFetchCount = h.fetches.length;
  h.run('requestNearby(false)');
  h.callbacks[0].success(h.position());
  assert.equal(h.snapshot().origin, 'device');
  h.run('writeStorage("boat"); saveProgress()');
  assert.equal(h.fetches.length, initialFetchCount);
  const stored = h.writes.map(([key, value]) => [key, JSON.parse(value)]);
  assert.equal(stored.length, 2);
  const persisted = JSON.stringify(stored);
  assert.doesNotMatch(persisted, /12\.345678|98\.765432|"lat"|"lng"|"accuracyM"|"capturedAt"|"geo"/);
  assert.doesNotMatch(JSON.stringify(h.fetches), /12\.345678|98\.765432/);
});

test('non-finite coordinates and invalid accuracy cannot become an origin', () => {
  for (const coords of [{ latitude: NaN, longitude: 10, accuracy: 1 }, { latitude: 91, longitude: 10, accuracy: 1 }, { latitude: 10, longitude: 181, accuracy: 1 }, { latitude: 10, longitude: 20, accuracy: -1 }]) {
    const h = harness();
    h.run('requestNearby(false)');
    h.callbacks[0].success({ coords });
    assert.equal(h.snapshot().origin, null);
    assert.equal(h.snapshot().phase, 'unavailable');
  }
});
