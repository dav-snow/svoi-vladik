/** Synthetic DOM and network only. Never requests a real position or account. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8');

function harness() {
  const elements = new Map(), requests = [], notices = [];
  const node = (tagName = 'div') => ({
    tagName,
    hidden: false, disabled: false, textContent: '', value: '', children: [], listeners: new Map(),
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, toggleAttribute() {}, addEventListener(type, fn) { this.listeners.set(type, fn); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }, querySelectorAll() { return []; },
  });
  const element = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  let respond = () => new Promise(() => {});
  const context = vm.createContext({
    document: { getElementById: element, createElement: node, querySelectorAll: () => [] },
    window: { isSecureContext: true, addEventListener() {} }, navigator: {},
    localStorage: { getItem: () => null, setItem() {} },
    fetch(url, options) { requests.push({ url, options }); return respond(url, options); },
    matchMedia: () => ({ matches: false }), setTimeout: () => 0, clearTimeout() {},
    AbortSignal, URL, console, innerWidth: 1280, innerHeight: 800,
    recordNotice: text => notices.push(text),
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  const run = expression => vm.runInContext(expression, context);
  // Test the session transition independently of unrelated map/modal rendering.
  run("notify = recordNotice; renderAuthButton = () => {}; closeDialog = async () => {}; refreshSocial = async () => {}; renderPlaces = () => {};");
  return { run, requests, notices, respond: handler => { respond = handler; } };
}

test('failed logout retains the session UI and personal marks, then allows retry', async () => {
  const h = harness();
  h.run("auth.user = {login:'demo'}; state.places = [{id:'p', visited_by_me:true, liked_by_me:true}]");
  h.respond(() => Promise.reject(new Error('offline')));
  await h.run('logoutUser()');
  assert.equal(h.run('auth.user.login'), 'demo');
  assert.equal(h.run('state.places[0].visited_by_me'), true);
  assert.equal(h.run('auth.loggingOut'), false);
  assert.match(h.notices.at(-1), /Не удалось подтвердить выход/);
  assert.ok(!h.notices.some(text => /^Вы вышли/.test(text)));

  h.respond(() => Promise.resolve({ ok: true, status: 204 }));
  await h.run('logoutUser()');
  assert.equal(h.run('auth.user'), null);
  assert.equal(h.run('state.places[0].visited_by_me'), false);
  assert.equal(h.run('state.places[0].liked_by_me'), false);
  assert.match(h.notices.at(-1), /^Вы вышли/);
});

test('server refusal does not masquerade as successful logout', async () => {
  const h = harness();
  h.run("auth.user = {login:'demo'}");
  h.respond(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
  await h.run('logoutUser()');
  assert.equal(h.run('auth.user.login'), 'demo');
  assert.match(h.notices.at(-1), /Не удалось подтвердить выход/);
});

test('concurrent logout clicks send one request until the server responds', async () => {
  const h = harness();
  h.run("auth.user = {login:'demo'}");
  let finish;
  h.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.run('logoutUser()');
  await h.run('logoutUser()');
  assert.equal(h.requests.filter(request => request.url === '/api/v1/auth/logout').length, 1);
  assert.equal(h.run('auth.user.login'), 'demo');
  finish({ ok: true, status: 204 });
  await pending;
  assert.equal(h.run('auth.user'), null);
});

test('manual coordinates reject blank input and accept zero and decimal comma', () => {
  const h = harness();
  h.run("guideCard = () => document.createElement('div'); openDialog = (id, content) => { globalThis.dialogContent = content; }; revealPlaces = () => {}; setManualPoint = (lat, lng) => { globalThis.appliedPoint = [lat, lng]; };");
  h.run('showManualOrigin()');
  const form = h.run("dialogContent.find(node => node.className === 'manual-coords')");
  const fields = form.children.filter(node => node.className === 'manual-coord').map(label => label.children[1]);
  const error = form.children.find(node => node.className === 'auth-error');
  const submit = () => form.listeners.get('submit')({ preventDefault() {} });
  fields[0].value = '  '; fields[1].value = '   ';
  submit();
  assert.equal(h.run('typeof appliedPoint'), 'undefined');
  assert.equal(error.hidden, false);
  fields[0].value = '0'; fields[1].value = '131,9';
  submit();
  assert.deepEqual(Array.from(h.run('appliedPoint')), [0, 131.9]);
});
