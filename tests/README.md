# HTTP-тесты JetBrains

`.http` файлы для встроенного HTTP Client в JetBrains IDE (WebStorm, IntelliJ, PyCharm, Rider) и в VS Code с расширением [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client).

## Раскладка

```
http-client.env.json          ← общие переменные окружения (хосты)
tests/scenarios.http          ← end-to-end сценарии через несколько сервисов
window/tests/window.http      ← @meta/window — порт 7878
screen/tests/screen.http      ← @meta/screen — порт 7879
chrome/tests/chrome.http      ← @meta/chrome — порт 7880
android/tests/android.http    ← @meta/android — порт 7881
input/tests/input.http        ← @meta/input — порт 7882
```

## Запуск

1. Запустить все сервисы: `bun run dev` (в корне монорепо)
2. В JetBrains IDE открыть любой `.http` файл
3. Выбрать environment `dev` (вверху справа) — переменные `{{windowHost}}` и т.д. подставятся автоматически
4. Нажать ▶ слева от запроса

## Переменные

Глобальные переменные сохраняются между запросами через response handler:

```http
GET {{chromeHost}}/windows

> {%
  client.global.set("windowId", response.body.windows[0].id)
%}

### Использование
GET {{chromeHost}}/tabs?windowId={{windowId}}
```

Это позволяет писать сценарии: один запрос получает `id`, следующий его использует.

## Тесты (assertions)

```http
GET {{windowHost}}/health

> {%
  client.test("ok=true", () => {
    client.assert(response.body.ok === true, "ok должен быть true")
  })
%}
```

Тесты появятся в Test Results после запуска.

## CLI

JetBrains HTTP Client можно запускать из терминала:

```bash
# Один файл
ijhttp window/tests/window.http --env dev

# Все
ijhttp **/tests/*.http --env dev
```

Установка: `brew install --cask ij-http-client` (или через JetBrains Toolbox).
