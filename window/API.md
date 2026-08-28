# @meta/window — REST API

REST-сервис для управления окнами macOS. Структурирован под голосовое
управление: каждый эндпоинт сопоставлен с речевыми интентами, а имена
приложений и пресеты нормализованы.

- Base URL: `http://localhost:7878` (override: `WINDOW_API`)
- Формат: JSON in / JSON out
- Координаты: логические пиксели, origin `(0,0)` — top-left главного дисплея
- Авторизация: нет (только loopback)

---

## 1. Карта голосовых интентов

| Голосовая фраза (RU)                          | Метод | Эндпоинт   | Body / Query                             |
|-----------------------------------------------|-------|------------|------------------------------------------|
| «открой / переключись на / покажи <app>»      | POST  | `/focus`   | `{ app }`                                |
| «какие окна открыты»                          | GET   | `/windows` | —                                        |
| «какие окна у <app>»                          | GET   | `/windows` | `?app=<app>`                             |
| «размер экрана / разрешение»                  | GET   | `/screen`  | —                                        |
| «передвинь <app> в (X, Y)»                    | POST  | `/move`    | `{ app, x, y }`                          |
| «сделай <app> размером WxH»                   | POST  | `/resize`  | `{ app, width, height }`                 |
| «поставь <app> налево / направо / вверх / вниз» | POST | `/arrange` | `{ app, preset: "left"…"bottom" }`       |
| «разверни <app> на весь экран»                | POST  | `/arrange` | `{ app, preset: "max" }`                 |
| «отцентруй <app>»                             | POST  | `/arrange` | `{ app, preset: "center" }`              |
| «подними <app> наверх (один раз)»             | POST  | `/raise`   | `{ app, index? }`                        |
| «закрепи <app> поверх / держи всегда сверху» | POST  | `/pin`     | `{ app, index?, intervalMs? }`           |
| «отлепи / убери закрепление»                  | DEL   | `/pin/:id` | (или `DEL /pin` для всех)                |
| «что закреплено»                              | GET   | `/pin`     | —                                        |
| «сервер жив / проверь API»                    | GET   | `/health`  | —                                        |

Если в команде упомянут номер окна («второе окно Safari»), добавляется
`index: <n>` (1-based, 1 — фронтальное окно).

---

## 2. Нормализация имён приложений

Имя `app` совпадает с именем процесса в `System Events` (как видно в
Activity Monitor). Голосовой слой должен подставлять каноническое имя.

| Голос                          | Каноническое `app`         |
|--------------------------------|----------------------------|
| хром, гугл хром, chrome        | `Google Chrome`            |
| сафари, safari                 | `Safari`                   |
| итерм, терминал в айтерме      | `iTerm2`                   |
| терминал                       | `Terminal`                 |
| код, vs code, visual studio    | `Code`                     |
| курсор                         | `Cursor`                   |
| файндер, finder, проводник     | `Finder`                   |
| слак                           | `Slack`                    |
| телеграм                       | `Telegram`                 |
| заметки                        | `Notes`                    |
| почта, mail                    | `Mail`                     |

Сравнение в API регистронезависимо для query `?app=`, но в body **`app`
должен совпадать точно** (тогда AppleScript находит процесс).

---

## 3. Пресеты раскладки (`/arrange`)

| Preset    | Что делает                                                |
|-----------|-----------------------------------------------------------|
| `left`    | левая половина экрана                                     |
| `right`   | правая половина экрана                                    |
| `top`     | верхняя половина экрана                                   |
| `bottom`  | нижняя половина экрана                                    |
| `max`     | на весь экран                                             |
| `center`  | по центру, ½ ширины × ¾ высоты                            |

Размеры считаются от `GET /screen` на момент вызова.

---

## 4. Эндпоинты

### 4.1 `GET /health`

Проверка живости.

- Параметры: нет
- Ответ: `{ "ok": true, "service": "@meta/window", "backend": "meta-input-helper", "accessibility": { "granted": true } }`

```bash
curl -s http://localhost:7878/health
```

Голос: «сервер жив», «проверь API».

---

### 4.2 `GET /screen`

Размер главного дисплея в логических пикселях.

