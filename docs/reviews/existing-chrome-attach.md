# Подключение к существующей сессии Chrome

Автор: zavx0z. Этап: реализация через GitHub; проверка на Mac не выполнена.
База: `62b0135d796fe738587ce4a4650ecd09fb40c21a`.

Историческая запись первого этапа. После переноса изменяемой логики proxy профиль
находится в `runtime/src/agent-browser-policy.ts`, тест — в
`runtime/tests/agent-browser-policy.test.ts`. Текущая граница описана в
`runtime/AGENT_SERVICE.md`; утверждения о состоянии Mac ниже не являются свежим health.

## Цель и полномочия

Через существующий вход `zavx0z → computer → Runtime` подключиться к обычному
уже работающему Chrome и прочитать выбранную открытую вкладку. Не запускать другой
Chrome, не создавать профиль, не открывать DevTools Console и не вводить второй
Runtime, Interpreter или MCP. Подключение не означает экспорт полной истории:
`read-dom` читает текущий документ и сообщает об ограничении размера.

Поручение: код через GitHub без запуска Actions, затем получение и проверка на Mac
через Завхоз. Изменение сохраняется отдельно от `main` до проверок, с `[skip ci]`.
Workflow не меняется; PR и workflow_dispatch не создаются. Наличие тестов в исходниках
не является результатом их выполнения.

## Реализация

`existing-discovery.ts` читает только `DevToolsActivePort` в явно заданном каталоге
данных Chrome: локальный порт и `/devtools/browser` либо `/devtools/browser/<id>`.
Нет перебора портов/профилей, автозапуска или изменения настроек. Адрес — loopback;
файл — ограниченный по размеру обычный файл текущего пользователя, не symlink.
Каталог должен иметь канонический абсолютный путь. Это проверка локальной
конфигурации, не OS sandbox против враждебного процесса владельца.

`CdpBrowserTransport` сохраняет один WebSocket браузера. Команды и события
разделяются по `sessionId`, wire ID уникальны между логическими сеансами.
Закрытие краткого чтения освобождает его ожидания и подписки, но не браузер.
Отключение драйвера ждёт события физического закрытия WebSocket с ограниченным
сроком; одного вызова `close()` недостаточно. `Browser.close` не отправляется.
Классические `CdpHttp`/`CdpSession` и старые потребители сохранены.

`ExistingChromeDriver` переиспользует существующие чтение, capture и readiness
из `CdpBrowserDriver`. Подключение проверяет `Browser.getVersion` и неизменность
обнаруженного адреса после согласования. Вкладки получаются через `Target.getTargets`,
прикрепление — `Target.attachToTarget` с `flatten: true`. Прикрепления переиспользуются
до отключения. После reconnect старые объекты вкладок не принимаются, даже при
совпадении URL, заголовка и targetId. После detach нет скрытого повторного attach.
Ни `/json/*`, ни launch-скрипт в новом пути не вызываются.

Runtime использует новый явный `connectionMode: "existing-session"`. Старые
конфигурации без поля остаются HTTP. Длительное владение новым подключением
записывается по каталогу данных (`chrome-user-session`), не по угаданному порту.
Fingerprint и ключи старого HTTP-режима не меняются; журналы не удаляются.
Публичная provenance использует имеющийся `external-cdp` с настроенным `endpointRef`:
это непрозрачная ссылка на управляемую пользователем сессию, не утверждение об
удалённой машине. Конкретный локальный адрес обнаруживается при connect.

В каталоге `computer` доступны существующие `browser_chrome_*` методы. Дополнительная
политика этого proxy допускает только `connect-instance`, `disconnect-instance`,
`wait-target`, `capture-target`, `read-console`, `read-dom`, `read-accessibility`.
Произвольные команды, evaluate, навигация, создание и закрытие вкладок не допускаются.
Все схемы, полномочия, reservations и проверка машины Runtime сохраняются.

## Конфигурация и согласование

Пример фрагмента; путь, binding и references сначала сверить с действующей
конфигурацией целевого Mac. Не заменять её примером целиком:

```json
{
  "chrome": {
    "bindingId": "chrome",
    "instances": [{
      "browserInstanceRef": "chrome:user",
      "initialTransportGeneration": "chrome:initial",
      "connectionMode": "existing-session",
      "userDataDir": "/Users/OWNER/Library/Application Support/Google/Chrome",
      "profileLabel": "Обычный Chrome",
      "approvalTimeoutMs": 20000
    }]
  }
}
```

