/** Synthetic DOM/storage only: no browser, network, map tiles or device GPS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

function harness(seed = {}) {
  const elements = new Map(), store = new Map(Object.entries(seed));
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
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem(key, value) { store.set(key, String(value)); },
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
  return { run, snap, store, elements };
}

const finished = {
  run: `progress.quests = {
    q1: { visited: [], answers: {}, completed: true },
    q2: { visited: [], answers: {}, completed: true },
    q3: { visited: [], answers: {}, completed: false }
  }`,
};

test('there are six avatars: three free and three quest rewards', () => {
  const h = harness();
  assert.equal(h.run('AVATARS.length'), 6);
  assert.deepEqual(h.snap('AVATARS.map(a => a.need)'), [0, 0, 0, 1, 2, 3]);
});

test('nothing is unlocked or selected without progress', () => {
  const h = harness();
  h.run('auth.user = { id: 7, login: "tester" }; avatarRead()');
  assert.equal(h.run('avatarState.unlocked'), 0);
  assert.equal(h.run('avatarState.selected'), null);
});

test('unlock level follows unique completed quests and never regresses', () => {
  const h = harness();
  h.run(finished.run);
  h.run('auth.user = { id: 7, login: "tester" }; avatarRead()');
  assert.equal(h.run('avatarState.unlocked'), 2);
  h.run('progress.quests.q1.completed = false; progress.quests.q2.completed = false; avatarRead()');
  assert.equal(h.run('avatarState.unlocked'), 2);
});

test('granting unlocks returns the newly opened avatars and persists the level', () => {
  const h = harness();
  h.run('progress.quests = { q1: { visited: [], answers: {}, completed: true } }');
  h.run('auth.user = { id: 7, login: "tester" }; avatarRead(); avatarState.unlocked = 0; avatarState.selected = null');
  const rewards = h.snap('avatarGrantUnlocks().map(a => a.id)');
  assert.deepEqual(rewards, ['compass']);
  assert.equal(h.run('avatarState.unlocked'), 1);
  assert.deepEqual(JSON.parse(h.store.get('svoi-vladik-avatars-v1:user-7')).unlocked, 1);
});

test('a locked avatar cannot be selected, an unlocked one can', () => {
  const h = harness();
  h.run('auth.user = { id: 7, login: "tester" }; avatarRead()');
  assert.equal(h.run('avatarChoose("compass")'), false);
  assert.equal(h.run('avatarState.selected'), null);
  h.run('avatarState.unlocked = 1; avatarChoose("compass")');
  assert.equal(h.run('avatarState.selected'), 'compass');
  assert.equal(JSON.parse(h.store.get('svoi-vladik-avatars-v1:user-7')).selected, 'compass');
  assert.doesNotMatch(h.store.get('svoi-vladik-avatars-v1:user-7'), /lat|lng|coords/);
});

test('guest and signed-in selections are stored separately', () => {
  const h = harness();
  h.run('auth.user = null; avatarRead(); avatarChoose("sun")');
  assert.equal(JSON.parse(h.store.get('svoi-vladik-avatars-v1:guest')).selected, 'sun');
  h.run('auth.user = { id: 7, login: "tester" }; avatarRead()');
  assert.equal(h.run('avatarState.selected'), null);
  h.run('avatarChoose("boat")');
  assert.equal(JSON.parse(h.store.get('svoi-vladik-avatars-v1:user-7')).selected, 'boat');
  h.run('auth.user = null; avatarRead()');
  assert.equal(h.run('avatarState.selected'), 'sun');
});

test('avatar grid renders six tiles and locks the three quest rewards', () => {
  const h = harness();
  h.run('auth.user = { id: 7, login: "tester" }; avatarRead()');
  assert.equal(h.run('avatarSection().children[2].children.length'), 6);
  assert.equal(h.run('avatarSection().children[2].children.filter(tile => tile.disabled).length'), 3);
});
