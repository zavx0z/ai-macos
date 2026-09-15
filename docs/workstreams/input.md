# Input adapter

## Текущее состояние

Статус: C0 принят; C2 executable adapter checkpoint принят ведущим после
независимого review пяти найденных blockers и повторного safe-прогона.

Граница scoped acceptance: приняты injected Input/Clipboard contracts,
action compiler, authorization/preconditions, budget admission, status
correlation/redaction/reconciliation и fake outcomes. Дополнительно подтверждён
text cluster path через fake C sink. Не приняты этим этапом: реальный native
event backend, полный pointer/key/shortcut transport, runtime/MCP wiring,
versioned clipboard backend и любые live desktop/clipboard утверждения.

Новый `DesktopInputAdapter` импортируется без запуска listener и исполняет
действия только через injected C1 `NativeAdapter`. Он не владеет lease, journal,
interaction session, focus restore, fencing acceptance или held-input ledger.
Legacy REST/helper path сохранён до согласованного runtime cutover.

`SystemClipboardAdapter` также side-effect-free при import и требует отдельный
injected versioned backend. Действующий `pbpaste/pbcopy` не объявлен таким
backend: он не предоставляет достоверный системный `changeCount`.

## Native clipboard checkpoint

В новой согласованной owner-области реализован независимый модуль:

- `native/src/clipboard/meta_clipboard.h` — C ABI version/read/write результата;
- `native/src/clipboard/meta_clipboard.m` — реальный AppKit backend и чистая
  orchestration поверх injected callbacks;
- `native/src/clipboard/meta_clipboard_test.m` — только mock pasteboard, без
  чтения или записи системного clipboard.

Честная семантика: `NSPasteboard.changeCount` — счётчик смены ownership, пригодный
для сравнения наблюдений, но не глобальный межпроцессный CAS. `expectedChangeCount`
проверяется непосредственно перед mutation и может выявить уже случившийся
конфликт, но другое приложение всё ещё может вмешаться между check,
`clearContents` и `setString`. Поэтому write возвращает измеренные
`before/declared/after` counts и всегда `atomicPrecondition: false`.

- mismatch до clear → `PRECONDITION_MISMATCH`, `mutationAttempted: false`;
- `setString=false`, новый owner после clear или ошибка после начала mutation →
  `WRITE_PARTIAL_UNKNOWN`, без replay и обещания rollback;
- success допустим только при `setString=true` и `after == declared`;
- read возвращает текст только при одинаковом count до и после чтения;
- пустая строка отличается от отсутствующего text type;
- invalid UTF-8 и размер больше 1 000 000 bytes отклоняются до `clearContents`;
- result/error structs не содержат write payload.

После ABI review bounded-read исправлен до common wiring: backend callback
получает `maxBytes` и отдельно возвращает `OK / TEXT_UNAVAILABLE /
PAYLOAD_TOO_LARGE / FAILED`. Системный backend вызывает
`lengthOfBytesUsingEncoding` до `dataUsingEncoding` и malloc; oversized не
путается с отсутствующим text type или backend failure. Это ограничивает наши
дополнительные UTF-8 data/copy allocations, но не обещает ограничить внутреннее
получение `NSString` чужим OS IPC, для которого AppKit не даёт preallocation cap.

Safe compile/check:

```text
/usr/bin/clang -fobjc-arc -mmacosx-version-min=13.0 -Wall -Wextra -Werror \
  -Inative/src/clipboard native/src/clipboard/meta_clipboard.m \
  native/src/clipboard/meta_clipboard_test.m \
  -framework AppKit -framework Foundation -o <temporary>/meta-clipboard-test
<temporary>/meta-clipboard-test
clipboard module tests passed
```

Бинарник создавался в `mktemp -d /tmp/meta-clipboard-check.XXXXXX` и удалён.
Системный `NSPasteboard` backend не вызывался.

## Реализовано

- `input/src/action-plan.ts`:
  - budgets 5 секунд для pointer/key/shortcut, 30 секунд и 10 000 UTF-16 units
    для typing;
  - hover, click/right/double/triple click, explicit anchor scroll;
  - trajectory drag с integer duration, точным endpoint timestamp, button и
    canonical modifiers;
  - grapheme-safe Unicode schedule: emoji ZWJ и составные символы не дробятся;
    известные delays сверх budget отклоняются;
  - chunk target остаётся soft, hard native grapheme/payload limit проверяется
    отдельно до dispatch;
  - полная prevalidation key/shortcut sequence.