Это каталог, содержащий `DevToolsActivePort`, не подкаталог `Default`.
Парсер ничего не подключает. `profileLabel` — описание, не команда выбора профиля;
видимые targets определяются выбранной сессией и Chrome. Требуются Chrome 144+
и разрешённая удалённая отладка в `chrome://inspect/#remote-debugging`.
Диалог доступа подтверждает пользователь. Ответ протокола не доказывает видимость
диалога: это проверяется live. Ожидание handshake/разрешения по умолчанию 20 секунд,
максимум 25; команды имеют отдельные сроки. Timeout не означает доказанный отказ
пользователя. После unknown читать operation и состояние, не повторять действие
и не удалять записи recovery. `chrome/scripts/cdp.sh` — только старый отдельный
сценарий запуска, не шаг или fallback этого подключения.

## Подготовленные проверки

Запускать через Завхоз в уже открытом терминале на проверенном Mac/checkout,
с имеющимися зависимостями. Не устанавливать недостающее автоматически:

```sh
bun test shared/src/cdp.test.ts shared/src/cdp-browser.test.ts chrome/tests/existing-discovery.spec.ts chrome/tests/existing-session.spec.ts
bun test runtime/tests/browser-config.test.ts runtime/tests/existing-browser-config.test.ts runtime/tests/agent-browser-policy.test.ts
bun test chrome/tests/adapter.spec.ts chrome/tests/cdp-driver.spec.ts chrome/tests/cdp-targets.spec.ts
bun test runtime/tests mcp/tests
./node_modules/.bin/tsc --noEmit -p chrome/tsconfig.json
./node_modules/.bin/tsc --noEmit -p runtime/tsconfig.json
./node_modules/.bin/tsc --noEmit -p mcp/tsconfig.json
```

Тесты изолированы от пользовательского Chrome. Покрываются HTTP 404 против нового
WebSocket пути, повторные чтения через один WS, одинаковые URL двух targets,
маршрутизация, отказ подключения, отмена, изменение адреса, detach/reconnect,
физическое закрытие, конфигурация и политика proxy. Сценарий 404 включает старый
и новый клиент в одной loopback-фикстуре; до запуска это подготовленный сценарий,
а не воспроизведённый результат. Отказы существующих тестов сверять с базой отдельно.

## Последняя проверенная точка и следующий шаг

GitHub доступен, но каталог инструментов этой беседы не предоставил Завхоз.
Текущая машина, установленная версия, checkout и Chrome не проверены. Получение
кода на Mac, тесты, установка и live attach не выполнялись. Историческое состояние
машины не заменяет новый health. Работа не завершена наличием коммита.

Следующий разрешённый шаг при доступном Завхозе: получить его текущий контракт,
проверить `system_health`/ожидаемую машину и обнаружить существующие окна Chrome
и iTerm2/Terminal. Проверить cwd, origin, HEAD и рабочие изменения до fetch ветки;
не перезаписывать чужую работу и не переключать dirty checkout вслепую.
Выполнить изолированные проверки. Для терминала соблюдать check_input → свежее
observe → действие, проверять вывод, обычное приглашение и код возврата, не receipt Enter.

Установку выполняют владельцы Runtime/proxy: сначала план, текущая конфигурация,
подпись и независимый путь возврата. Не перезапускать собственный proxy/tunnel
через него самого, не запускать второй Runtime или legacy REST как обход.
Работающая установка и настройки браузера этим изменением не затронуты.

Критерий живой приёмки: через тот же Завхоз получить свежие instance/target references,
явно подключиться и дважды прочитать конкретную уже открытую вкладку. Подтвердить,
что пользовательский Chrome, процесс, профиль и вкладки не перезапускались и
не заменялись; после disconnect браузер и чат остаются открыты. Сохранить commit,
установленную версию, operation IDs, проверенный эффект и неизвестное.

## Первичные сведения о механизме Chrome

- https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session
- https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/common/BrowserConnector.ts
- https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_http_handler.cc
- https://chromedevtools.github.io/devtools-protocol/tot/Target/

Эти источники описывают механизм; они не доказывают работоспособность данной
реализации на машине пользователя.
