# Workflow runtime

Применять только когда текущий `system_health` сообщает runtime build.
Наличие этого файла не означает, что новый runtime уже установлен или все
перечисленные группы возможностей доступны. Параметры брать из tool schema.

## Первый запуск и разрешения

Установленный runtime запрашивает необходимые отсутствующие права от своего
helper и показывает ход ожидания в `startup.permissions`. Запрос выполняется
при запуске, а не при каждом подключении MCP или вызове `system_health`.
После подтверждения macOS runtime заново проверяет права и готовит observer;
только затем становятся доступны защищённые действия. Установщик ожидает этот
этап в отдельном ограниченном интервале.

`requestIssued` подтверждает вызов системного API, `missing` показывает ещё
не выданные права. Это не доказательство видимого диалога и не заменяет
положительные permission flags. `restart-needed`, `timed-out` и `failed`
не разрешают ввод; точную причину брать из health.

## Короткий API

Когда каталог объявляет `get_state`, выбирать окно по его `targetId`, PID,
приложению и состоянию. `applications` и `unavailableWindows` отличают процесс
без окон от недоступного AX; отсутствие actionable ID не означает отсутствия
самого окна. `show_window({targetId})` показывает точное существующее окно.

`observe({targetId,mode,caption?})` возвращает AX, снимок или оба результата.
`caption` обязателен для снимка. `elementId` принадлежит выданному AX snapshot;
`click({targetId,elementId})` вызывает AXPress. Клик по `point: [x,y]`, `hover`,
`scroll` и `drag`, если объявлены, используют координаты последнего снимка
этой цели. Не переводить их вручную в глобальные координаты экрана.

Перед клавиатурой или мышью вызвать отдельный `check_input()`. Он сам выбирает
экран под указателем и проверяет ввод с возвратом указателя. `inputReady: false`
не разрешает продолжение. Эта проверка не вызывается автоматически из health.

Цикл native-цели: `observe` → одно действие → новое `observe`. `type_text`
вводит весь переданный текст одной операцией; `press_key` принимает отдельные
`key` и `modifiers`, например `key: "l", modifiers: ["cmd"]`. После действия,
вмешательства человека или потери наблюдения старые пиксели/AX не разрешают
новый ввод. Повторное наблюдение не должно автоматически повторять действие.

`cancel_target({targetId})` отменяет операции этой задачи, включая ожидающую
очередь. `get_target_status({targetId})` читает сохранённый результат, даже
когда окно закрылось или срок действий истёк. Потерянный ответ сначала проверять
через status. `cleanup: unknown` не означает, что действие можно повторить.

Внутренние clientRequestId, inventory, leases, fences и proofs для этих методов
не конструировать. Полная совместимость с JavaScript API Codex не заявляется;
REPL не нужен для использования этого интерфейса.

Для Chrome сначала выбрать настроенный browser instance, затем
`get_tabs({browserId})`. Одинаковые URL разных профилей не взаимозаменяемы.
Специализированные browser/device/application методы могут сохраняться рядом
с коротким API; их параметры брать только из собственного объявленного schema.

Остальные разделы относятся к низкоуровневым runtime-методам, только если они
объявлены текущим каталогом. Они не служат обходом отсутствующего наблюдения
или отказа короткого API.

## Discovery и show

`list_windows` возвращает inventory с generation, revision, applications,
окнами, surfaces и displays. Optional app — точное имя процесса, pid различает
одноимённые Chrome profiles. Проверять `complete` и `errors`: denied/partial
не равны отсутствию окон.

Сохранять точный window ref, inventoryId и revision. `window_transition`
выполняет явно выбранные show/focus/set-bounds/minimize/close. Show не создаёт
новый браузер. `requested`, `actual`, `partial` и ошибки показывают результат
каждого перехода; окно может остаться открытым из-за Save dialog.

После stale target заново получить inventory. Не собирать новый ref из старого
PID/заголовка и не переносить refs между runtime/login/native generations.

`inspect_accessibility` читает bounded snapshot выбранного окна/surface.
Усечение, deadline и неизвестное состояние видны в результате. Element refs
относятся к своему snapshot; их нельзя использовать как постоянные ID.

## Observation и ввод

Runtime выдаёт observationId, frameRef, cache scope, proofs и leases сам.
Не создавать эти значения на стороне агента. Для capture передать выбранную
цель, inventory и caption; изображение и его metadata должны относиться к
одному ответу. `latest_capture` ограничен текущей client lineage.

Pointer-действия требуют свежего observationRef и подтверждённой точки.
Нельзя самостоятельно переводить screenshot pixels в screen coordinates
по приблизительному DPI. Изменение геометрии, topology или целевого окна
требует нового observation.

Профиль `desktop-browser-selected` использует одноразовые наблюдения.
Отдельная focus-session capability `input.interaction` отложена и не является
условием работы этого профиля. Прежний focus автоматически не восстанавливается.

## Исход, отмена и повтор

Каждому новому действию назначать уникальный clientRequestId. При повторном
получении того же результата сохранять ID и payload; новый ID может означать
новое действие. Потеря ответа требует `get_operation`, а не повторной отправки
клика, текста, close или launch.

`cancel_operation` сообщает фактическое состояние. `acknowledged` означает
принятие запроса; безопасное продолжение зависит от stopped/terminal state и
подтверждённого cleanup. Unknown/quarantine не очищать локально и не обходить
другим инструментом. Использовать объявленный recovery API.

Журнал после перезапуска хранит доказательства старых операций. Старый receipt
не разрешает replay, перенос target в новое поколение или владение чужой lineage.

## Chrome и Android

Использовать instance/target refs соответствующего adapter. Одинаковый URL
не связывает вкладки разных profiles и не заменяет CDP target identity.
Connection/overrides/tracing/forward принадлежат runtime lifetime reservation;
после неизвестного disconnect сначала проверить reservation/recovery.

Android — opt-in capability с exact device ref и transport generation.
Несколько устройств требуют явного выбора. Недоступный Android не должен
ломать desktop core или запускать скрытую установку ADB.
