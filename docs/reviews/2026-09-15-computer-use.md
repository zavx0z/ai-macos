# Ревью ai-macos: готовность к computer use

Дата: 15 сентября 2026. Проверенный commit: `bc4b6afa5a943391d8a573d22ba027fa35d0ee2d`.
Среда: canonical checkout `/Users/zavx0z/repozitarium/ai-macos`, ветка `main`,
Intel x86_64, macOS 13.7.8 (22H730), Bun 1.4.2, MCP 0.3.0.

## Вывод

**Текущая реализация не завершает полный цикл computer use.** Это набор работающих
адаптеров с полезными проверками, но без единого владельца общей desktop-сессии,
полного inventory, достоверной модели готовности и завершения операций.
Добавление одного `show_window` не устранит эти причины.

Ревью охватило native helper, shared, input, window, screen, Chrome, Android,
MCP, launcher, тесты и skill/API-документацию. Ниже отдельно обозначены live
наблюдения, изолированные воспроизведения, выводы из кода и проектные пробелы.
Рабочие приложения, REST listeners, helper и permissions во время ревью не менялись.

Целевое решение: [архитектура](../computer-use-architecture.md).
Объём реализации, capability matrix и условия удаления старых путей:
[план поставки](../computer-use-delivery.md).

## 1. Доказательства из работающей системы

Через direct MCP выполнены только пассивные `system_health` и `list_windows`:

- `machine.matchesExpected: true`, hostname `repositarium`.
- MCP сообщает `version: 0.3.0`, `stableWindowId: true`.
- Window health не содержит новой capability-декларации.
- Inventory содержит одно окно ChatGPT, PID `19989`, index `1`, **без `windowId`**.
- Chrome health обнаруживает три процесса, включая отдельный Storybook-профиль;
  это не доказательство наличия доступного окна/target каждого процесса.

Пассивная проверка процессов показала:

| Компонент | PID | Начало процесса | Примечание |
| --- | --- | --- | --- |
| window | 1569 | 6 сентября, 21:45:14 | `bun src/index.ts`, без hot reload |
| screen | 1572 | 6 сентября, 21:45:14 | То же |
| chrome | 1573 | 6 сентября, 21:45:14 | То же |
| input | 1574 | 6 сентября, 21:45:14 | То же |

В предыдущем диагностическом проходе cwd этих listeners подтверждены внутри
canonical checkout. Повторно проверены их PID/команды/время запуска. Helper
на диске датирован 28 августа, его исходник — 15 сентября. Таким образом,
новый MCP работает поверх старого backend. Даты сами по себе не заменяют build
fingerprint; в данном случае их подтверждает форма живого ответа без ID.

Все четыре порта `7878/7879/7880/7882` сейчас слушают `*`, а не только loopback.
Внешняя достижимость через firewall и эксплуатация из LAN не проверялись.

## 2. Findings, требующие исправления

`P1` — приоритет до принятия автономного computer use; `P2` — дефект/пробел,
который также должен закрыться в своём этапе. Приоритет не означает, что
описанный неблагоприятный эффект уже произошёл у пользователя.

### F01 · P1 · Health объявляет неподтверждённую поддержку backend

**Доказательство:** live ответ выше и [mcp/src/index.ts](../../mcp/src/index.ts),
строки 107–132 и 643–650: совместимость определяется именем сервиса, а
`stableWindowId: true` задано константой. [launcher.ts](../../mcp/src/launcher.ts),
26–80 и 82–106, повторно использует подходящий по форме health listener без
проверки build/protocol/native capability. Input собирает helper только при bootstrap.

**Следствие:** агент доверяет новой схеме, но получает старую identity и поведение.
Переподключение MCP само по себе не обновляет REST/native.
**Закрытие:** end-to-end capability negotiation, loaded build IDs и согласованный update.

### F02 · P1 · Несколько MCP-клиентов одновременно владеют вводом

**Доказательство:** [mcp/src/index.ts](../../mcp/src/index.ts), 311–322,
содержит process-local boolean. В изолированном тесте два отдельных STDIO MCP
процесса обратились к одному fake input service одновременно:

```json
{"maxActiveNativeDispatches":2,"results":[{"ok":true,"delivered":true},{"ok":true,"delivered":true}]}
```

Никакие реальные события не отправлялись. Тест доказывает отсутствие общей
сериализации, а не факт неправильного клика на живом Mac.
**Закрытие:** единственный session runtime и native fencing для всех mutation-входов.

### F03 · P1 · Таймаут освобождает управление до завершения отправки

**Доказательство:** [mcp/src/index.ts](../../mcp/src/index.ts), 59–86,
375–391, 408–433; [input/src/native.ts](../../input/src/native.ts), 20–33.
HTTP timeout не отменяет дочерний helper, а `finally` MCP восстанавливает фокус.
Повторённый isolated scenario: timeout 150 мс, fake dispatch 600 мс.