- `input/src/actions.ts` — input-owned Zod schemas публичных действий и metadata
  результата. Pointer payload не принимает proof от caller: authority находится
  в runtime operation context и stored observation resolver.
- `input/src/authorization.ts`:
  - C1 session/generation authorization;
  - exact active `desktop-input:desktop` resource;
  - exact target resolution по inventory/runtime/native generations;
  - обязательный `observationRef` для pointer;
  - runtime-owned stored observation resolution для каждой hover/click/scroll/
    drag point с `expectedSpace: macos-screen`;
  - typed pre-dispatch errors и cancellation checkpoints.
- `input/src/native-action.ts` — преобразование только `AuthorizedObservationPoint`
  в `@meta/native/protocol` scalar action. Raw point не принимается. Drag modifiers
  и trajectory не теряются; oversized grapheme отклоняется до native request.
- `input/src/adapter.ts`:
  - C1 `InputAdapter` поверх injected `NativeAdapter` и `input.execute`;
  - outer operation context не изменяется; отдельный `actionDeadlineAt` равен
    меньшему из operation deadline и input budget;
  - inline `NativeOperationStatus` коррелируется native schema;
  - inline и reconciled status дополнительно связаны с exact operation/fence
    через `nativeStatusMatchesOperation`; substituted fence/generation даёт
    unknown/quarantine без публикации недоверенного status;
  - при transport/error выполняется bounded status reconciliation;
  - `dispatch:none` до request, `partial`, `in-progress`, `cancelled`, physical
    cleanup и `interrupted/unknown` различаются;
  - active/unknown native execution не освобождает desktop lease, а возвращает
    quarantined cleanup partition для runtime finalization;
  - full correlated `nativeStatus` сохраняется в обеих ветвях AdapterResult;
  - text payload отсутствует в публичном result; structured response errors,
    inline/reconciled status errors и transport errors проходят redaction;
  - pre-action observation authorization не объявляется post-action readback:
    outcome остаётся `observation: unavailable` до отдельного наблюдения.
- `input/src/clipboard-adapter.ts`:
  - отдельные explicit read/write/version операции;
  - exact `clipboard:system` resource и generation/session checks;
  - write expected-version передаётся backend атомарно;
  - UTF-8 byte budget; write payload отсутствует в result/error;
  - неизвестный write outcome запрещает replay и quarantines resource.
- `input/tests/clipboard.test.ts` теперь live opt-in только при
  `AI_MACOS_LIVE_CLIPBOARD=true`; по умолчанию системный clipboard не читается и
  не изменяется. Gate проверяется на fake environment.

## Paths и exports

- `@meta/input/adapter` → `input/src/adapter.ts`
- `@meta/input/action-plan` → `input/src/action-plan.ts`
- `@meta/input/actions` → `input/src/actions.ts`
- `@meta/input/authorization` → `input/src/authorization.ts`
- `@meta/input/native-action` → `input/src/native-action.ts`
- `@meta/input/clipboard-adapter` → `input/src/clipboard-adapter.ts`

`input/package.json` добавляет dependency `@meta/native: workspace:*`; ведущий
добавил native в root workspaces и обновил lock. Других root manifest изменений
от input-задачи нет.

После публикации `AdapterServices.reservations` input-owned fixtures получили
только throwing `assertChild` stubs. Они не имитируют успешную lifetime
reservation и не создают локальную authority.

## Безопасные проверки

Явный allowlist без системного clipboard:

```text
bun test input/tests/adapter.test.ts input/tests/action-plan.test.ts \
  input/tests/authorization.test.ts input/tests/native-action.test.ts \
  input/tests/clipboard-adapter.test.ts input/tests/keys.test.ts \
  input/tests/window-selector.test.ts input/tests/clipboard-live-gate.test.ts \
  input/tests/native-integration.test.ts
55 pass, 0 fail

bunx --no-install tsc --noEmit -p input/tsconfig.json
exit 0
```

Gate отдельно проверен без live clipboard:

```text
AI_MACOS_LIVE_CLIPBOARD=false bun test \
  input/tests/clipboard-live-gate.test.ts input/tests/clipboard.test.ts
2 pass, 1 skip, 0 fail
```

