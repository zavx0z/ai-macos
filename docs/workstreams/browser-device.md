# Browser и device adapter

## Текущее состояние

Статус: C0 и scoped C2 browser/device source slice приняты ведущим. После
принятия C1 реализованы:
in-process `RuntimeBrowserAdapter` и `RuntimeDeviceBrowserAdapter` импортируют
только `@meta/shared/contracts`, используют реальные authority/resource/context
interfaces и не создают второй wire DTO. Registry, основные operations и
concrete Android CDP backend прошли source review. Runtime lifetime reservation,
composition/recovery и live A34–A40 остаются отдельным owner-стыком, поэтому
F13/F14 целиком ещё не закрыты.

Live Chrome, ADB, телефон, системные сервисы и permissions не использовались.

## Реализовано

- `chrome/src/adapter.ts`:
  - `RuntimeBrowserAdapter implements BrowserAdapter` с immutable host context;
  - configured exact instances, explicit connect/disconnect и новый transport
    generation при каждом connect/reconnect;
  - complete instance/target snapshots с inventory generation и provenance;
  - exact target lifecycle без URL matching: open/close/activate/navigate/reload/wait;
  - DOM, browser accessibility и bounded console reads;
  - обязательный `authorizeBrowserOperation`: target authority, client session и
    exact runtime resource handles проверяются до driver side effect;
  - visible activation требует `desktop-input` lease;
  - CDP timeout/disconnect даёт unknown dispatch и scoped quarantine;
  - dispatch lifecycle различает `not-sent`, `sent`, `acknowledged`,
    `reconciled`: ошибка readiness/re-list/publisher после ACK больше не выглядит
    как нулевая отправка; ошибка до ACK остаётся unknown;
  - transport timeout/disconnect переводит instance в degraded, меняет transport
    generation и инвалидирует старые refs до explicit reconnect;
  - capture выполняет requested clip/fullPage/scale/dimension/pixel/byte policy,
    строит browser coordinate region и публикует actual PNG bytes через
    `BinaryFramePublisher` после checksum/dimension verification;
  - frameRef берётся только из runtime-issued `ObservationPublication`, producer
    не генерирует собственную identity; capture timestamp ставится после receipt;
  - console ограничивается по events/bytes во время collection, DOM режется в
    renderer до CDP transport, AX читается bounded обходом root/children;
  - HTTP CDP response ограничивается streaming byte cap до JSON parse, snapshots
    проходят C1 schemas и target inventories имеют hard limit 4096;
  - readiness больше не синтезирует `ownership: reached`: без runtime
    point-bound proof шаг возвращается `unavailable`; exact target остаётся reached.
  - `CdpBrowserDriver` использует существующие C0 `CdpHttp`/CDP operations, а не
    второй transport.
