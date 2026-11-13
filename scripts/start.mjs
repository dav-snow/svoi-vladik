import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 8000;
const APP_URL = `http://${HOST}:${PORT}/`;
const VENV_PYTHON = join(ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const ARGS = new Set(process.argv.slice(2));
const ALLOWED_ARGS = new Set(["--no-open", "--test", "--help"]);

function setupHint(test = false) {
  const python = process.platform === "win32" ? "py -3" : "python3";
  const local = process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";
  return [
    `Из корня проекта (${ROOT}) выполните:`,
    `  ${python} -m venv .venv`,
    `  ${local} -m pip install -r backend/requirements-dev.txt`,
    test ? "Затем: npm test" : "Затем: npm start",
    process.platform === "win32" ? "Если команды py нет, в первой строке используйте python вместо py -3. Активировать .venv не требуется." : "Активировать .venv не требуется."
  ].join("\n");
}

function checkPython(command, prefix, imports) {
  return spawnSync(command, [...prefix, "-c", `import ${imports.join(", ")}`], {
    cwd: ROOT, encoding: "utf8", timeout: 8000, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: "1" }
  });
}

function findPython(test = false) {
  const imports = test ? ["fastapi", "uvicorn", "pytest"] : ["fastapi", "uvicorn"];
  if (existsSync(VENV_PYTHON)) {
    const result = checkPython(VENV_PYTHON, [], imports);
    if (result.status === 0) return { command: VENV_PYTHON, prefix: [] };
    throw new Error(`Python в .venv не запускается или не хватает зависимостей (${imports.join(", ")}).\n${setupHint(test)}`);
  }
  if (test) throw new Error(`Для тестов нужно окружение .venv.\n${setupHint(true)}`);
  const candidates = process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
  for (const [command, prefix] of candidates) {
    if (checkPython(command, prefix, imports).status === 0) return { command, prefix };
  }
  throw new Error(`Не найден Python с установленными fastapi и uvicorn.\n${setupHint()}`);
}

function requestText(path, maxBytes = 262144) {
  return new Promise(resolveRequest => {
    const request = get({ hostname: HOST, port: PORT, path, agent: false, headers: { Connection: "close" } }, response => {
      if (response.statusCode !== 200) { response.resume(); resolveRequest(null); return; }
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(); resolveRequest(null); }
        else chunks.push(chunk);
      });
      response.on("end", () => resolveRequest(Buffer.concat(chunks).toString("utf8")));
      response.on("error", () => resolveRequest(null));
    });
    request.setTimeout(1500, () => { request.destroy(); resolveRequest(null); });
    request.on("error", () => resolveRequest(null));
  });
}

async function isOurServer() {
  const [health, html] = await Promise.all([requestText("/health", 8192), requestText("/")]);
  try {
    return JSON.parse(health)?.status === "ok" && typeof html === "string"
      && /<meta\s+name=["']application-name["']\s+content=["']svoi-vladik["']\s*\/?\s*>/i.test(html);
  } catch { return false; }
}

function portIsFree() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", error => error.code === "EADDRINUSE" ? resolvePort(false) : reject(error));
    server.listen(PORT, HOST, () => server.close(() => resolvePort(true)));
  });
}

function openBrowser() {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", APP_URL]]
    : process.platform === "darwin" ? ["open", [APP_URL]] : ["xdg-open", [APP_URL]];
  const helper = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  helper.on("error", () => console.log(`Откройте адрес вручную: ${APP_URL}`));
  helper.unref();
}

async function runTests() {
  const python = findPython(true);
  const child = spawn(python.command, [...python.prefix, "-m", "pytest", join(ROOT, "backend/tests")], {
    cwd: ROOT, stdio: "inherit", windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" }
  });
  process.exitCode = await new Promise(resolveCode => {
    child.once("error", error => { console.error(`Не удалось запустить тесты: ${error.message}`); resolveCode(1); });
    child.once("close", code => resolveCode(code ?? 1));
  });
  if (process.exitCode === 0) {
    const frontend = spawn(process.execPath, ['--test', join(ROOT, 'frontend-design/tests/geolocation.test.mjs')], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    process.exitCode = await new Promise(resolveCode => { frontend.once('error', () => resolveCode(1)); frontend.once('close', code => resolveCode(code ?? 1)); });
  }
}

async function startServer() {
  if (await isOurServer()) {
    console.log(`Свой Владик уже работает: ${APP_URL}`);
    console.log("Используем существующий сервер. Этот запуск не будет его останавливать.");
    if (!ARGS.has("--no-open")) openBrowser();
    return;
  }
  if (!await portIsFree()) throw new Error(`Порт ${PORT} занят другим приложением или сервер не прошёл проверку.\nНичего не остановлено. Освободите порт самостоятельно либо используйте уже запущенное приложение.`);
  const python = findPython();
  console.log("Запускаем Свой Владик…");
  const child = spawn(python.command, [...python.prefix, "-m", "uvicorn", "backend.main:app", "--host", HOST, "--port", String(PORT), "--no-access-log"], {
    cwd: ROOT, stdio: "inherit", windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" }
  });
  let stopped = false, exited = false, interrupted = false, spawnError = null;
  const closed = new Promise(resolveCode => {
    child.once("error", error => { spawnError = error; });
    child.once("close", code => { exited = true; resolveCode(code); });
  });
  const stop = () => {
    if (stopped || exited) return;
    stopped = true;
    console.log("\nОстанавливаем запущенный этим процессом сервер…");
    child.kill("SIGTERM");
    const fallback = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
    fallback.unref();
  };
  const onSignal = () => { interrupted = true; stop(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let ready = false;
  try {
    const deadline = Date.now() + 25000;
    while (!exited && !stopped && Date.now() < deadline) {
      if (await isOurServer() && !exited && !stopped) { ready = true; break; }
      await delay(250);
    }
    if (!ready) {
      stop();
      await closed;
      if (interrupted) return;
      throw new Error(spawnError ? `Не удалось запустить Python: ${spawnError.message}` : "Сервер не прошёл проверку /health и HTML-маркера. Проверьте ошибки выше и наличие файлов интерфейса.");
    }
    console.log(`\nГотово: ${APP_URL}\nСервер работает до Ctrl+C. Окно запуска оставьте открытым.\n`);
    if (!ARGS.has("--no-open")) openBrowser();
    const code = await closed;
    if (!stopped && code !== 0) throw new Error(`Сервер завершился с кодом ${code ?? "неизвестно"}.`);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

try {
  const unknown = [...ARGS].filter(arg => !ALLOWED_ARGS.has(arg));
  if (unknown.length) throw new Error(`Неизвестные параметры: ${unknown.join(", ")}`);
  if (ARGS.has("--help")) console.log("Свой Владик\n  npm start                 Запустить сервер и открыть браузер\n  npm start -- --no-open     Запустить без открытия браузера\n  npm test                  Запустить backend/tests в .venv");
  else if (ARGS.has("--test")) await runTests();
  else await startServer();
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}
