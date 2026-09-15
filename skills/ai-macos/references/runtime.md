# Workflow runtime

Применять только когда текущий `system_health` сообщает runtime build.
Наличие этого файла не означает, что новый runtime уже установлен или все
перечисленные группы возможностей доступны. Параметры брать из tool schema.

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

Для многошагового ввода использовать interaction API, когда он объявлен.
Interaction принадлежит конкретной client lineage и exact target, имеет
ограниченный срок и отзывается при вмешательстве пользователя. Не имитировать
сессию серией независимых слепых focus/restore.

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
