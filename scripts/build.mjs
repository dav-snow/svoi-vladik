import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "frontend-design/dist");
const OUTPUT = "build-manifest.json";
const CHECK_ONLY = process.argv.slice(2).includes("--check-only");
const required = [
  "index.html", "app.js", "styles.css", "polish.css", "mascot.js", "mascot.css", "sw.js", "map-style.json", "manifest.webmanifest",
  "data/leninsky-boundary.geojson", "data/leninsky-poi-candidates.geojson",
  ...["lighthouse", "guide", "museum", "theatre", "funicular"].map(name => `assets/${name}.svg`),
  "assets/mascot/manifest.json",
  ...["location-unknown", "interesting-places", "talking", "directions", "surprised", "first-visit"].map(name => `assets/mascot/${name}.webp`)
];
const sourceJSON = ["data/places.json", "data/routes.json", "data/quests.json", "data/geo/leninsky-boundary.geojson", "data/geo/leninsky-poi-candidates.geojson"];
const answerKeys = new Set(["correctoptionid", "correctanswer", "answerkey", "answerkeys", "iscorrect", "correct", "privateanswers", "solution", "solutions"]);
const normalized = name => name.split(sep).join("/");

function fail(message) { throw new Error(message); }

async function nonempty(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) fail(`Пустой файл или не файл: ${relative(ROOT, file)}`);
  } catch (error) {
    if (error.code === "ENOENT") fail(`Не найден обязательный файл: ${relative(ROOT, file)}`);
    throw error;
  }
}

