# Фотографии мест

Сюда складываются фото мест интереса. Каталог раздаётся сервером по `/media/...`
(read-only), поэтому пути в данных совпадают с URL.

## Куда класть файлы

```
data/media/places/<place_id>/1.jpg
data/media/places/<place_id>/2.webp
```

`<place_id>` — это `id` места из `data/places.json` (например `sukhanov-house`).

Лицензированный пакет готовых фото лежит в `assets/places/` и раздаётся по
`/assets/places/...`; он подключается к местам скриптом
`scripts/link_place_photos.py` (см. `assets/places/README.md`).

## Как сослаться из данных

В `data/places.json` у места добавьте массив `images` (порядок = порядок показа,
первое фото считается обложкой):

```json
{
  "id": "sukhanov-house",
  "image": "/media/places/sukhanov-house/1.jpg",
  "images": [
    {
      "url": "/media/places/sukhanov-house/1.jpg",
      "alt": "Фасад дома-музея",
      "caption": "Вход со стороны улицы Суханова",
      "source_url": "https://example.org/photo-source"
    },
    {
      "url": "/media/places/sukhanov-house/2.webp",
      "alt": "Экспозиция музея"
    }
  ]
}
```

Правила:

- `url` — либо путь `/media/...` (или `/assets/...`), либо публичный `https://`.
  Протокол-относительные (`//host`), `javascript:` и `..` запрещены — сервер их
  отклонит при загрузке данных.
- `alt` обязателен по смыслу (для доступности), `caption` и `source_url`
  необязательны.
- Если фото нет, `images` можно не указывать — поле по умолчанию `[]`.
- Не кладите сюда приватные/чужие фото без прав. Источник — в `source_url`.
- Форматы: jpg/webp, разумный размер (ориентир — до ~300 КБ на файл).
