# Handoff: приёмочные проверки computer use

## Текущее состояние

C1 package contract подключён. C2 acceptance частично готов:

- public `@meta/shared/contracts` проверяется через package resolution;
- текущие `native/src/executor.c`, `registry.c` и `ledger.c` проверяются
  временным C binary с injected backend;
- reference Runtime/Ledger/security models удалены из acceptance path;
- обе ветви обязательного A08 persistence regression проходят на реальном
  executor.
- public `@meta/runtime` проверяется in-process через реальные client sessions,
  resource registry, operation journal, deadlines и quarantine.

Fixture обновлён на стабильный `META_NATIVE_ABI_VERSION=2`: persistence проходит
через `MetaLedgerPersistenceRequest/Ack` с реальным snapshot digest, checkpoint
получает stage, epoch/fence содержат login session, target verification является
tri-state, recovery ledger читается через отдельный status.

Ведущий просмотрел injected runtime chain и независимо повторил полный
acceptance-прогон: bounded in-process Runtime subset принят.

Статус: **real-contract passed / real-native ABI v2 passed / runtime core C2
subset accepted / RuntimeHost-UDS-dynamic-MCP subset passed / full catalog,
security and durable restart pending**.

## Реализовано

- `tests/computer-use/contracts-sut.test.ts` — прямые parser/compatibility
  проверки package export для частей A01, A08, A10, A11 и A38.
- `tests/computer-use/native/native_sut_fixture.c` — один driver реальных C
  executor/registry/ledger APIs. Injected callbacks заменяют только внешний
  event target, clock и persistence, а не проверяемую state machine.
- `tests/computer-use/native-sut.test.ts` — безопасная compilation во временный
  binary и запуск A04, A06–A10, A16 cases.
- `tests/computer-use/runtime-sut.test.ts` — два bounded integration scenarios
  реального `RuntimeCore` с injected Native adapter boundary и настоящими
  session/resource authorities.
- `tests/computer-use/host-mcp-sut.test.ts` — текущий реальный
  `RuntimeHost → UDS → dynamic MCP` path с двумя client lineages, scoped frame,
  unavailable capability gate, native disconnect/catalogChanged и bounded drain.
- `tests/computer-use/profile-runner.ts` — executable safe profile A01–A45 с
  evidence refs, missing evidence и честными `pass/fail/not-run`.
- `tests/computer-use/profile-runner.test.ts` — защита от fiction pass и
  проверка распространения реального probe failure.
- `tests/computer-use/matrix.ts` — все A01–A45 и отдельный реестр реально
  подключённого `contract-parser`/`native-c` evidence.
- `tests/computer-use/matrix.test.ts` — A02/A31 явно не получают evidence от
  прежних reference-моделей.
- `tests/computer-use/fixtures/native-event-sink.ts` — сохранён как
  нижнеуровневый fault-injection dependency; сейчас не считается SUT evidence.

Удалены reference tests/models:

- `runtime-regressions.test.ts`
- `native-regressions.test.ts`
- `boundary-regressions.test.ts`
- `fixtures/runtime-harness.ts`
- `fixtures/native-ledger.ts`
- `fixtures/boundaries.ts`

## Реальное SUT evidence

Package contract suite: 8 tests pass плюс отдельная проверка package export.

Native C suite: 11 из 11 scenarios pass:

- A04 target checkpoint и bounded release;
- A06 cancel до первого event;
- A07 cancel после confirmed down и matching up;
- A08 lost ACK после фактического down → unknown/quarantine/no replay;
- A08 разовый сбой persistence второго down → ровно matching up первой
  клавиши, released ledger, complete cleanup и разрешённая новая operation;
- A08 продолжающийся сбой persistence во время cleanup → uncertain hold,
  unknown cleanup, quarantine и запрещённый begin;
- A09 watchdog и durable recovery ledger без blind event;
- A10 same-epoch counter и stale runtime/native generations;
- A16 2 AX → 1 CG остаётся ambiguous.

Runtime core suite: 2 integration scenarios pass:

- A03/A05/A11: первый client держит `desktop-input`; второй client получает
  conflict до disconnect и повторно до cancel ACK. После ACK resumption с тем же
  principal/request/payload возвращает ту же operation без второго dispatch;
  другой payload получает `request-payload-mismatch`; plaintext отсутствует в
  journal record. После confirmed cleanup новый запрос второго client проходит.
- A05/A42: runtime deadline прерывает зависший adapter за bounded grace,
  запрашивает native cancel, сохраняет `interrupted-unknown`, unknown cleanup и
  quarantined resource; следующий client не достигает dispatch. Plaintext
  request в operation journal record отсутствует.

Это in-process evidence A03, а не A02: отдельных MCP/STDIO процессов suite не
создаёт. Это также не A31: private UDS/auth boundary здесь не проверяется.

