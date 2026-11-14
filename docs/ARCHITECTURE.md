# Архитектура

Актуально на 14 ноября 2026 (`main` — `c1471f0`). Это описание реализованной
системы, а не исходный план на 36 часов. Состояние функций и ограничения —
[STATUS.md](STATUS.md).

## Общая схема

```text
Браузер
  MapLibre + buildless JS (frontend-design/dist)
      │  GET /api/v1/places, /walks, /quest, /guides
      │  POST /quest/{id}/answer|complete, /auth/*, /places/{id}/visit|like
      ▼
FastAPI (backend/main.py) ── JSON-каталоги data/*.json
      │                    └─ SQLite: users, sessions, visits, likes, onboarding
      ▼
Caddy (HTTPS) → uvicorn → статика фронтенда, /media, /assets/places, /data
```

Один origin и один контейнер: браузер не знает отдельного адреса API.
Публичный стенд — Caddy :443 → api:8000 внутри compose-сети.

## Репозиторий

```text
backend/main.py              FastAPI-приложение целиком (модели, БД, ручки)
backend/tests/               pytest + httpx TestClient
frontend-design/dist/        публичный клиент без сборщика
  app.js                     UI, состояние, карта, API, прогресс, аватары, маршрут
  motion.js                   анимации диалогов (SvoiMotion.open/close)
  mascot.js                   панель Влады
  styles.css, polish.css, glass.css, mascot.css, motion.css
  index.html                 каркас, диалоги, шапка, панель, карта
  map-style.json             стиль MapLibre
  sw.js, manifest.webmanifest
  assets/                    иконки, маскот, аватары
  data/                      geojson для карты (копия из data/geo)
  build-manifest.json        размеры и SHA-256 публичных файлов
frontend-design/tests/       node:test: геолокация, маршрут, аватары, онбординг, motion
data/                        каталоги и приватные ответы (private в .gitignore)
assets/                      фото-пак, аватары, маскот
scripts/start.mjs            локальный one-origin запуск + тесты
scripts/build.mjs            проверка контента и build-manifest
scripts/link_place_photos.py подключение фото из манифеста к places.json
scripts/import_data.py       валидация и импорт редакционных JSON
scripts/deploy-windows.ps1   деплой по SSH с Windows без WSL
scripts/backup-db.ps1        копия SQLite со стенда + ротация
Dockerfile / docker-compose.prod.yml / Caddyfile / deploy.cmd
```

## Клиент

Сборщика нет: браузер получает те же файлы, которые лежат в `dist/`. Это
сознательный выбор для скорости и простоты демо; `build.mjs` не компилирует, а
проверяет контент и считает хэши.

- **Карта.** MapLibre 4.7.1 с CDN, стиль `map-style.json`, граница района из
  `/data/leninsky-boundary.geojson`, маркеры мест и «Вы здесь». При сбое
  WebGL/тайлов показывается SVG-схема (`showFallback`).
- **Состояние.** Один модуль `app.js` с объектами `state`, `geo`, `route`,
  `avatarState`, `progress`, `vladaOb`, `auth`. Функции глобальные; отдельного
  стора/фреймворка нет.
- **Диалоги.** Нативные `<dialog>` + `SvoiMotion` для открытия/замены/закрытия;
  контент кладётся в `*-content`. Закрытие/`Escape`/backdrop обрабатываются
  приложением.
- **Геолокация.** `getCurrentPosition` с `enableHighAccuracy: true`,
  `timeout: 15000`, `maximumAge: 0`; позиция только в памяти, защита от
  устаревших ответов через `geo.reqId`. Расстояния — хаверсинус, сортировка по
  возрастанию, устойчивый тай-брейк по `id`.
- **Локальные данные.** `localStorage`:
  - `svoi-vladik-design-v1` — сохранённые места;
  - `svoi-vladik-progress-v1` — прогресс прогулок и квестов;
  - `svoi-vladik-vlada-onboarding-v1:<guest|user-id>` — шаг обучения;
  - `svoi-vladik-vlada-onboarding-seen-v1` — «знакомство уже видели»;
  - `svoi-vladik-avatars-v1:<guest|user-id>` — выбранный аватар и уровень
    разблокировки;
  - `svoi-vladik-route-v1` — id точек маршрута и вид старта (без координат).
