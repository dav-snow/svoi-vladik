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
GET /api/places
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
GET /api/places/{place_id}
```

Ответ `200 OK` — объект `Place` того же вида, что в `items[*]`.

Ответ `404 Not Found`:

```json
{ "error": { "code": "404", "message": "Место не найдено" } }
```

## 3. Маршруты (Routes)

```
GET /api/routes
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
GET /api/quest
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

- `GET /api/test-empty` → `200 OK`, тело `[]` — пустой массив для проверки
  состояния «ничего не найдено».
- `GET /api/test-error` → `404 Not Found` с телом ошибки в общем формате —
  проверка обработки ошибок на клиенте.

## 6. Статика

- `GET /` — текущий прототип (`prototypes/leninsky-map/`). Будет заменён
  новым фронтендом.
- `GET /data/...` — исходные JSON/GeoJSON-файлы из `data/` (включая
  `data/geo/leninsky-boundary.geojson` и `data/geo/leninsky-poi-candidates.geojson`).
- `GET /docs`, `GET /openapi.json` — Swagger UI и схема.

## 7. Общий формат ошибок

Любая ошибка возвращается в виде:

```json
{ "error": { "code": "404", "message": "Место не найдено" } }
```

| HTTP | `error.code` | Когда возникает |
|---|---|---|
| 404 | `"404"` | Ресурс не найден (например, неизвестный `place_id`). |
| 422 | `"422"` | Невалидные параметры запроса. |
| 500 | `"500"` | Внутренняя ошибка сервера. Детали скрыты, пишутся в лог. |

### Устойчивость к пустым и битым данным

Если исходный JSON с маршрутами/квестами отсутствует, пуст или сломан,
сервер **не** возвращает `500`. Ответ — пустая коллекция:

```json
{ "items": [], "total": 0 }
```

То же поведение применяется к `/api/places`, если исходный GeoJSON недоступен.
Фронтенд может всегда полагаться на форму `{items: [...], total: N}`.

## 8. Контракт на будущее

- Поля/типы не удаляются и не переименовываются без согласования с У1.
  Новые необязательные поля могут добавляться — клиент должен игнорировать
  неизвестные поля.
- Публичный ответ не содержит правильных ответов квеста, секретов и
  отладочных трасс.
- Актуальная схема всегда в `GET /openapi.json`.
