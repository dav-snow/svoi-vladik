# Передача состояния (WIP-снапшот)

Ветка-снапшот для продолжения работы. **В `main` не влито.** Здесь лежит код из
`origin/main` + коммит со скриптами деплоя + все ТЗ из `prompts/`.

## Что реализовано и проверено

- API `/api/v1`: `places`, `places/{id}`, `guides`, `walks`, `quest`,
  `quest/{id}/answer`, `quest/{id}/complete`, `test-empty`, `test-error`;
  `GET /health`. Плюс `/data/leninsky-*.geojson` из `data/geo/`.
- Данные (JSON, без БД): `data/places.json` (14 мест, все `draft`),
  `data/guides.json` (33), `data/walks.json` (4), `data/quests.json` (4).
- Фронт `frontend-design/dist/` подключён к API: `app.js` читает
  `/api/v1/places|walks|quest`, ответы квеста постит на сервер.
- Живой smoke на пересобранном образе: все ручки 200, ответ на квест `200 correct`.

## Что НЕ реализовано

- **База данных, вход, профиль, посещения, лайки, рейтинг** — только ТЗ:
  `task-012-db-visits-likes.md`, `task-013-front-auth-likes.md`. Кода нет.
- **Публичный HTTPS-стенд (011)** — есть `scripts/server-setup.sh`,
  `scripts/deploy-remote.sh`, `deploy.cmd`, но **нет** `docker-compose.prod.yml`,
  `Caddyfile`, `.env.example`, `docs/DEPLOY.md`. Деплой-скрипт на шаге 2 упадёт.
- **CI** — только шаблоны PR/issue, workflow нет.
- Все места в статусе `draft`; фильтра «только verified» в выдаче нет.

## Секреты и приватные данные

- `data/private/quest-answers.json` — серверные ключи ответов, **в git не идёт**
  (`.gitignore`). Передать отдельным закрытым каналом, иначе квесты дают 503.
- Репозиторий публичный. В `prompts/HANDOFF-deploy.md` есть реальные адрес и
  логин сервера — при необходимости заменить на плейсхолдеры.

## Тесты

`pytest` требует dev-зависимости (`backend/requirements-dev.txt`). Запуск
в одноразовом контейнере:

```sh
docker run --rm -v "$PWD":/src -w /src/backend python:3.11-slim \
  sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
```

По журналу ранее проходило 27 тестов (после квест-движка); текущий прогон в
оффлайне не подтверждён.

## С чего продолжать

1. Мерж `feat/deploy-scripts` (задача 011) → прод-файлы → стенд.
2. Задача 012 (SQLite: auth, visits, likes, profile, rating).
3. Задача 013 (фронт: вход/профиль/лайки) после мержа 012.
4. Задачи 007-010 из `prompts/` (прогресс прогулок, двухфазный квест, сценарий,
   гид-маскот) — смотреть по журналу `prompts/LOG.md` (частично устарел, сверять с кодом).
