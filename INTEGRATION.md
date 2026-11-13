# API integration guide

Этот документ описывает публичные HTTP-эндпоинты бэкенда «Свой Владик» для демо
P0. Контракт стабильный: фронтенд (У1) может верстать интерфейс, опираясь только
на этот файл, без чтения `backend/main.py`.

- Базовый адрес локально: `http://localhost:8000`.
- Все ответы — `application/json; charset=utf-8`.
- Все ручки — метод `GET`, без аутентификации.
- Пустая коллекция не является ошибкой: сервер отвечает `200 OK` с
  `{ "items": [], "total": 0 }`.
- Swagger UI с интерактивной схемой: `GET /docs`. OpenAPI JSON: `GET /openapi.json`.

## 1. Health

```
GET /health
```

Ответ `200 OK`:

```json
{ "status": "ok" }
```

Секреты и окружение не раскрываются.

## 2. Места (Places)

```
GET /api/v1/places
```

Ответ `200 OK`:

```json
{
  "items": [
    {
      "id": "osm-node-676375880",
      "name": "Военно-исторический музей Тихоокеанского флота",
      "category": "culture",
      "coordinates": { "lat": 43.1144566, "lng": 131.9009151 },
      "status": "draft",
      "price_rub": null,
      "checked_at": null,
      "source_url": "https://www.openstreetmap.org/node/676375880",
      "verification_note": "OSM candidate; access, current status and prices not checked",
      "osm_tags": { "tourism": "museum" }
    }
  ],
  "total": 1
}
```

Поля `Place`:

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `id` | string | да | Стабильный ID (`[A-Za-z0-9_-]`, 1–64). |
| `name` | string | да | Отображаемое название. |
| `category` | string | да | Редакционная категория (`culture`, `other`, …). |
| `coordinates` | `{lat:number, lng:number}` | да | Диапазоны −90…90 / −180…180. |
| `status` | string | да | `draft` / `verified` / `needs_review` / `expired` / `archived` / `demo`. |
| `price_rub` | integer \| null | нет | Минимальная подтверждённая цена; `null` = неизвестно. |
| `checked_at` | string \| null | нет | ISO 8601 с часовым поясом. |
| `source_url` | string \| null | нет | Ссылка на источник (OSM). |
| `verification_note` | string \| null | нет | Редакторская пометка. |
| `osm_tags` | object | нет | Произвольные OSM-теги (может быть `{}`). |

### Карточка одного места

```
GET /api/v1/places/{place_id}
```

`place_id` должен соответствовать `^[A-Za-z0-9_-]{1,64}$`.

Ответ `200 OK` — объект `Place` того же вида, что в `items[*]`.

Ответ `404 Not Found` — неизвестный, но корректный по форме id:

```json
{ "error": { "code": "NOT_FOUND", "message": "Место не найдено" } }
```

Ответ `422 Unprocessable Entity` — id не по шаблону:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Неверный формат place_id" } }
```

## 3. Прогулки (Walks)

```
GET /api/v1/walks
```

Пока реальных данных от У3 нет, сервер отдаёт моковый маршрут из
`data/examples/route_mock.json`. Как только появится `data/routes.json`,
ручка начнёт отдавать его автоматически. Формат ответа не меняется.

Ответ `200 OK`:

```json
{
  "items": [
    {
      "id": "route-leninsky-culture-001",
      "title": "Культурная прогулка по Ленинскому району",
      "description": "Короткий маршрут по трём знаковым точкам центра Владивостока…",
      "place_ids": [
        "osm-node-676375880",
        "osm-way-26537156",
        "osm-way-133436813"
      ],
      "estimated_minutes": 90,
      "route_note": "Пешком по центру; на фуникулёр подъём платный.",
      "route_checked_at": null,
      "quest_id": "quest-leninsky-culture-001",
      "source_url": "https://www.openstreetmap.org/relation/1686637",
      "sources": [
        { "title": "OpenStreetMap: Ленинский район", "url": "https://www.openstreetmap.org/relation/1686637" }
      ],
      "checked_at": null,
      "status": "demo"
    }
  ],
  "total": 1
}
```

Поля `Route`:

| Поле | Тип | Обязательное |
|---|---|---|
| `id` | string | да |
| `title` | string | да |
| `description` | string | да |
| `place_ids` | string[] | да (3 уникальных, в порядке прохождения) |
| `estimated_minutes` | integer | да |
| `route_note` | string \| null | нет |
| `route_checked_at` | string \| null | нет |
| `quest_id` | string \| null | нет (ссылка на `Quest.id`) |
| `source_url` | string \| null | нет |
| `sources` | `{title,url}[]` | нет (по умолчанию `[]`) |
| `checked_at` | string \| null | нет |
| `status` | string | да |

## 4. Квест (Quest)

```
GET /api/v1/quest
```

Пока реальных данных нет — отдаётся моковый квест из
`data/examples/quest_mock.json`; появится `data/quests.json` — сервер
переключится автоматически.

Сокращённый пример ответа `200 OK`:

```json
{
  "items": [
    {
      "id": "quest-leninsky-culture-001",
      "title": "Три точки Ленинского: флот, театр и сопка",
      "description": "Небольшой квест на 3 остановки.",
      "estimated_minutes": 60,
      "related_place_ids": [
        "osm-node-676375880",
        "osm-way-26537156",
        "osm-way-133436813"
      ],
      "stop_count": 3,
      "source_url": "https://www.openstreetmap.org/relation/1686637",
      "sources": [
        { "title": "OpenStreetMap: Ленинский район", "url": "https://www.openstreetmap.org/relation/1686637" }
      ],
      "checked_at": null,
      "status": "demo",
      "stops": [
        {
          "id": "stop-1",
          "place_id": "osm-node-676375880",
          "title": "Военно-исторический музей ТОФ",
          "fact_text": "Музей посвящён истории Тихоокеанского флота России.",
          "fiction_text": "Легенда: по ночам слышны корабельные склянки.",
          "question": "Какому флоту посвящён музей?",
          "options": [
            { "id": "a", "text": "Тихоокеанскому" },
            { "id": "b", "text": "Балтийскому" },
            { "id": "c", "text": "Черноморскому" }
          ],
          "sources": [
            { "title": "OSM node 676375880", "url": "https://www.openstreetmap.org/node/676375880" }
          ],
          "checked_at": null
        }
      ]
    }
  ],
  "total": 1
}
```

Поля `Quest`:

| Поле | Тип | Обязательное |
|---|---|---|
| `id` | string | да |
| `title` | string | да |
| `description` | string | да |
| `estimated_minutes` | integer | да |
| `related_place_ids` | string[] | да |
| `stop_count` | integer | да |
| `source_url` | string \| null | нет |
| `sources` | `{title,url}[]` | нет |
| `checked_at` | string \| null | нет |
| `status` | string | да |
| `stops` | `QuestStop[]` | да |

Поля `QuestStop`:

| Поле | Тип |
|---|---|
| `id` | string |
| `place_id` | string (ссылка на `Place.id`) |
| `title` | string |
| `fact_text` | string (подтверждённый источниками факт) |
| `fiction_text` | string (явно маркированный художественный элемент) |
| `question` | string |
| `options` | `{id:string, text:string}[]` (правильный ответ в выдаче **не** передаётся) |
| `sources` | `{title,url}[]` |
| `checked_at` | string \| null |

## 5. Тестовые ручки для крайних случаев фронта

- `GET /api/v1/test-empty` → `200 OK`, тело `[]` — пустой массив для проверки
  состояния «ничего не найдено».
- `GET /api/v1/test-error` → `404 Not Found` с телом ошибки в общем формате —
  проверка обработки ошибок на клиенте.

## 6. Статика и один origin

Бэкенд и фронтенд живут по одному адресу (`http://localhost:8000`), CORS в
dev-режиме не требуется.