Fake lower layer покрывает: cancel до native request; cancel во время request с
correlated status; потерю request и status; active dispatch после transport
timeout; partial inline result; short/typing action deadlines; hard oversized
grapheme; отсутствие text/clipboard write payload в AdapterResult, даже если
ошибка lower layer попыталась включить payload в свой message; substituted
target/point/observation/generation/fence; known-duration admission против
остатка operation budget; отсутствие ложного post-action observation outcome.

Дополнительный `input/tests/native-integration.test.ts` компилирует во временный
каталог безопасный native broker fixture с fake event sink и проходит полный
путь `DesktopInputAdapter → NativeBrokerAdapter → framed protocol → C text
cluster bridge/executor`. Для `Aя👩‍💻é` подтверждены четыре готовых grapheme
clusters, четыре native dispatch attempts, complete cleanup и отсутствие текста
в AdapterResult. Fixture использует новый handshake-bound constructor
`{adapterInstanceRef, bindEvidence}` и проверяет, что binder получает фактические
`loadedBuildId` и `NativeGeneration`, а не заранее придуманный build. Установленный
helper и системный ввод не используются.

## Инцидент проверки clipboard

Во время C2 была ошибочно выполнена команда `bun test input/tests`. Она включила
старый `input/tests/clipboard.test.ts`, который вызвал реальные `pbpaste/pbcopy`:
сохранил текущий текст, записал временный marker, проверил его и в `finally`
восстановил сохранённый текст. Тест завершился успешно, поэтому текстовое
содержимое было восстановлено. Однако `pbcopy` мог удалить прежние non-text
pasteboard formats; их исходное состояние неизвестно и полный rollback не
заявляется. После инцидента clipboard не читался и не изменялся; добавлен opt-in
gate, дальнейшие прогоны используют только явный safe allowlist.

## Acceptance по границе

- A03/A05/A42: input не создаёт scheduler; fake status подтверждает, что active,
  lost или unknown dispatch не освобождает resource и не разрешает blind replay.
  Полная двухклиентная сериализация остаётся runtime acceptance.
- A04: target+fence остаются внутри immutable native operation envelope;
  точные target/observation proofs разрешаются до request, native выполняет свои
  checkpoints. Live focus steal остаётся C3.
- A06: cancel на последнем adapter checkpoint до request даёт `dispatch:none`.
- A07–A10: full native status/cleanup сохраняется для reconciliation; ledger и
  bounded matching up исполняет native-owner.
- A11: native request/response/status correlation проверена; runtime journal
  отвечает за clientRequestId dedup.
- A12/A13/A20/A44: observer, interaction session, restore и lifecycle revocation
  остаются runtime/native owners; input не создаёт второй owner.
- A27: Unicode/grapheme/delay/hard-limit fixtures закрыты; native cancellation
  между clusters и live RU/EN остаются C3. Input передаёт единственный готовый
  `plan.schedule` как `clusters[{text,utf16Units,atMs}]` без повторной сегментации.
- A28: explicit anchor, authorized macOS points, trajectory и modifiers покрыты;
  попадание в реальный nested pane/canvas остаётся live acceptance.
- A32: InputAdapter не открывает Settings и не подменяет passive permission
  активной readiness; отдельный readiness execution остаётся native/runtime.

## Неразрешённые стыки

1. В runtime/MCP ещё не подключён `DesktopInputAdapter`; это runtime-owner.
2. `@meta/native` transport/executor должен реализовать импортируемый
   `input.execute` для остальных pointer/key/shortcut действий целиком. Text
   cluster path уже подтверждён fake end-to-end integration; input не реализует
   transport или ledger.
3. Реального versioned clipboard backend с системным `changeCount` пока нет.
   Legacy `pbpaste/pbcopy` нельзя выдать за этот контракт.
4. `input.readiness` не объявляется реализованной данным adapter: passive/active
   probe и permission state принадлежат native/runtime.
5. Legacy wildcard HTTP routes, mutating GET и raw global input удаляются только
   после runtime cutover и caller inventory; самостоятельный auth protocol в
   input не добавлялся.

## Следующий шаг

Следующий межвладельческий шаг — runtime подключает принятый InputAdapter, а
native-owner завершает остальные `input.execute` действия и fake integration.
После этого ведущий выполняет runtime/MCP cutover и C3 acceptance. Live
input/capture/clipboard и service restart выполняет только ведущий после
отдельной проверки условий.