- `android/src/adapter.ts`:
  - `RuntimeDeviceBrowserAdapter implements DeviceBrowserAdapter` с exact
    `DeviceRef`/`DeviceBrowserInstanceRef`/target refs и обоими transport epochs;
  - explicit serial, instance connect/disconnect, target lifecycle,
    navigate/reload/wait/capture и binary frame publication;
  - операции требуют одновременно `adb-device` и `cdp-target` leases;
  - `OwnedAdbForward` создаёт forward только на exact serial через `--no-rebind`,
    не заменяет занятый port и удаляет только подтверждённый собственный mapping;
  - foreign/изменившийся forward сохраняется и приводит к явной ошибке.
  - `ForwardOwnedDeviceBrowserDriver` связывает browser connect/disconnect с
    фактическим owned forward lifecycle и AbortSignal checkpoints.
  - wrapper повторно подтверждает exact serial/local/remote mapping перед каждым
    target inventory/open/close/navigate/reload/wait/capture; mismatch не достигает CDP;
  - forward ownership фиксируется сразу после create и сохраняется до
    подтверждённого remove; failed abort cleanup остаётся retryable ownership,
    а wrapper не проглатывает cleanup failure;
  - authoritative forward state читается из текущего ADB mapping, а не выводится
    из логического connected state; mismatch инвалидирует device и browser epochs.
  - `AndroidCdpDriver` и `createAndroidChromeAdapter` составляют concrete backend:
    owned forward + общий `CdpBrowserDriver` + exact ADB intent target diff;
    Android не импортирует private Chrome source и не создаёт второй transport.
  - ошибка `adb forward --list` теперь typed failure, не ложный empty inventory;
    disconnect сохраняет ownership до повторной подтверждённой очистки.
  - forward revalidation выполняется до и после каждого CDP result; retarget
    внутри вызова даёт post-phase ownership error и unknown delivery;
  - device connected/missing/reappeared сохраняется между inventory calls и
    меняет device/browser generations на каждом переходе;
  - AbortSignal и deadlines доходят до ADB subprocess, timeout/abort завершает
    процесс через TERM → bounded wait → KILL → bounded confirmation; отсутствие
    exit ACK даёт cleanup-unknown, не утверждение остановки.
  - already-aborted ADB command отклоняется до spawn; lost create ACK переводит
    forward в `attempted-unknown` и сохраняет observed mapping для runtime
    reconciliation без присвоения чужого ownership.
  - connect выполняет post-forward check после CDP handshake; retarget внутри
    connect не принимается как готовый Android instance.
  - rejected `proc.exited` не считается exit evidence; injected runner проверяет
    never-exit, rejected-exit и late confirmed exit. Если TERM/KILL не дали
    подтверждения, возвращается cleanup-unknown.
  - cleanup-unknown create сохраняет `attempted-unknown` даже при первом пустом
    inventory: поздно появившийся mapping не удаляется без runtime reconciliation.
  - общий ADB deadline охватывает `stdout + stderr + exit`, а не только exit;
    зависший inherited pipe отменяется даже после confirmed process exit;
    stdout/stderr читаются streaming с byte cap до materialization.

- `shared/src/cdp.ts`:
  - HTTP connect/request и WebSocket connect/command deadlines;
  - HTTP deadline охватывает чтение body после уже полученных headers;
  - typed transport errors `CdpTransportError`;
  - отдельная отмена command/event wait через `AbortSignal`;
  - typed event subscriptions без доступа consumers к private WebSocket;
  - pending-команды отклоняются и очищаются при close/error/disconnect;
  - event waiters и connect waiters немедленно завершаются при owner close;
  - command abort во время connect scoped к команде, session abort закрывает socket;
  - owner `withSession` закрывает transport в `finally`.
- `chrome/src/wait-ready.ts`, `chrome/src/cdp-mode.ts`, `chrome/src/index.ts`:
  - `false` readiness predicate больше не становится success;
  - результат различает `ready`, `partial`, `timed-out`, содержит incomplete steps;
  - network observation вооружается перед navigation/reload/history;
  - event subscriptions создаются до ACK `Network.enable` и очищаются при ошибке;
  - load/context waits имеют deadline и отклоняют timeout вместо silent resolve;
  - зависшие CDP commands ограничены общим transport deadline;
  - screenshot/navigation/reload/history/viewport HTTP не возвращают `ok:true`
    при строгой незавершённой readiness;
  - full-page и viewport capture измеряются через `Page.getLayoutMetrics`;
    dimension/32 MP/64 MiB caps проверяются до дорогого декодирования, где возможно.
  - generic raw `/cdp/command` и `/eval` HTTP routes удалены;
  - URL → CDP target selection полностью запрещён, в том числе при одном match.
- `chrome/src/chrome.ts`:
  - Chrome UI capture сохраняет предыдущий app до tab activation;
  - focus restore находится в `finally`;
  - geometry перечитывается после focus непосредственно перед capture;
  - scale/detail передаются единственному владельцу `@meta/screen` и повторно в
    Chrome не применяются;
  - ошибочный возврат полного `Buffer.buffer` удалён вместе с локальным downscale.