RuntimeHost/UDS/MCP suite: 3 integration scenarios pass:

- два отдельных RuntimeUdsClient + MCP Client проходят через один actual host;
  frame image получает только выдавшая client lineage, другая получает 404;
- method с unavailable `browser.instances` не рекламируется и не достигает
  executor при прямом MCP call;
- injected native disconnect убирает `list_windows`, вызывает реальное MCP
  `tools/list_changed`, последующий call не достигает native transport;
- host drain получает correlated native ACK, укладывается в 500 мс, закрывает
  dynamic admission/list_windows и оставляет `system_health`.

MCP transport здесь настоящий по request path, но server/client соединены
InMemoryTransport внутри test process. Поэтому A02 process startup и A31
cross-user/forged-socket security не закрыты. `createRuntimeMcpServer`
импортируется из текущего owner source, поскольку `@meta/mcp` не публикует
package export для test factory.

Executable profile запускает четыре safe SUT probes. Текущий результат:
7 pass, 0 fail, 38 not-run. Полностью зелёные строки текущего профиля: A03,
A06, A08, A09, A10, A11, A38. Для остальных partial refs сохраняются, но
missing live/transport/durable evidence не превращается в pass.

## Проверки

- `bun test tests/computer-use` — 30 pass, 0 fail, 81 assertions. Compilation C
  binary с `-Wall -Wextra -Werror` успешна.
- `bun tests/computer-use/profile-runner.ts` — 7 pass, 0 fail, 38 not-run;
  четыре probe commands завершились успешно.
- Targeted TypeScript acceptance check — exit 0.
- Root typecheck по указанию ведущего повторно не запускался; Android сейчас
  редактирует его владелец.
- Live input/capture/clipboard/browser/ADB/bootstrap и permissions не вызывались.

## Manifest

Изменения не требуются. Acceptance-задача manifests/lock/config не меняла.
Package export `@meta/shared/contracts` используется из dependency context
`@meta/runtime`; относительного импорта к `shared/src` нет.

## Remaining prerequisites

1. A02 требует отдельных STDIO client processes и concurrent host startup над
   одним runtime/helper; два MCP connections in-memory это не заменяют.
2. A31 требует настоящего private UDS, peer identity и token verification до
   production executor.
3. Fresh MCP client lineage и frame authority через actual UDS проверены, но
   reconnect отдельного STDIO process и client-live из настоящей задачи для A43
   остаются открытыми.
4. A05 actual UDS timeout/cancel ещё требует отдельного fault driver;
   текущий evidence проверяет runtime deadline/hung adapter и удержание resource
   до cancel ACK/quarantine.
5. A42 durable journal restart, capacity/retention и bounded pruning ещё не
   проверены этим in-process subset.
6. Live части A01/A04/A07/A16 и остальная live matrix остаются за C3/C4 и не
   закрываются native binary или parser tests.

## Следующий шаг

Следующий checkpoint: отдельные process/UDS drivers непосредственно над SUT для
A02/A31 и transport-части A05 после owner fixes, затем полный native
catalog/capture. Не восстанавливать reference Runtime/Ledger/security models.
A42 расширять только через настоящую retention/persistence поверхность.

## UI fixture checkpoint

Подготовлена минимальная AppKit application для будущей live-приёмки root:

- `tests/computer-use/fixtures/app/main.m`
- `tests/computer-use/fixtures/app/README.md`

Fixture создаёт одну application с двумя окнами одинакового title и разными
stable accessibility identifiers, editable NSTextView с RU/EN/emoji/composed
text, button, bounded scroll area, slider и owned sheet без persistence. Secondary
window можно закрыть и воссоздать с тем же semantic identifier для проверки
новой OS instance identity. Обычные AppKit hide/minimize/move/resize/close
actions остаются доступными.

Опциональный `--test-hook` принимает только read-only JSONL `state` requests по
stdin и выдаёт bounded structured state/events в stdout. Он не выполняет UI
mutations, не адресует чужие приложения и не является вторым computer-use
backend. Payload ограничен 4096 bytes, text — 2048 UTF-16 units, stdout — 1024
envelopes на process.

Compile check выполнен без запуска binary:

```text
/usr/bin/clang -fobjc-arc -mmacosx-version-min=13.0 \
  -Wall -Wextra -Werror -framework AppKit -framework Foundation \
  tests/computer-use/fixtures/app/main.m -o <temporary>/ComputerUseFixture
file: Mach-O 64-bit executable x86_64
```

Временный binary и каталог удалены. NSApplication/окна не запускались; live
input/capture/clipboard/browser/ADB/permissions не выполнялись. README содержит
честный mapping A14–A29: какие assertions даёт эта UI fixture, какие требуют
native/capture fault driver и какие не покрыты. Compile не считается visual,
AX/CG или input-routing acceptance.