- **API-клиент.** `getJSON`/`apiSend`/`postJSON` с `credentials: same-origin`;
  ошибки показываются текстом, без раскрытия деталей.
- **PWA.** `manifest.webmanifest` и `sw.js`; полноценный офлайн не обещан.

## Сервер

`backend/main.py` — один файл, чтобы демо можно было читать целиком.

- **Модели Pydantic:** `Place`, `PlaceImage`, `Guide`, `Route`, `Quest`,
  `QuestStop`, `OnboardingUpdate`, `Credentials` и др. Публичные модели
  отбрасывают лишние поля (`extra="ignore"`), поэтому приватные ключи ответов
  не попадают в выдачу.
- **Загрузка данных:** `load_places`/`load_guides`/`load_collection` читают JSON
  при запросе; при ошибке отдают пустую коллекцию, а не 500. В API попадают
  только `active` + `district_verified` + `draft|verified`.
- **SQLite:** `users`, `sessions`, `visits`, `likes`, `onboarding`;
  `PRAGMA user_version` для схемы. Путь — `DB_PATH` (по умолчанию
  `data/demo.sqlite3`), в проде — `/app/storage/demo.sqlite3` на named volume.
- **Аутентификация:** scrypt-хэш пароля, серверные сессии, HttpOnly-кука
  `sv_session` (SameSite=Lax, 7 дней), в базе только SHA-256 токена.
  `COOKIE_SECURE=1` в проде добавляет Secure.
- **Защита:** rate-limit на вход/регистрацию и POST-ручки, предел размера тела,
  security headers, `Permissions-Policy: geolocation=(self)`, безопасные
  сообщения об ошибках, статические монтирования только для публичных папок.
- **Статика:** `/assets/places` (фото-пак), `/media` (редакционные фото),
  `/data` (geojson), `/` (dist). `/data/private` не отдаётся.
- **Квесты:** ответ проверяется на сервере по
  `data/private/quest-answers.json`; при отсутствии файла — 503. Ответ
  `/complete` исторически содержит `reward` («Шапка исследователя»), но
  клиент его не показывает: предметные награды исключены из продукта.
- **Соцданные:** `visits`/`likes` считаются на лету и добавляются к `Place` как
  `visits`, `likes`, `visited_by_me`, `liked_by_me`.

## Данные и проверки

- `data/places.json` — 17 кандидатов; `routes.json` — 4 прогулки;
  `quests.json` — 4 квеста; `guides.json` — 33 карточки.
- `data/private/quest-answers.json` — серверные ключи, в Git не входит.
- `assets/places/manifest.json` — фото, авторы и лицензии;
  `scripts/link_place_photos.py` переносит их в `places.json` в виде
  `images[]` (`/assets/places/...`), `--check` сверяет данные.
- `scripts/build.mjs` проверяет: обязательные файлы, JSON, отсутствие ключей
  ответов в публичных данных, ссылки в HTML/CSS, синтаксис JS, связи
  мест/прогулок/квестов и принадлежность активных мест границе района.
- pytest покрывает модели, API, безопасность, БД, соцручки, онбординг, фото.
  node-тесты — геолокацию, маршрут, аватары, онбординг и motion.

## Запуск и деплой

- Локально: `scripts/start.mjs` проверяет занятость порта, поднимает uvicorn на
  `127.0.0.1:8000`, открывает браузер; `npm test` запускает pytest и node-тесты.
- Прод: `Dockerfile` (python:3.11-slim, копирует backend/data/dist/assets),
  `docker-compose.prod.yml` (api + caddy, named volumes), `Caddyfile` с
  доменом из `.env`, HTTPS через Let's Encrypt. Инструкция — [DEPLOY.md](DEPLOY.md).

## Осознанные ограничения и долг

- `app.js` и `backend/main.py` — крупные монолиты; для демо это удобно, для
  роста понадобится разбиение.
- Прогресс квестов, аватары и маршрут клиентские; кросс-девайс синхронизации нет.
- `reward` в API остался историческим полем и не используется UI.
- Нет e2e-тестов в реальном браузере и визуальных регрессий в CI.
- PWA не кеширует карту и не гарантирует офлайн.
- Публичный стенд обновляется ручным деплоем; автоматического CD нет.
