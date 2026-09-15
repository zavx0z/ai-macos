# Приёмка C1: замечания ведущего

Статус: **C1 принят ведущим после исправления первоначальных замечаний и R1–R7**.
Финальные проверки: 42 tests / 191 assertions, root typecheck и lead probes
прошли. Дополнительный invariant запрещает dispatch/restore со stale accepted
fence. Ниже сохранены замечания и условия, по которым проводилась приёмка;
их прежние формулировки ожидания относятся к истории review.
Основание — `shared/src/contracts/**` и handoff `docs/workstreams/runtime.md`.
Тридцать тестов текущего кандидата проходят; это не закрывает приведённые ниже
контрпримеры. Исправления принадлежат runtime/contracts-задаче.

## C1-01. Единый источник schemas и строгая граница JSON

Текущий `ContractSchema` содержит только name/parse/safeParse. Из него нельзя
получить MCP JSON Schema и reference без повторного описания формы данных.
Самописный JSON parser при этом меняет смысл payload:

```text
jsonValue(JSON.parse('{"__proto__":{"injected":true}}'))
  → JSON.stringify(result) == '{}', result.inherited property injected == true
jsonValue(new Date()) → {}
isoDateValue('1') → '1'
```

**Решение ведущего:** wire declarations строятся на уже используемом в проекте
Zod **4.4.3**, из них выводятся типы и JSON Schema. Ведущий добавил точную
dependency в `shared/package.json` и обновил lock; установленная версия MCP
при этом не менялась. Semantic проверки остаются обязательными поверх формы
данных. Нельзя использовать `.custom()`/transform или permissive JSON Schema
как способ скрыть отсутствующее описание transport fields.