- Параметры: нет
- Ответ: `{ "width": number, "height": number }`

```bash
curl -s http://localhost:7878/screen
# {"width":1920,"height":1200}
```

Голос: «размер экрана», «какое разрешение».

---

### 4.3 `GET /windows`

Список всех видимых окон фоновых приложений.

- Query:
  - `app` *(опц.)* — фильтр по имени приложения, регистронезависимо
- Ответ:
  ```json
  {
    "count": 2,
    "windows": [
      {
        "app": "Safari",
        "pid": 1234,
        "index": 1,
        "title": "Apple",
        "x": 0, "y": 25, "width": 1440, "height": 900
      }
    ]
  }
  ```

```bash
curl -s "http://localhost:7878/windows?app=Safari" | jq '.windows[].title'
```

Голос: «какие окна открыты», «покажи окна Safari».

> Использует подписанный `input/bin/meta-input-helper`. Без его Accessibility
> endpoint закрывается с ошибкой: неполный список больше не возвращается как
> успех. `pid` является частью identity и нужен для точного выбора между
> одноимёнными процессами, например обычным и CDP Chrome.

---

### 4.4 `POST /focus`

Активация уже видимого точного окна через native helper.

- Body: `{ "app": string, "pid"?: number, "index"?: number, "title"?: string }`
- Ответ: `{ "ok": true, "target": {...}, "frontmost": {...}, "previous": {...} }`
- Ошибки: `400 missing 'app'`, `404` если видимого окна нет, `409` при неоднозначном target или неуспешной проверке фокуса

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Safari"}' http://localhost:7878/focus
```

Голос: «открой Safari», «переключись на хром».

---

### 4.5 `POST /move`

Переместить окно в абсолютные координаты.

- Body:
  ```json
  { "app": "Safari", "x": 200, "y": 120, "index": 1 }
  ```
  - `app` — обязательно
  - `x`, `y` — обязательно, целые
  - `index` — опц., default `1`
- Ответ: `{ "ok": true }`
- Ошибки: `400` если нет `app/x/y`

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Safari","x":200,"y":120}' http://localhost:7878/move
```

Голос: «передвинь Safari в 200 120».

---

### 4.6 `POST /resize`

Изменить размер окна.

- Body:
  ```json
  { "app": "Safari", "width": 1400, "height": 900, "index": 1 }
  ```
- Ответ: `{ "ok": true }`
- Ошибки: `400` если нет `app/width/height`

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Safari","width":1400,"height":900}' http://localhost:7878/resize
```

Голос: «сделай Safari 1400 на 900».

---

### 4.7 `POST /arrange`

Применить именованную раскладку. Делает `move + resize` под капотом.

- Body:
  ```json
  { "app": "iTerm2", "preset": "left", "index": 1 }
  ```
  - `preset`: `left | right | top | bottom | max | center`
- Ответ:
  ```json
  { "ok": true, "applied": { "x": 0, "y": 0, "width": 960, "height": 1200 } }
  ```
- Ошибки: `400` если нет `app/preset` или `preset` неизвестен

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"iTerm2","preset":"left"}' http://localhost:7878/arrange
```

Голос: «iTerm налево», «разверни хром на весь экран», «отцентруй заметки».

---

### 4.8 `POST /raise`

Поднять окно на самый верх **без активации приложения** (фокус не уезжает).
Использует Accessibility-action `AXRaise`. Одноразово.

- Body: `{ "app": string, "index"?: number }`
- Ответ: `{ "ok": true }`

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"iTerm2"}' http://localhost:7878/raise
```

Голос: «подними iTerm наверх», «покажи терминал поверх».

---

### 4.9 `POST /pin` — soft "always on top"

Запускает фоновый цикл, который вызывает `AXRaise` для окна каждые
`intervalMs` миллисекунд. Это **имитация** «всегда поверх» — настоящего
системного `NSWindow.windowLevel` через osascript выставить нельзя.

- Body:
  ```json
  { "app": "iTerm2", "index": 1, "intervalMs": 500 }
  ```
  - `intervalMs` — опц., default `500`, min `100`. Чем меньше, тем
    «жёстче» pin, но больше нагрузка от вызовов osascript.
- Ответ:
  ```json
  {
    "ok": true,
    "pin": { "id": "1", "app": "iTerm2", "index": 1, "intervalMs": 500,
             "startedAt": 1777..., "raises": 0, "errors": 0 }
  }
  ```

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"iTerm2","intervalMs":600}' http://localhost:7878/pin
```