async function filesIn(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === OUTPUT || entry.name === OUTPUT + ".tmp") continue;
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Символическая ссылка в публичной папке: ${relative(DIST, full)}`);
    if (entry.isDirectory()) output.push(...await filesIn(full));
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

function checkNoAnswers(value, source, trail = "$") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normal = key.toLowerCase().replace(/[^a-z]/g, "");
    if (answerKeys.has(normal)) fail(`Приватный ключ ответа в публичных данных: ${source} (${trail}.${key}). Ключи должны быть только в data/private/quest-answers.json.`);
    checkNoAnswers(child, source, `${trail}.${key}`);
  }
}

async function parseJSON(file, publicData) {
  let parsed;
  try { parsed = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch { fail(`Некорректный JSON: ${relative(ROOT, file)}`); }
  if (publicData) checkNoAnswers(parsed, normalized(relative(ROOT, file)));
  return parsed;
}

function resolveReference(reference, from) {
  if (!reference || reference.startsWith("#") || /^(https?:|data:|mailto:|tel:|blob:|\/\/)/i.test(reference)) return null;
  const clean = decodeURIComponent(reference.split(/[?#]/)[0]);
  if (!clean) return null;
  const target = clean.startsWith("/") ? resolve(DIST, "." + clean) : resolve(dirname(from), clean);
  const rel = relative(DIST, target);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) fail(`Ссылка выходит за публичную папку: ${reference}`);
  return target;
}

async function checkReferences(file) {
  const source = await readFile(file, "utf8");
  const pattern = extname(file) === ".html" ? /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi : /url\(\s*["']?([^\s'"\)]+)["']?\s*\)/gi;
  for (const match of source.matchAll(pattern)) {
    const target = resolveReference(match[1], file);
    if (target) await nonempty(target);
  }
}

async function checkCityContent() {
  const read = async path => JSON.parse(await readFile(join(ROOT, path), 'utf8'));
  const places = (await read('data/places.json')).items;
  const routes = (await read('data/routes.json')).items;
  const quests = (await read('data/quests.json')).items;
  let keys = null;
  try { keys = (await read('data/private/quest-answers.json')).quests; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const boundary = await read('data/geo/leninsky-boundary.geojson');
  const inRing = (point, ring) => {
    let inside = false;
    for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const [xi,yi]=ring[i], [xj,yj]=ring[j], [x,y]=point;
      if ((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) inside=!inside;
    }
    return inside;
  };
  const inDistrict = point => boundary.features.some(feature => {
    const g = feature.geometry;
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    return polygons.some(p => inRing(point,p[0]) && !p.slice(1).some(r => inRing(point,r)));
  });
  const uniqueIds = (items, label) => {
    if (new Set(items.map(x=>x.id)).size!==items.length) fail('Повтор ID: '+label);
  };
  uniqueIds(places,'места'); uniqueIds(routes,'прогулки'); uniqueIds(quests,'квесты');
  const active = places.filter(p=>p.active);
  for (const p of active) {
    const c = p.coordinates;
    if (!p.district_verified || !Number.isFinite(c?.lat) || !Number.isFinite(c?.lng) || !inDistrict([c.lng,c.lat])) fail('Активное место не подтверждено в границе района: '+p.id);
  }
  const ids = new Set(active.map(p=>p.id)), questIds=new Set(quests.map(q=>q.id));
  for (const route of routes) {
    if (route.place_ids.length<3 || route.place_ids.length>5 || new Set(route.place_ids).size!==route.place_ids.length || route.place_ids.some(id=>!ids.has(id)) || route.quest_id&&!questIds.has(route.quest_id)) fail('Неверные связи прогулки: '+route.id);
  }
  for (const quest of quests) {
    if (quest.stop_count!==quest.stops.length || ![3,4,5].includes(quest.stops.length)) fail('Неверное число заданий: '+quest.id);
    uniqueIds(quest.stops,quest.id);
    for (const stop of quest.stops) {
      if (!ids.has(stop.place_id)) fail('Неактивная точка в квесте: '+quest.id);
      const answer = keys?.[quest.id]?.[stop.id];
      if (keys && (!answer || !stop.options.some(o=>o.id===answer.correct_option_id) || !answer.explanation)) fail('Нет корректного серверного ответа: '+quest.id+'/'+stop.id);
    }
  }
  console.log(`Контент: ${active.length} активных мест / ${places.length} кандидатов, ${routes.length} прогулки, ${quests.length} квеста. Связи и граница проверены.`);
  if (!keys) console.log('Серверные ответы не настроены. Для проверки квестов подготовьте приватную конфигурацию по data/private/README.md. Публичная сборка ответов не содержит.');
}

async function main() {
  const unknown = process.argv.slice(2).filter(arg => arg !== "--check-only");
  if (unknown.length) fail(`Неизвестные параметры сборки: ${unknown.join(", ")}`);
  await nonempty(join(ROOT, "backend/main.py"));
  await nonempty(join(ROOT, "backend/requirements.txt"));
  await nonempty(join(ROOT, "backend/requirements-dev.txt"));
  for (const file of required) await nonempty(join(DIST, file));
  for (const file of sourceJSON) {
    await nonempty(join(ROOT, file));
    await parseJSON(join(ROOT, file), !file.startsWith("data/private/"));
  }
  await checkCityContent();
  const files = (await filesIn(DIST)).sort();
  for (const file of files) {
    const rel = normalized(relative(DIST, file));
    if (rel.split("/").some(part => part.toLowerCase() === "private") || /quest[-_]answers/i.test(rel)) fail(`Приватный файл оказался в публичной папке: ${rel}`);
    await nonempty(file);
    if ([".json", ".geojson", ".webmanifest"].includes(extname(file))) await parseJSON(file, true);
    if ([".html", ".css"].includes(extname(file))) await checkReferences(file);
  }
  for (const script of ["app.js", "mascot.js", "sw.js"]) {
    const result = spawnSync(process.execPath, ["--check", join(DIST, script)], { cwd: ROOT, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) fail(`Ошибка синтаксиса ${script}:\n${result.stderr || result.error?.message || "Проверка не запустилась"}`);
  }
  const manifest = { project: "svoi-vladik", version: 1, generatedAt: new Date().toISOString(), files: [] };
  for (const file of files) {
    const bytes = await readFile(file);
    manifest.files.push({ path: normalized(relative(DIST, file)), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (CHECK_ONLY) {
    let existing;
    try { existing = JSON.parse(await readFile(join(DIST, OUTPUT), "utf8")); }
    catch { fail(`${OUTPUT} отсутствует или повреждён. Соберите манифест: node scripts/build.mjs`); }
    const actual = Array.isArray(existing?.files) ? existing.files : [];
    const actualByPath = new Map(actual.map(file => [file.path, file]));
    const changed = manifest.files
      .filter(file => { const current = actualByPath.get(file.path); return !current || current.bytes !== file.bytes || current.sha256 !== file.sha256; })
      .map(file => file.path);
    const extra = actual.filter(file => !manifest.files.some(item => item.path === file.path)).map(file => file.path);
    if (existing.project !== manifest.project || existing.version !== manifest.version || changed.length || extra.length) {
      const detail = [
        changed.length ? `изменились/добавлены: ${changed.join(", ")}` : "",
        extra.length ? `лишние: ${extra.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      fail(`${OUTPUT} устарел (${detail || "project/version"}). Пересоберите: node scripts/build.mjs`);
    }
  } else {
    await writeFile(join(DIST, OUTPUT + ".tmp"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await rename(join(DIST, OUTPUT + ".tmp"), join(DIST, OUTPUT));
  }
  console.log(`Проверка готова: ${files.length} публичных файлов, JSON и синтаксис app/mascot/sw корректны.`);
  console.log("Ключей ответов в публичных JSON нет; приватные ответы остаются на сервере.");
  console.log(CHECK_ONLY ? "Режим --check-only: файлы не изменены, манифест сверен с содержимым." : `Список размеров и SHA-256 записан: frontend-design/dist/${OUTPUT}`);
  console.log("Фронтенд статический, компиляция и ZIP не требуются. Для API запускайте npm start; тесты — npm test.");
}

main().catch(error => { console.error(`\nСборка остановлена: ${error.message}\n`); process.exitCode = 1; });