Zod 4 поддерживает [JSON Schema export](https://zod.dev/json-schema); фактический
`z.toJSONSchema` дополнительно проверен на установленной 4.4.3. Shape declaration
должна быть одна, а не отдельные TS DTO, manual parser и MCP object schema.

Regression: prototype-like keys либо сохраняются как собственные JSON fields,
либо явно отклоняются; Date/Map/class/undefined/sparse holes не превращаются в
другие данные. Даты требуют ISO с явным timezone; nonfinite/unsafe numbers и
лишние поля отклоняются. Byte/depth limits не ослабляются.

Согласовать ограничения ID с native C API: сейчас generic OpaqueId допускает
160 ASCII символов, а C-поля имеют capacity 128 с NUL. Native-bound ID не может
тихо обрезаться. Generations имеют отдельный предел, оставляющий место для
суффиксов native-generated refs. Конкретные пределы и rejection фиксируются
в одном контракте и C mapping, с boundary tests.

## C1-02. Контексты по домену и идентичность target

`SerializableOperationContext` требует nativeGeneration/fence даже для browser,
device и clipboard, вопреки независимости этих адаптеров от desktop helper.
Разделить common runtime/caller context и tagged native/browser/device/clipboard
execution contexts. Native fence обязателен именно для native dispatch.

TargetPrecondition не должен терять structured target до произвольной строки.
Нужен tagged target с generation/application/instance identity либо явно
registry-owned opaque reference с обязательным authoritative resolution API.
Generic string без проверки владения не является exact target.

Runtime epoch навсегда связан с конкретной login session; это проверяется во всех
generation comparisons и handshake. Fence/status/ACK нельзя принять из другого
login/runtime/native поколения. Native mutation wire связывает target, fence,
deadline, operation и request в одном проверенном envelope.

## C1-03. Client authority и leases

`RuntimeAdapter.runOperation/getOperation/cancelOperation` не имеют authenticated
caller scope, а resource handle проверяется только по совпавшим kind/ref/epoch/time.
Из формы object нельзя узнать, не отозван ли lease, не принадлежит ли он другому
клиенту/операции и не quarantined ли ресурс.

Нужен явный authenticated RuntimeClientSession либо обязательный серверный
caller context. Client request dedup, get/cancel и resumption привязаны к нему.
Payload HMAC вычисляет runtime, а не принимает как доказательство от модели.
Adapter получает runtime-issued handle, связанный с operation/interaction и
lease generation; authoritative resource registry проверяет владение и отзыв.
Структурный parser не объявляется заменой этой проверки.

`activate-target.desktopAffecting` нельзя доверять caller-у для обхода desktop
lease. Классификация side effects принадлежит adapter/runtime. Видимая activation
требует desktop lease; доказанно иной background primitive — отдельный контракт.

## C1-04. Native ACK/status, ledger и observer

- Ledger ACK связывается с runtime/native generations, operation, revision и
  digest именно подтверждённого snapshot. Совпадения operationId/revision мало
  для защиты от позднего ACK другого поколения.
- Native status/cancel/drain/heartbeat ответы коррелируются с request и
  generations/fence. Active status требует operationId. Возвращаются checkpoint,
  попытки отправки и ledger revision, необходимые reconciliation.
- Ledger snapshot имеет проверяемый порядок sequence и переходов; несколько
  active entries одной кнопки/клавиши не допускаются без явной semantics.
- Observer имеет generation, sequence/cursor, coverage и gap/drop indicator.
  Недоступный observer означает `userInterference: unknown`, а не `false`.
  Restore/extension разрешаются только при непрерывном ready coverage.

## C1-05. Outcome, cleanup и восстановление

Применить semantic matrix к operation intent/state/outcome. Read-only/no-op
может завершиться с dispatch:none: не вводить запрет только ради схемы.
Но malformed mutation result не может имитировать completed verified operation.

Known execution failure с incomplete/unknown cleanup должен представляться
без потери смысла. Execution, dispatch и cleanup остаются отдельными измерениями;
небезопасный cleanup никогда не освобождает lease. При необходимости уточнить
mapping в архитектуре, а не выдавать такой result за clean failed.

Cleanup released/quarantined связаны с operation/lease generation, не имеют
дубликатов и пересечений, содержат ровно ресурсы, которыми владела операция.
Нельзя прислать чужой resource либо потерять ресурс пустым `released: []`.
Outcome хранит достаточно metadata для ответа, какой ресурс остаётся quarantined.
Ошибки unknown-delivery/cleanup не получают разрешение на автоматический replay.

## C1-06. Observation proof, freshness и координаты

Нынешний parser принимает `Evidence {state:confirmed,source:guess,confidence:0}`
и pointerActionable при readiness unavailable. Point mapper не получает текущие
generations/revisions, а timestamp региона может оказаться в 2099 году.

Доказательство безопасности — runtime-issued proofRef с exact subject,
generation/revisions/временем и известным видом проверки. `pointerActionable`
вычисляется после authoritative proof/freshness resolution; произвольный
producer boolean его не разрешает. Информационный текст evidence может оставаться
свободным, но не используется как разрешение ввода.

Resolver получает ожидаемый target/coordinate space и текущие generations,
inventory/display revisions, deadline и proof authority. Native pointer не
может получить browser CSS point без явного отказа по discriminant.
Проверяются региональная freshness, future timestamps, фактический skew,
readiness policy и границы image point. Pure affine helper не объявляется
authorizer ввода.

Affine transform проверяется на соответствие imageRect/destinationRect
(углы/bounds с допуском, включая rotation), а не только invertibility.
`maxSkewMs` выводится из timestamps. Stitched frames не атомарны; один frame
не обязан называться stitched/non-atomic. Неизвестные сведения отражаются явно.

## C1-07. Capture result и binary frame

- Result связывает publication, caption, target/source, revisions, frameRef,
  length/hash и фактически принятые PNG bytes. Receiver сверяет checksum/length;
  независимые headers с противоречащими значениями не проходят публикацию.
- Нужен runtime-local BinaryFramePublisher/cache sink: Native/Browser adapters
  передают actual bytes и получают проверенный frameRef. Metadata без такой
  операции не является передачей изображения. Services/callbacks не входят в wire JSON.
- Browser result должен сверять embedded observation/regions, а не только
  внешний target. Android viewport carries device/serial и оба transport epochs.
- Capture request задаёт clip/fullPage/output/cursor/readiness policy согласно
  источнику; common DTO не должен лишать adapter уже запроектированных функций.
- Whole-desktop composition имеет явный layout target с выбранными displays и
  topology revision. Native capture primitive может оставаться per-display,
  композиция обязана сохранять разные timestamps и mappings.
- Разделить owner scope вложенного capture cleanup и browser target cleanup,
  не дублировать один и тот же ресурс в двух владельцах.

## C1-08. Полнота adapter surfaces и inventories

В контракте должны быть реальные интерфейсы необходимых следующих работ:
WindowAdapter с inventory/state transitions и bounded AX;
BrowserAdapter/DeviceBrowserAdapter с явным connect/disconnect, inventory
snapshots, exact operations, DOM/browser accessibility read и capture policy.
Не оставлять каждому consumer собственную несовместимую форму list/show/result.

Browser/device list возвращает snapshot (generation, inventoryId, время,
complete/errors), а не голый массив. Device record различает offline/unauthorized/
connected/forward state; browser instance содержит provenance/process incarnation
и причину degraded. Необязательные диагностические capabilities не объявляются
готовыми до появления соответствующих методов и проверки.
Device target inventory адресует exact DeviceBrowserInstanceRef с device и
browser transport epochs либо явно объявленный aggregate scope. DeviceRef сам
по себе не разрешает молча выбрать первый browser instance.

## C1-09. Capabilities и readiness

Версия capability schema проверяется точно. Producer может публиковать свой
ограниченный набор возможностей, но не удалять обязательные зависимости ради
`ready`: canonical dependencies/action policy определяются runtime registry.
Полный runtime snapshot отличается от набора возможностей конкретного adapter.

Readiness проверяется относительно запрошенной policy: необходимые шаги
уникальны, false/timed-out step не превращается в ready, skipped по причине
deadline не выдаётся за добровольно отключённую проверку. Empty steps допустимы
только для явно пустой policy, не как доказательство полной готовности.

## Условия повторной передачи

Сохранить существующие полезные exports, но не ценой старой невалидной semantics.
Добавить точечные regressions к каждому контрпримеру, проверить JSON Schema
export и focused strict typecheck. Затем прислать один обновлённый handoff.
Ведущий публикует `@meta/shared/contracts` только после повторной приёмки.
Runtime daemon/UDS и production integration соседних задач пока не начинать.

## Повторная приёмка: ограниченный остаток

Вторая версия существенно исправлена: Zod declaration/JSON Schema, tagged
domain contexts, structured targets, client/resource/proof services, ACK
generations и adapter surfaces появились. 33 tests / 157 assertions и root
typecheck проходят. Ниже — остаточные контрпримеры; прежние исправленные
пункты повторно переписывать не требуется.

### R1. Освобождение lease обязано проверять cleanup partition

`OperationRecord` с одним действующим resource handle и
`outcome.cleanup={scope:none,state:complete,resources:[]}` проходит parser;
`operationCanReleaseMutationLease(record,true)` возвращает true. Связать cleanup
с record.resources и заменить голый boolean подтверждением через authoritative
cleanup service/receipt, привязанный к operation/generation/точному набору leases.
Действие без ресурсов по-прежнему может иметь scope:none.

### R2. Observer и native status требуют актуального подтверждения

Coverage с `startedAt:2099`, ready/input+focus/no-gaps сейчас разрешает restore.
Guard получает expected generations, interval/cursor взаимодействия и decision
time; coverage имеет подтверждённый covered-through watermark и конечный lag
budget. Нельзя требовать нового input event на тихом экране, но heartbeat
observer должен подтверждать непрерывность наблюдения.

Native status должен возвращать accepted/high-water fence и согласованные
execution/dispatch/held/cleanup dimensions. `finished + cleanup:complete +
heldCount:5` недопустим. Recovery старого ledger отдельно обозначает прежний
fence/generation; не выдавать его за текущий accepted fence. Unknown native
target не заменяется безусловным false/verified.

### R3. Ledger должен принимать нормальное удержание и проверять digest

Lead probe `tmp/contracts-review/second-probes.ts`:
`[KEY55 confirmed-down] → [KEY55 confirmed-down, KEY56 pending-down]`
отклоняется `validateLedgerTransition`. Это нормальный полный snapshot при
нажатии второй клавиши. Неизменённые entries сохраняются; разрешённые изменённые
переходы остаются строгими, потеря entries запрещена.

Новая sequence должна быть выше прежнего максимума. Проверять вычисленный
digest canonical snapshot bytes, а не только совпадение двух присланных hash
строк. Durable sink формирует подтверждённый digest/время ACK; формат canonical
bytes фиксируется для TS/native и тестируется.

### R4. Разделить цель захвата и цель взаимодействия

Display/layout composite не может одновременно иметь global observation target
как display и как конкретное окно/sheet под выбранной точкой. Нужны отдельные
capture target и interaction target. Авторизация точки связывает exact
interaction target с конкретными observationId/frameRef/region/точкой или
ограниченной областью и текущим hit/owner evidence. Proof одного кадра/точки
не переносится на другой кадр/точку только по совпадению window revision.

Снимок всего дисплея должен позволять выбрать точное существующее окно/меню
без потери адресации до display-level raw input. Pure geometry по-прежнему
не является authorizer. Это изменение общего контракта, не consumer-local обход.

### R5. Requested capture/read budgets должны проверяться в результате

`assertCaptureResultMatchesRequest` не проверяет requested maxWidth/maxHeight/
maxPixels/maxEncodedBytes/scale/cursor/clip/fullPage. Он принимает глобально
допустимый результат, даже если запрос ограничен одним пикселем/байтом.
Добавить effective capture policy/extent и проверку соответствия запросу.
Функция публикации bytes должна проверять linked publication/observation/header
до вызова publisher, а не только checksum отдельного header.

`read-dom,maxBytes:1` принимает accessibility representation с десятью байтами.
Проверять representation, реальный UTF-8/serialized-content byte budget,
console count/bytes и truncated semantics. Вкладка с правильным target ID
не делает неправильный вид/размер содержимого корректным ответом.

### R6. Native mapping и window evidence не могут быть несвязанными

Layout со своим runtime/native generation принимает вложенный foreign display
при том же topology revision. Проверять поколения всех displays и брать
nativeDisplayId из authoritative registry resolution, не из свободного поля
caller-а. Аналогично cgWindowId/PID должны соответствовать exact window proof.

Corroborated WindowRecord сейчас принимает pixel-ownership proof о чужом display.
Для mapping нужен cg-ax-correlation proof об этом window/current inventory.
Явно разделить advertised AX actions и разрешённые сейчас действия, чтобы
`actionability:unavailable` не разрешало `close`. New surface в результате
transition связывается с application/generations/owner исходной цели.

### R7. Лимиты JSON проверяются до рекурсивного обхода/разбора

`parseWireValue(z.unknown(), depth200)` сейчас проходит: общий boundary не имеет
depth budget, а native refine проверяет его уже после parsing. Для wire reader
нужны byte cap до JSON.parse и bounded depth traversal до Zod; defaults 1 MiB/32
с явным ограниченным profile override при необходимости. Boundary cases не
должны заканчиваться stack overflow или неограниченным выделением памяти.

Эта доработка ограничена перечисленными R1–R7. Ведущий усилил только
runtime/contracts-задачу до GPT-6 Astra/high после двух содержательных review,
чтобы закрыть общий блокирующий стык; остальные направления остаются на Sol.