- `GET /` — новый дизайн-прототип (`frontend-design/dist/`), статический
  бандл без сборки; HTML-маркер `<title>Свой Владик — Ленинский район</title>`.
- `GET /data/...` — данные дизайн-фронта из `frontend-design/dist/data/`:
  граница района `data/leninsky-boundary.geojson` и точки-кандидаты
  `data/leninsky-poi-candidates.geojson`. Именно эти пути запрашивает `app.js`.
- `GET /docs`, `GET /openapi.json` — Swagger UI и схема. В OpenAPI присутствуют
  только `/api/v1/*` и `/health`; старый префикс `/api/*` не поддерживается.

Прежний прототип `prototypes/leninsky-map/` остаётся в репозитории как
историческая справка, но по `/` больше не отдаётся.

## 7. Общий формат ошибок

Любая ошибка возвращается в виде:

```json
{ "error": { "code": "NOT_FOUND", "message": "Место не найдено" } }
```

`code` — стабильный символьный идентификатор, клиент может переключаться по
нему. `message` — человекочитаемый русский текст, может меняться.

| HTTP | `error.code` | Когда возникает |
|---|---|---|
| 404 | `NOT_FOUND` | Неизвестный ресурс (например, `place_id`) или неизвестный путь, включая исчезнувшие старые ручки `/api/*`. |
| 405 | `METHOD_NOT_ALLOWED` | Существующий путь, но неподдерживаемый метод (например, `POST /api/v1/places`). |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | POST без корректного `application/json` (на будущие POST-ручки). |
| 422 | `VALIDATION_ERROR` | Параметр не прошёл валидацию (тип, формат, диапазон). |
| 500 | `INTERNAL_ERROR` | Непойманное исключение на сервере. Текст исключения и трассировка **не** попадают в ответ, только в логи. |

### Устойчивость к пустым и битым данным

Если исходный JSON с прогулками или квестом отсутствует, пуст или сломан,
сервер **не** возвращает `500`. Ответ — пустая коллекция:

```json
{ "items": [], "total": 0 }
```

То же поведение применяется к `/api/v1/places`, если исходный GeoJSON
недоступен. Фронтенд может всегда полагаться на форму `{items: [...], total: N}`.

## 8. Запуск и тесты

```sh
# Собрать и поднять контейнер (один origin на :8000).
docker compose up -d --build

# Прогнать автоматические тесты (не требуют сети):
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements-dev.txt
pytest backend/tests
```

Тесты покрывают контракт: форму ответа каждой ручки, валидацию `place_id`,
единый JSON-формат ошибок для 404/405/422, факт исчезновения старых `/api/*`,
отдачу HTML нового дизайна по `/` и статики по `/data/...`.

## 9. Контракт на будущее

- Поля/типы не удаляются и не переименовываются без согласования с У1.
  Новые необязательные поля могут добавляться — клиент должен игнорировать
  неизвестные поля.
- Публичный ответ не содержит правильных ответов квеста, секретов и
  отладочных трасс.
- Актуальная схема всегда в `GET /openapi.json`.
