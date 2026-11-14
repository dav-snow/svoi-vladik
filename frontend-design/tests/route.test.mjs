/** Synthetic DOM/storage only: no browser, network, map tiles or device GPS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const places = [
  { id: 'a', title: 'А', name: 'А', lat: 43.10, lng: 131.90, route_url: 'https://2gis.ru/directions/tab/pedestrian/points/|131.9,43.1' },
  { id: 'b', title: 'Б', name: 'Б', lat: 43.11, lng: 131.91, route_url: 'https://2gis.ru/directions/tab/pedestrian/points/|131.91,43.11' },
  { id: 'c', title: 'В', name: 'В', lat: 43.12, lng: 131.92, route_url: 'https://2gis.ru/directions/tab/pedestrian/points/|131.92,43.12' },
  { id: 'd', title: 'Г', name: 'Г', lat: 43.13, lng: 131.93, route_url: 'https://2gis.ru/directions/tab/pedestrian/points/|131.93,43.13' },
  { id: 'e', title: 'Д', name: 'Д', lat: 43.14, lng: 131.94, route_url: 'https://2gis.ru/directions/tab/pedestrian/points/|131.94,43.14' },
  { id: 'f', title: 'Е', name: 'Е', lat: 43.15, lng: 131.95, route_url: 'https://2gis.ru/directions/tab/pedestrian/points/|131.95,43.15' },
];

function harness(seed = {}) {
  const elements = new Map(), store = new Map(Object.entries(seed)), writes = [];
  const node = () => ({
    hidden: false, disabled: false, open: false, textContent: '', value: '', children: [],
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
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem(key, value) { store.set(key, String(value)); writes.push([key, String(value)]); },
  };
  const context = vm.createContext({
    document: { getElementById: element, createElement: node, importNode: value => value, querySelectorAll: () => [] },
    DOMParser: class { parseFromString() { return { documentElement: { setAttribute() {} } }; } },
    window: { isSecureContext: true, addEventListener() {} },
    navigator: { geolocation: { getCurrentPosition() {} } },
    localStorage,
    fetch: () => new Promise(() => {}),
    matchMedia: () => ({ matches: false }),
    setTimeout: () => 0, clearTimeout() {}, AbortSignal, URL, console,
    innerWidth: 1280, innerHeight: 800,
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  const run = expression => vm.runInContext(expression, context);
  const snap = expression => JSON.parse(run(`JSON.stringify(${expression})`));
  run(`state.places = ${JSON.stringify(places)}`);
  return { run, snap, elements, store, writes };
}

test('adds stops up to the limit of five and toggles the same place off', () => {
  const h = harness();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) h.run(`routeToggle(routePlace('${id}'))`);
  assert.deepEqual(h.snap('route.stops'), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(h.elements.get('route-count').textContent, '5');
  h.run("routeToggle(routePlace('c'))");
  assert.deepEqual(h.snap('route.stops'), ['a', 'b', 'd', 'e']);
  assert.equal(h.elements.get('route-count').textContent, '4');
});

test('move changes order and clear resets start and stops', () => {
  const h = harness();
  h.run("route.start={kind:'place', id:'a'}; route.stops=['b','c','d']");
  h.run("routeMove('d', -1)");
  assert.deepEqual(h.snap('route.stops'), ['b', 'd', 'c']);
  h.run("routeMove('b', -1)");
  assert.deepEqual(h.snap('route.stops'), ['b', 'd', 'c']);
  h.run('routeClear()');
  assert.deepEqual(h.snap('route.stops'), []);
  assert.equal(h.run('route.start'), null);
});

test('a place start gives both 2GIS points and a straight-line total', () => {
  const h = harness();
  h.run("route.start={kind:'place', id:'a'}; route.stops=['b','c']");
  const model = JSON.parse(h.run('JSON.stringify(routeModel())'));
  assert.equal(model.legs.length, 2);
  assert.equal(model.legs[0].url, 'https://2gis.ru/directions/tab/pedestrian/points/131.9,43.1|131.91,43.11');
  assert.equal(model.legs[1].url, 'https://2gis.ru/directions/tab/pedestrian/points/131.91,43.11|131.92,43.12');
  assert.ok(model.legs.every(leg => leg.distanceM > 0));
  const sum = model.legs.reduce((total, leg) => total + leg.distanceM, 0);
  assert.ok(Math.abs(model.totalM - sum) < 1e-6);
});

test('a device start uses the ready route_url for the first leg', () => {
  const h = harness();
  h.run("geo.origin='device'; geo.lat=43.105; geo.lng=131.905; route.start={kind:'device'}; route.stops=['a','b']");
  const model = JSON.parse(h.run('JSON.stringify(routeModel())'));
  assert.equal(model.legs[0].url, places[0].route_url);
  assert.equal(model.legs[1].url, 'https://2gis.ru/directions/tab/pedestrian/points/131.9,43.1|131.91,43.11');
  assert.ok(model.legs[0].distanceM > 0);
});

test('a device start without a position yields no first link or distance', () => {
  const h = harness();
  h.run("route.start={kind:'device'}; route.stops=['a','b']");
  const model = JSON.parse(h.run('JSON.stringify(routeModel())'));
  assert.equal(model.start, null);
  assert.equal(model.legs[0].distanceM, null);
  assert.equal(model.legs[0].url, null);
  assert.ok(model.legs[1].distanceM > 0);
});

test('a manual start builds legs from the entered coordinates', () => {
  const h = harness();
  h.run("route.start={kind:'manual', lat:43.1, lng:131.9}; route.stops=['b']");
  const model = JSON.parse(h.run('JSON.stringify(routeModel())'));
  assert.equal(model.legs[0].url, 'https://2gis.ru/directions/tab/pedestrian/points/131.9,43.1|131.91,43.11');
  assert.ok(model.legs[0].distanceM > 0);
  assert.equal(model.start.kind, 'manual');
});

test('persistence keeps ids and start kind but never coordinates', () => {
  const h = harness();
  h.run("route.start={kind:'manual', lat:43.1, lng:131.9}; route.stops=['a','b']; saveRoute()");
  const raw = h.store.get('svoi-vladik-route-v1');
  assert.deepEqual(JSON.parse(raw), { v: 1, start: null, stops: ['a', 'b'] });
  assert.doesNotMatch(raw, /lat|lng|43\.1|131\.9/);
  h.run("route.start={kind:'place', id:'b'}; saveRoute()");
  assert.deepEqual(JSON.parse(h.store.get('svoi-vladik-route-v1')), { v: 1, start: { kind: 'place', id: 'b' }, stops: ['a', 'b'] });
  h.run("route.start={kind:'device'}; saveRoute()");
  assert.deepEqual(JSON.parse(h.store.get('svoi-vladik-route-v1')).start, { kind: 'device' });
});

test('loading drops unknown ids, de-duplicates the start and caps the list', () => {
  const seeded = JSON.stringify({ v: 1, start: { kind: 'place', id: 'b' }, stops: ['a', 'zzz', 'b', 'c', 'd', 'e', 'f'] });
  const h = harness({ 'svoi-vladik-route-v1': seeded });
  h.run('readRoute()');
  assert.deepEqual(h.snap('route.stops'), ['a', 'c', 'd', 'e', 'f']);
  assert.deepEqual(h.snap('route.start'), { kind: 'place', id: 'b' });
});

test('a place chosen as start cannot also be a stop', () => {
  const h = harness();
  h.run("route.stops=['b']; route.start={kind:'place', id:'a'}");
  h.run("routeToggle(routePlace('a'))");
  assert.deepEqual(h.snap('route.stops'), ['b']);
});

test('the route panel renders for an empty and a filled route', () => {
  const h = harness();
  assert.ok(h.run('routeDialogContent().length') >= 3);
  h.run("route.start={kind:'place', id:'a'}; route.stops=['b','c']");
  const count = h.run('routeDialogContent().length');
  assert.ok(count >= 4);
});