- `android/src/bootstrap.ts`, `android/src/adb.ts`, `android/src/index.ts`:
  - профиль `android.chrome` выключен по умолчанию и требует explicit enable;
  - runtime bootstrap больше ничего не устанавливает, не открывает prompt,
    не вызывает `adb start-server`/`kill-server` и не предлагает Homebrew;
  - setup описан только как отдельный MacPorts workflow;
  - passive health не выбирает первое ready-устройство и не доверяет общему 9223;
  - disabled health вообще не вызывает `adb`, потому что даже `adb devices`
    способен неявно поднять общий daemon;
  - forward требует точный serial и использует `--no-rebind`;
  - добавлены exact parse primitives и удаление только serial-scoped forward;
  - legacy operations требуют точный tabId; first-tab fallback удалён;
  - старый `/dev` больше не открывает intent без serial и не возвращает `tabs[0]`.
  - весь legacy REST mutation/read surface fail-closed с 503 до подключения
    принятого runtime-owned AndroidChromeAdapter.
- `android/tsconfig.json` исправлен на канонический root config, tests включены.

## Реальные paths и exports

- `CdpHttp`, `CdpSession`, `CdpTransportError`, `withSession` из
  `shared/src/cdp.ts` через существующий `@meta/shared` export.
  Incoming WebSocket payload ограничивается до `JSON.parse`; console arguments
  ограничиваются отдельно до сборки entry.
- `armReadiness`, `waitOnSession`, `WaitReadyResult` из
  `chrome/src/wait-ready.ts`.
- `cdpCaptureScreenshot`, `CdpCaptureLimitError`,
  `assertCaptureDimensions` из `chrome/src/cdp-mode.ts`.
- `bootstrap`, `BootstrapStatus`, `BootstrapDeps` из
  `android/src/bootstrap.ts`.
- `adbArgs`, `parseAdbDevices`, `parseAdbForwardList`, exact forward/remove/state
  primitives из `android/src/adb.ts`.
- `RuntimeBrowserAdapter`, `CdpBrowserDriver`, `BrowserDriver` через
  `@meta/chrome/adapter`.
- `RuntimeDeviceBrowserAdapter`, `DeviceBrowserDriver`, `OwnedAdbForward` через
  `@meta/android/adapter`.

## Изменения manifest

Root manifest не менялся этим направлением. В собственных package manifests
добавлен subpath `./adapter`; новых dependencies и lock-изменений нет. Ведущий
ранее исключил Android из root `dev`; legacy `dev:android` остаётся fail-closed.

## Выполненные checks

- `bun test shared/src/cdp.test.ts chrome/tests android/tests`
  — 62 pass, 0 fail, 121 assertions.
- `bunx --no-install tsc --noEmit -p chrome/tsconfig.json` — exit 0.
- `bunx --no-install tsc --noEmit -p android/tsconfig.json` — exit 0.
- Lead probe `bun tmp/browser-device-review/probe.ts`:
  `http-body-after-timeout command-timeout`,
  `event-wait-after-close disconnected`,
  `send-before-open-after-close disconnected`.
- Все новые проверки используют fake sessions/dependencies и pure parsers.
- Live browser/navigation/capture/ADB/device/bootstrap и установка не запускались.
- Оба adapter entrypoint собираются `bun build`; package typechecks проходят.
- Root typecheck в момент handoff блокируют concurrent изменения других
  направлений (`input/tests/authorization.test.ts`, `native/src/protocol.ts`);
  browser/device files в этих ошибках отсутствуют.

## Покрытие acceptance

- A34: сохранены тесты exact targetId при одинаковых URL; production
  browserInstanceRef/transport generation ожидают C1 adapter contract.
- A35: fake tests подтверждают, что reflow `false` даёт partial, а network
  tracker вооружается до остальных readiness steps.
- A36: fake transport tests подтверждают connect/command/event deadlines,
  disconnect cleanup и scoped AbortSignal.