```json
{"activeNativeDispatchesWhenMcpReturned":1,"restoreDuringDispatch":true,"delivery":"unknown"}
```

Для typing timeout специально отключён: это предотвращает данный timeout-path,
но не даёт deadline/cancel/status и может удерживать действие бессрочно.
**Закрытие:** operation journal, cancellation до native, drain до восстановления
фокуса, status lookup после разрыва связи.

### F04 · P1 · Проверка фокуса отделена от глобального ввода

**Доказательство:** [mcp/src/index.ts](../../mcp/src/index.ts), 354–380:
сначала `/focus`, затем отдельный POST с координатами/текстом.
[input/src/index.ts](../../input/src/index.ts), 263–317, и
[helper](../../input/native/meta_input_helper.c), 82–87, 781–921,
не получают проверенный windowRef вместе с глобальной инъекцией событий.

**Следствие:** другой клиент/человек может сменить target между фазами или во
время typing. Повторная проверка окна после действия не предотвращает отправку
в изменившийся фокус. **Закрытие:** native target preconditions, user-conflict
monitor, проверка между частями ввода и честный partial/unknown result.

### F05 · P1 · Нет завершённого контракта отмены и held-input cleanup

**Доказательство:** [helper](../../input/native/meta_input_helper.c),
824–832 и 857–870: down/up разделены ожиданиями и ветками раннего выхода;
ledger/watchdog/cancellation отсутствуют. [native.ts](../../input/src/native.ts)
не ограничивает время дочернего процесса. [mcp/src/index.ts](../../mcp/src/index.ts),
1018–1023, закрывает сервер без протокола drain для native операции.

**Следствие:** отказ между down/up может оставить синтетическое нажатие, а
отмена MCP не доказывает остановку действия. **Закрытие:** native ledger,
bounded release, watchdog, подтверждённое завершение или `cleanup: unknown`.
Уже отправленное событие отменить нельзя; абсолютная гарантия cleanup при SIGKILL
или сбое OS недопустима.

### F06 · P1 · REST-интерфейсы обходят ограниченную MCP-границу