Голос: «закрепи iTerm поверх», «держи терминал всегда сверху».

#### Особенности и ограничения
- **Без отнятия фокуса** — `AXRaise` поднимает окно, но НЕ активирует
  приложение, так что ввод продолжается там, где курсор был
- **Ложные срабатывания** — некоторые приложения не реализуют `AXRaise`
  (тогда `errors` будет расти, а окно остаётся внизу)
- **Полноэкранный режим** другого приложения перекроет всё равно
- **Не настоящее topmost** — для этого нужен SIP-disabled + yabai
  (`yabai -m window --toggle topmost`)
- **Pin живёт до перезапуска сервера** — все pin сбрасываются на старте

#### Запросы

| Метод | Путь        | Body            | Что делает                  |
|-------|-------------|-----------------|-----------------------------|
| POST  | `/pin`      | `{ app, … }`    | начать pin, вернуть `id`    |
| GET   | `/pin`      | —               | список активных pin         |
| DELETE| `/pin/:id`  | —               | снять конкретный pin        |
| DELETE| `/pin`      | —               | снять все pin               |

```bash
# список
curl -s http://localhost:7878/pin
# снять id=1
curl -s -X DELETE http://localhost:7878/pin/1
# снять все
curl -s -X DELETE http://localhost:7878/pin
```

Голос: «что закреплено» / «отлепи iTerm» / «убери все закрепления».

---

## 5. Модель ошибок

Все ошибки — JSON: `{ "error": string }`.

| Код | Когда                                                              |
|-----|--------------------------------------------------------------------|
| 400 | Не хватает обязательного поля или невалидное значение              |
| 404 | Метод/путь не найден                                               |
| 500 | Сбой внутри `osascript` (часто — нет Accessibility-разрешения)     |

Признаки missing-Accessibility (нужно сообщить пользователю и **не
ретраить**):
- Текст содержит `osascript failed (1)` и/или `-25211`
- `/windows` возвращает `count: 0` при запущенных приложениях

---

## 6. Голосовой парсинг — рекомендации

1. **Глагол → эндпоинт** (фиксированный мап):
   - открой/переключись/покажи → `/focus`
   - двигай/передвинь/перемести → `/move`
   - сделай/измени размер/растяни → `/resize`
   - поставь/раздели/налево/направо/вверх/вниз/максимум/центр → `/arrange`
   - какие/список/покажи окна → `/windows`

2. **Объект → `app`**: прогонять через таблицу нормализации (раздел 2).
   Если совпадения нет — спросить уточнение, не отправлять fuzzy-имя.

3. **Числа**: «двести на сто двадцать» → `x:200, y:120`.
   Распознаватель должен возвращать целые; сервер не делает округления.

4. **Стороны**: «слева/справа/сверху/снизу» → preset, не координаты,
   если пользователь не назвал размеры явно.

5. **Подтверждение действия**: после `/move`, `/resize`, `/arrange`
   зачитывать поле `applied` (если есть) или сообщать `ok`.

6. **Перед любой операцией с окнами** (кроме `/focus`):
   - при первой команде сессии — `GET /health`, при ошибке —
     попросить пользователя запустить сервер.
   - при `count: 0` от `/windows` — попросить выдать Accessibility.

---

## 7. Быстрые примеры цепочек

**«Открой Safari и поставь его налево»**
```bash
curl -s -X POST -H 'content-type: application/json' -d '{"app":"Safari"}' \
  http://localhost:7878/focus
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Safari","preset":"left"}' http://localhost:7878/arrange
```

**«iTerm налево, Cursor направо»**
```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"iTerm2","preset":"left"}'  http://localhost:7878/arrange
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Cursor","preset":"right"}' http://localhost:7878/arrange
```

**«Покажи второе окно Chrome по центру»**
```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"app":"Google Chrome","preset":"center","index":2}' \
  http://localhost:7878/arrange
```