- A37: pure test отклоняет dimension/pixel overflow до screenshot allocation;
  encoded byte limit проверяется до base64 decode.
- A38: Android стартует как optional/unavailable профиль; root `dev` изменён ведущим.
- A39: C0 primitives требуют serial и `--no-rebind`, не выбирают device и не
  трогают общий daemon; transport epoch/owned registry ожидают adapter.
- A40: legacy exact tab requirement закрыт; exact target creation через intent,
  measured Android full-page и bounded reload будут частью adapter после C1.

## Неразрешённые зависимости

C1 закрыт и опубликован. Остаются implementation/acceptance зависимости:

1. Runtime должен создать реальные host services/authority registries, передать
   configured Chrome instances и вызвать готовую Android composition factory без REST listener.
2. Concrete Android backend собран и проверен fake HTTP/ADB; его live exact serial,
   forward и Chrome target должны приниматься только ведущим на C4.
3. Проверки forward до/после закрывают наблюдаемый retarget, но идентичный ABA
   remove/recreate нельзя доказать одним ADB inventory. Runtime обязан удерживать
   OS/runtime ownership lock на весь lifetime forward; adapter не объявляет
   polling-наблюдение абсолютной гарантией.
4. Device transport epoch сейчас задаётся configuration/runtime. На USB reconnect
   runtime/device inventory должен создать новый `DeviceRef`; adapter не должен
   самостоятельно угадывать reconnect по прежнему serial.
5. Есть valid PNG + fake `BinaryFramePublisher` successful publication test и
   runtime frameRef round-trip. Остаются requested full-page extent/cancellation
   faults через adapter execute.
6. Console/DOM/AX bounding реализован до/во время transport collection; остаются
   oversized и disconnect fault tests через fake CDP socket.

## Требуемый runtime hook для lifetime ownership ADB forward

Текущий `ResourceAuthority` выдаёт только operation-scoped
`RuntimeResourceHandle`: handle навсегда связан с одним `operationId` и
освобождается terminal cleanup этой операции. Его нельзя честно удержать от
`connect-instance` до будущего `disconnect-instance`, а локальный mutex adapter
не защищает от другого runtime/process и не закрывает ABA remove/recreate.

Runtime owner должен добавить одну authoritative reservation-модель для
долгоживущего external resource:

- `reserve(resource: adb-device, owner: DeviceBrowserInstanceRef, session,
  expiresAt)` атомарно создаёт runtime-owned reservation с generation;
- `assertReserved(reservation, exact owner/current generations, now)` вызывается
  при каждой выдаче operation lease для Android instance/target;
- обычные operation handles выдаются как bounded child leases этой reservation,
  поэтому они не конфликтуют с родительским reservation и не переживают свою
  операцию;
- `releaseReservation` разрешён только после confirmed physical
  `adb forward --remove` и exact cleanup evidence; timeout/list failure/retarget
  переводит reservation в quarantined, а не освобождает её;
- disconnect/recovery сверяет reservation ID+generation и actual forward mapping;
  поздний cleanup прежней generation не может освободить новую reservation;
- runtime crash/resumption сохраняет reservation metadata и требует
  reconciliation до нового connect на тот же serial/local port.

`OwnedAdbForward` остаётся physical executor этой reservation, но не authority.
Проверки mapping до/после обнаруживают наблюдаемый retarget. Идентичный внешний
ABA с теми же serial/local/remote невозможно доказать через `adb forward --list`;
поэтому даже с reservation гарантия формулируется как runtime-exclusive ownership
при отсутствии внешнего обхода, а не как доказанная идентичность чужого ADB mapping.

## Следующий шаг

Ведущему проверить C2 registry/operations checkpoint. После приёмки связать
concrete Android driver и runtime composition, затем передать fake SUT drivers
acceptance-задаче для A34–A40 и resource/cancellation cases. Live Chrome/телефон,
service restart и permissions остаются только у ведущего на C4.