**Доказательство:** `Bun.serve({port})` в
[input](../../input/src/index.ts), 65–68,
[screen](../../screen/src/index.ts), 40–43,
[chrome](../../chrome/src/index.ts), 48–53,
[android](../../android/src/index.ts), 21–29; middleware авторизации отсутствует.
Live lsof подтвердил wildcard listeners. В input есть mutating GET `/mouse/move`
(320–328); Chrome принимает `/eval` и `/cdp/command`, Android — bootstrap и eval.
Стандартное значение hostname описано в [Bun Server](https://bun.sh/docs/runtime/http/server).

**Следствие:** проверка hostname, target и skill-ограничения в MCP не защищают
прямой сетевой вход. Точный сетевой охват зависит от firewall; удалённый exploit
в рамках ревью не запускался. **Закрытие:** private UDS, единый runtime boundary;
на переходе loopback + локальная аутентификация + отсутствие mutating GET.

### F07 · P1 · Inventory не различает отсутствие окна и невозможность его увидеть

**Доказательство:** [helper](../../input/native/meta_input_helper.c),
288–312, 373–436, 582–606: onscreen-only CG inventory используется и для поиска,
и для разрешения ID. Несопоставленные AX/CG записи пропускаются. JSON не содержит
hidden/minimized/space/actionability; sheets доступны преимущественно через frontmost.
MCP [list_windows](../../mcp/src/index.ts), 680–694, обещает только visible windows.

Это ограничение действующего контракта, а не регрессия заявленного all-windows API.
Оно блокирует ожидаемый цикл пользователя. **Закрытие:** объединённый inventory
с completeness/errors, состояниями и registry; отдельный exact `show_window`.

### F08 · P1 · Screenshot и координатный ввод не связаны наблюдением

**Доказательство:** [mcp/src/index.ts](../../mcp/src/index.ts), 493–513,
возвращает logical frame, но не фактические pixel dimensions/transform.
`mouse_click` принимает target и координаты без capture ID/revision (909–928).
`mouse_move` принимает глобальные координаты вообще без target (891–905).
Scroll всегда привязывается к центру окна (932–949).

**Следствие:** устаревшая картинка, downscale, несколько DPI, перемещение UI внутри
окна и wrong scroll container не обнаруживаются контрактом.
**Закрытие:** observation receipts, image-to-screen transforms, freshness/owner
validation, явный anchor scroll и адресованный hover/drag.

### F09 · P1 · Capture меняет фокус и не удостоверяет принадлежность пикселей

**Доказательство:** [screen/src/index.ts](../../screen/src/index.ts), 218–275:
raise → captureRect → frame/ID check → restore. `screencapture -R` захватывает
видимую область, включая чужие перекрытия. Frame/ID check не проверяет occlusion.
[MCP restore](../../mcp/src/index.ts), 229–259, при другом текущем фокусе снова
активирует старое окно, не отличая вмешательство человека.

**Закрытие:** явные isolated/composite modes, capture без неявной activation,
surface ownership, условное восстановление под общим lease.

### F10 · P2 · Permission/readiness/caption подтверждаются неполно

**Доказательство:** [screen health](../../screen/src/index.ts), 162–169,
проверяет только window upstream, не Screen Recording; desktop response
(62–65, 172–182) теряет переданный caption. [helper probe](../../input/native/meta_input_helper.c),
91–123, проверяет движение на один пункт, но не результат обратного перемещения.
При внешнем перемещении результат не различает конфликт и отсутствие доставки.

**Закрытие:** passive permission state отдельно от active probe; movement,
readback и restore как отдельные результаты; единый capture receipt с caption.
Единичный probe failure из журнала инцидентов не считается объяснённым этим ревью.

### F11 · P2 · Window/input primitives не доведены до проверяемых переходов

**Доказательство:** helper focus игнорирует ошибки `AXMain`/`AXFocusedWindow`
в собственном success condition (632–647); верхний window частично компенсирует
это readback. Move/resize и [arrange](../../window/src/index.ts), 171–191,
не возвращают actual/partial state. Display geometry берётся через Finder как
одна ширина/высота ([windows.ts](../../window/src/windows.ts), 185–188).
Drag (helper 824–832) сразу прыгает в endpoint и затем спит, без траектории.
[pin.ts](../../window/src/pin.ts), 33–40, запускает overlapping async ticks.

**Закрытие:** state transitions с readback и partial result, display topology,
trajectory drag. Pin не часть обязательного computer use: удалить после
проверки оставшихся callers либо перевести в ограниченную управляемую операцию;
бесконтрольного фонового AXRaise в конечной архитектуре нет.

### F12 · P1 · Chrome UI capture содержит отдельные ошибки identity/масштаба

**Доказательство:** [chrome/src/chrome.ts](../../chrome/src/chrome.ts), 666–740:
tab activation происходит до сохранения prevApp; geometry читается до wait;
readiness ищется по URL; restore не защищён общим finally. Масштаб применяется
в screen и затем ещё раз в Chrome. При `medium` возможны два последовательных
уменьшения. Downscale возвращает весь `data.buffer` (758–773), что некорректно
для Buffer view с ненулевым offset/неполной длиной.

**Закрытие:** native Chrome UI обслуживается общим window/capture путём;
CDP viewport — самостоятельным точным target. Один владелец scale и точный byte view.
Live visual проверка этих веток не выполнялась.

### F13 · P1 · Browser readiness и CDP deadlines допускают ложную готовность/зависание

**Доказательство:** [wait-ready.ts](../../chrome/src/wait-ready.ts), 107–109
игнорирует `false` из reflow (235–247); Network наблюдается после предыдущих
load steps (143–170), что не является учётом всей загрузки. `/cdp/screenshot`
в [chrome index](../../chrome/src/index.ts), 187–202, не использует итог ready.
[shared/cdp.ts](../../shared/src/cdp.ts), 11–105, не имеет command/connect timeout.
Android reload (android.ts 63–89) и Chrome history (cdp-mode.ts 480–500) могут
ждать Runtime.evaluate после уничтожения контекста без собственного command deadline.

**Закрытие:** typed event lifecycle, armed navigation observations, strict/partial
readiness, общий budget и abort/close cleanup. Ограничить full-page pixels/bytes,
viewport dimensions и trace buffer. Временной лимит вокруг Promise не отменяет
оставшиеся browser операции/overrides.

### F14 · P1 · Android bootstrap и target selection нарушают изоляцию

**Доказательство:** [android/src/index.ts](../../android/src/index.ts),
21–24, запускает bootstrap до listener с autoInstall по умолчанию.
[bootstrap.ts](../../android/src/bootstrap.ts), 78–107, предпочитает Homebrew,
а 125–130 перезапускает общий ADB daemon. Root `dev` включает Android.
Первый serial выбирается автоматически, [ensureForward](../../android/src/android.ts),
18–20, его не передаёт. `/dev` (127–144) использует ADB без serial и возвращает
первый target при создании/исчезновении ожидаемого. FullPage (164–174) не имеет
отдельного измеренного document clip; `/tabs` вызывает API, которое тот же
исходник считает неподдерживаемым Android Chrome.

**Закрытие:** opt-in `android.chrome`, явный serial/transport epoch/owned forward,
отдельная установка через MacPorts; exact target и проверенный full-page contract.
Это не готовый adapter для всего UI Android. Телефон и ADB в ревью не запускались.

### F15 · P1 · Startup/child lifecycle не имеет одного владельца

**Доказательство:** [launcher](../../mcp/src/launcher.ts), 82–159:
bootstrap каждого MCP процесса независимо probe/start четыре detached services;
нет общего startup lock/ownership registry/drain. Неответивший listener при
fetch error считается missing. Ошибка запуска зависимого Chrome может прервать
импорт MCP. Native build проверяет mtime, собирает/подписывает конечный путь
([native.ts](../../input/src/native.ts), 36–84), без общей build transaction.
Screen subprocess и window API fetch не имеют deadline.

**Закрытие:** один supervised runtime, bounded startup, immutable build identity,
atomic helper update с сохранением TCC identity, optional adapters отдельно,
учёт всех дочерних ресурсов. Не заменять неизвестные/архивные listeners.

### F16 · P2 · Объявленный инструментарий и документация отстают от нужных сценариев

**Доказательство:** MCP имеет 18 инструментов. Нет show hidden/minimized,
display selection/inventory, bounded AX tree/actions, drag, interaction/status/cancel,
browser-target и Android инструментов. Chrome присутствует только в health.
`latestScreenshot` обновляется в standalone capture, но не action capture
([mcp/src/index.ts](../../mcp/src/index.ts), 287–305 и 515–520).
Документы сохраняют index-first примеры, Homebrew setup и частично старые
утверждения про screenshot proxy/готовность.

**Закрытие:** согласованный MCP catalog, общие схемы и generated API reference;
skill описывает реальный workflow. Legacy examples и дублирующие REST/CLI пути
удаляются по списку в плане поставки, а не остаются вторым контрактом.

## 3. Что уже полезно и сохраняется

- Direct MCP отделён от deprecated connector; machine preflight существует.
- Для явного CG ID selector не подменяется stale title/index; duplicate targets
  отклоняются, закрытие окна после действия не вызывает replay.
- Различаются неизвестная отправка и постфактум неудачный снимок; `effectVerified`
  не выставляется по факту успешного input call.
- Есть ownerWindowId для sheet и проверки before/after window capture.
- Clipboard вынесен из эмуляции клавиш; temporary screenshot files удаляются
  через finally при нормально завершившихся дочерних процессах.
- Есть тесты выбора exact CDP target при одинаковых URL и нескольких Chrome-процессах.

Эти свойства переносятся в общий runtime; их не следует потерять при переработке.

## 4. Выполненные проверки и пределы

| Проверка | Результат |
| --- | --- |
| `bun test mcp/tests/stdio.test.ts mcp/tests/window-coordinates.test.ts` | 14 pass, 0 fail |
| `bun test shared/src/window-identity.test.ts window/tests/focus.test.ts input/tests/keys.test.ts input/tests/window-selector.test.ts` | 13 pass, 0 fail |
| `bun test screen/tests chrome/src/session.test.ts chrome/tests` | 19 pass, 0 fail |
| `bunx --no-install tsc --noEmit` | exit 0 |
| Два независимых MCP клиента, fake adapters | Подтверждена одновременная отправка: максимум 2 |
| HTTP timeout до завершения fake native work | Подтверждён преждевременный restore и незавершённый dispatch |
| Direct MCP health/inventory и passive process inspection | Подтверждён mixed-version runtime и отсутствие ID |

Итого: **46 существующих безопасных тестов прошли**. Они не проверяют фактический
native event routing, CG↔AX mapping, другой Space, mixed-DPI, Screen Recording,
SCK capture, physical user takeover, cancellation после down, TCC после обновления
helper, сетевую эксплуатацию, или live Android. Clipboard-test пропущен, потому
что он меняет реальный системный clipboard. Live input/window scenarios,
скриншоты, browser navigation, bootstrap и restart не выполнялись.

Изолированные воспроизведения использовали ephemeral loopback fake servers и
две/три дочерние MCP-сессии; все они закрыты после пробы. Временные файлы пробы
находятся в ignored `tmp/computer-use-review/`. Приведённые выше JSON — результаты
этого запуска, не ожидаемые значения будущих regression tests.

Независимые read-only проходы по native/window/input и screen/browser/Android
сведены основным агентом с проверкой указанных source paths. Память о прошлой
гонке WebStorm использована как направление поиска; текущие выводы о локальном
mutex, restore и identity проверены заново по коду и изолированным probes.

## 5. Что считается результатом этого поручения

Получены доказательное ревью, архитектура, список capabilities, очередность
реализации и матрица приёмки. Изменения этого прохода — документы в `docs/`.
Production код, запущенный helper и services остаются прежними; описанные
дефекты не объявляются исправленными. Реализация полноценного computer use
принимается только после этапов и live-проверок из плана поставки.
