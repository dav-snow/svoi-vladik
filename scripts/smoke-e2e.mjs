#!/usr/bin/env node
/**
 * Repeatable browser smoke test for the demo.
 *
 * Starts nothing: run `npm start` first (or point --base at the public stand).
 * Drives headless Edge/Chrome over CDP: desktop/mobile overflow, place gallery
 * licence link, avatar server sync across a local-state reset, and PWA basics.
 * Creates one demo account in the target database, so use a local server.
 *
 *   node scripts/smoke-e2e.mjs
 *   node scripts/smoke-e2e.mjs --base=http://127.0.0.1:8000 --edge="C:\...\msedge.exe"
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2)
  .filter(value => value.startsWith('--'))
  .map(value => { const [key, ...rest] = value.slice(2).split('='); return [key, rest.join('=')]; }));
const base = (args.base || 'http://127.0.0.1:8000').replace(/\/$/, '');
const port = Number(args.port || 9231);
const outDir = args.out || join(tmpdir(), 'svoi-vladik-smoke');
const edgeCandidates = [
  args.edge,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const edge = edgeCandidates.find(candidate => existsSync(candidate));
if (!edge) {
  console.error('Не найден Edge/Chrome. Укажите --edge=путь.');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'svoi-e2e-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const browser = spawn(edge, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,900', base,
], { stdio: 'ignore', windowsHide: true });

async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(item => item.type === 'page' && item.url.startsWith(base));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error('Не удалось подключиться к браузеру');
}

let ws;
let nextId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || 'JS error');
  return result.result?.result?.value;
}
async function waitFor(expression, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return true; } catch { /* page is reloading */ }
    await sleep(200);
  }
  return false;
}
async function screenshot(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const path = join(outDir, name);
  writeFileSync(path, Buffer.from(shot.result.data, 'base64'));
  return path;
}

try {
  ws = new WebSocket(await findTarget());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const slot = message.id ? pending.get(message.id) : null;
    if (!slot) return;
    pending.delete(message.id);
    if (message.error) slot.reject(new Error(message.error.message));
    else slot.resolve(message);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await waitFor("typeof state !== 'undefined' && Boolean(state.places?.length)");
  const catalog = await evaluate(`({ places: state.places.length, walks: state.walks.length, quests: state.quests.length })`);
  check('каталог загружен', catalog.places >= 10 && catalog.walks >= 1 && catalog.quests >= 1, JSON.stringify(catalog));

  const desktop = await evaluate(`({ width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, map: Boolean(document.getElementById('map')), sidebar: Boolean(document.querySelector('.sidebar')) })`);
  check('десктоп без горизонтального скролла', desktop.width >= 1280 && desktop.overflow <= 0, JSON.stringify(desktop));
  const desktopShot = await screenshot('desktop.png');

  const account = await evaluate(`(async () => {
    const login = 'smoke' + Math.floor(Math.random() * 1e7);
    const response = await fetch('/api/v1/auth/register', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: 'password123' }) });
    if (!response.ok) throw new Error('register ' + response.status);
    const me = await (await fetch('/api/v1/me', { credentials: 'same-origin' })).json();
    return { login, id: me.user.id };
  })()`);
  check('демо-аккаунт создан', Boolean(account?.id), account?.login);
  await send('Page.reload');
  await waitFor("typeof state !== 'undefined' && Boolean(state.places?.length)");

  const sync = await evaluate(`(async () => {
    const quest = state.quests[0];
    progress.quests[quest.id] = {
      visited: quest.stops.map(stop => stop.id),
      answers: Object.fromEntries(quest.stops.map(stop => [stop.id, stop.options[0].id])),
      completed: true
    };
    saveProgress();
    await avatarSyncLoad();
    const before = { unlocked: avatarState.unlocked, completed: avatarRemote.completed, ready: avatarRemote.ready };
    avatarChoose('compass');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const server = await (await fetch('/api/v1/me/avatars', { credentials: 'same-origin' })).json();
    return { before, selected: avatarState.selected, header: document.querySelector('#auth-open img')?.getAttribute('src'), server };
  })()`);
  check('локальные квесты импортированы на сервер', sync.before.ready && sync.before.unlocked >= 1, JSON.stringify(sync.before));
  check('выбор аватара сохранён на сервере', sync.server?.selected === 'compass' && /compass\.webp$/.test(sync.header || ''), JSON.stringify(sync.server));

  await evaluate(`(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('svoi-vladik-avatars-v1:') || key === 'svoi-vladik-progress-v1') localStorage.removeItem(key); })()`);
  await send('Page.reload');
  await waitFor("typeof state !== 'undefined' && Boolean(state.places?.length)");
  const restored = await evaluate(`({ selected: avatarState.selected, unlocked: avatarState.unlocked, header: document.querySelector('#auth-open img')?.getAttribute('src') })`);
  check('аватар восстановлен без локального кэша', restored.selected === 'compass' && /compass\.webp$/.test(restored.header || ''), JSON.stringify(restored));

  const gallery = await evaluate(`(async () => {
    const place = state.places.find(item => item.images?.length);
    showPlace(place);
    await new Promise(resolve => setTimeout(resolve, 800));
    const link = document.querySelector('#detail-content .place-gallery-license');
    return { place: place.id, text: link?.textContent?.trim(), href: link?.getAttribute('href'), source: document.querySelector('#detail-content .place-gallery-source')?.getAttribute('href') };
  })()`);
  check('ссылка на лицензию фото HTTPS', /^https:\/\//.test(gallery.href || '') && /Лицензия/.test(gallery.text || ''), JSON.stringify(gallery));
  const placeShot = await screenshot('place.png');
  await evaluate(`document.getElementById('detail-dialog').close()`);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const mobile = await evaluate(`({ width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth })`);
  check('телефон без горизонтального скролла', mobile.width === 390 && mobile.overflow <= 0, JSON.stringify(mobile));
  const mobileShot = await screenshot('mobile.png');

  const pwa = await evaluate(`(async () => {
    const manifest = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
    let registration = null;
    try { registration = await Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(() => resolve(null), 5000))]); } catch {}
    const keys = 'caches' in window ? await caches.keys() : [];
    return { manifest, controller: Boolean(navigator.serviceWorker?.controller), keys };
  })()`);
  check('манифест PWA подключён', Boolean(pwa.manifest), pwa.manifest);
  check('service worker активен и shell закэширован', pwa.controller && pwa.keys.some(key => key.startsWith('svoi-vladik-shell-')), JSON.stringify(pwa.keys));
  const appManifest = await send('Page.getAppManifest');
  check('браузер разбирает манифест без ошибок', !(appManifest.result?.errors?.length), JSON.stringify(appManifest.result?.errors || []));

  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await send('Page.reload');
  await waitFor("document.readyState === 'complete'", 12000);
  const offline = await evaluate(`({ title: document.title, shell: Boolean(document.getElementById('map')), text: document.body.innerText.slice(0, 120) })`);
  check('офлайн-оболочка открывается из service worker', offline.shell && /Свой Владик/.test(offline.title), JSON.stringify(offline));
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  console.log(JSON.stringify({ screenshots: [desktopShot, placeShot, mobileShot], account: account.login, outDir }, null, 2));
} catch (error) {
  check('сценарий без исключения', false, error.message);
} finally {
  try { await send('Browser.close'); } catch {}
  browser.kill();
  await sleep(600);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  ws?.close();
}
const failed = results.filter(item => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} проверок прошли`);
process.exit(failed.length ? 1 : 0);
