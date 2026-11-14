/** Synthetic DOM/storage only: no browser, network or auth session. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');
const seenKey = 'svoi-vladik-vlada-onboarding-seen-v1';
const guestKey = 'svoi-vladik-vlada-onboarding-v1:guest';

function harness(seed = {}) {
  const elements = new Map(), store = new Map(Object.entries(seed));
  const node = () => ({
    hidden: false, disabled: false, open: false, textContent: '', value: '', children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, toggleAttribute() {}, addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    remove() {}, querySelectorAll() { return []; },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem(key, value) { store.set(key, String(value)); },
  };
  const context = vm.createContext({
    document: {
      getElementById: element, createElement: node, importNode: value => value,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    },
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
  return { run, snap, store };
}

test('the tour is remembered as seen on this browser', () => {
  const h = harness();
  assert.equal(h.run('vladaObHasSeen()'), false);
  h.run('vladaObMarkSeen()');
  assert.equal(h.run('vladaObHasSeen()'), true);
  assert.equal(h.store.get(seenKey), '1');
});

test('a new account carries the guest tour state', () => {
  const h = harness({ [guestKey]: JSON.stringify({ status: 'completed', step: 'vlada_finish', interest: 'quest' }) });
  assert.deepEqual(h.snap('vladaObCarryFromGuest()'), { status: 'completed', step: 'vlada_finish', interest: 'quest' });
});

test('a guest who never finished is carried as completed, not restarted', () => {
  const h = harness({ [guestKey]: JSON.stringify({ status: 'pending', step: 'vlada_welcome', interest: null }) });
  assert.deepEqual(h.snap('vladaObCarryFromGuest()'), { status: 'completed', step: 'vlada_finish' });
});

test('a paused guest tour keeps its step and interest', () => {
  const h = harness({ [guestKey]: JSON.stringify({ status: 'in_progress', step: 'vlada_0_walks_choose_later', interest: 'walks' }) });
  assert.deepEqual(h.snap('vladaObCarryFromGuest()'), { status: 'in_progress', step: 'vlada_0_walks_choose_later', interest: 'walks' });
});

test('closing the tour counts as seen and prevents an automatic reopen', () => {
  const h = harness();
  h.run('vladaOb.active = true; vladaOb.data = { status: "in_progress", step: "vlada_welcome", interest: null }; vladaObPause()');
  assert.equal(h.run('vladaObHasSeen()'), true);
  h.run('vladaOb.ready = true; vladaOb.cityReady = true; vladaOb.autoShown = false; vladaOb.data = { status: "pending", step: "vlada_welcome", interest: null }; vladaObMaybeAuto()');
  assert.equal(h.run('vladaOb.active'), false);
});
