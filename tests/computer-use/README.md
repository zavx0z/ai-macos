# Приёмочный harness computer use

Этот каталог принадлежит acceptance-потоку и не объявляет собственный runtime
API. C2-проверки используют реальные публичные schemas из
`@meta/shared/contracts` и текущие C implementations `executor.c`, `registry.c`
и `ledger.c` через стабильный `META_NATIVE_ABI_VERSION=2`.
Межклиентский C2 subset использует public `@meta/runtime` и его настоящие
session, resource, journal, deadline и quarantine authorities.

Безопасный запуск:

```bash
bun test tests/computer-use
```

Native suite компилирует временный бинарник через `/usr/bin/clang`, подставляя
только callbacks event sink, target verifier, monotonic clock и ledger
persistence. Она не запускает установленный helper и не отправляет системные
события. Временный каталог удаляется после suite.

Тесты не обращаются к установленным сервисам, системному clipboard, Chrome,
ADB, Accessibility, Screen Recording и не выполняют permission workflow.

## Текущее SUT evidence

- A01: native handshake compatibility из package export.
- A04: target checkpoint текущего C executor перед следующим событием.
- A06–A10: cancel boundaries, held-input ledger, persistence/ACK failures,
  watchdog, recovery ledger и runtime/native fences текущего C executor/ledger.
- A11: public payload/error contract и runtime resumption/dedup.
- A16: реальный registry сохраняет ambiguous для двух AX-кандидатур и одного CG.
- A38: public adapter capability schema допускает недоступные optional adapters.
  Отдельное runtime assertion независимого запуска core ещё не добавлено.

Runtime integration дополнительно проверяет:

- A03/A05: два реальных runtime client sessions конкурируют за один
  `desktop-input`; resource не освобождается до cancel ACK.
- A11: lost reply, resumption, dedup той же operation, payload mismatch и
  отсутствие plaintext payload в journal record.
- A05/A42: deadline зависшего adapter bounded, unknown cleanup quarantines
  resource и не допускает новый dispatch.

`matrix.ts` перечисляет все A01–A45 и отдельно хранит фактически подключённое
SUT evidence. Наличие parser/native проверки не закрывает live или более высокий
integration level строки.

Reference `FixtureRuntimeHarness`, `FixtureNativeLedger` и security model
удалены. `FakeNativeEventSink` оставлен только как нижнеуровневый управляемый
dependency для будущего injected runtime/native driver.

## Ожидаемые следующие drivers

- A02: отдельные STDIO client processes над одним реальным runtime.
- Остаток A42: journal capacity/retention и restart persistence.
- A31: настоящий private UDS, peer identity и token boundary до executor.

До появления этих exports passing substitute model не добавляется.
