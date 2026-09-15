# Текущий статус computer use

Дата: 15 сентября 2026. Подтверждённый Git baseline: `2be38e1`, ветка `main`,
`origin/main` совпадал с ним в начале этого прохода. Текущий working tree содержит
следующий параллельный native/runtime этап; он не включён в принятые результаты
до отдельного review, tests и commit.

## Принятые source blocks

| Область | Подтверждённый результат | Git evidence |
| --- | --- | --- |
| Контракты и runtime core | Общие schemas, authenticated client lineage, leases/fences, journal/dedup, bounded cancellation, quarantine, recovery и retention | `f901082`, `2b724a4` и предшествующие C1/C2 commits |
| Runtime host и MCP | Private UDS, method registry, dynamic catalog, один immutable runtime/MCP executable, host crash/renewal/heartbeat и единый native observer | `cc8241c`, `8315c2e`, `0a27d81`, `a2fc466`, `4bd4c09`, `2d2c237`, `7678d60` |
| High-level agent API | Lineage-local `targetId`/`elementId`, observe/status/cancel, короткие input actions и полная диагностика окон реализованы и проверены на уровне source modules | `2798c3d`, `34f5394`, `cb97922` |
| Native broker | Audit identity, framed command loop, окна/ввод/permissions, observer targets, passive recovery, AXPress, retained AX snapshot и cursor display | `2be38e1`, `c31909a`, `8eabedf`, `806a5b0`, `cc2fd8a`, `bedf0bf`, `13ae782`, `e39e7d4`, `abd965a`, `8741017` |
| Input/readiness | Observation-point authority, общий observer stream, delivery probe в active executor и runtime-bound active readiness | `ebf1a84`, `1a28b2b`, `13e6640`, `a815fbc` |
| Capture | Desktop layout, binary transport, runtime observations, evidence publication и подтверждённое release | `e7b54ba`, `06c613b` |
| Applications | Bundle resolution, exact lifecycle и сохранение позднего completion | `d8568a4`, `f2169c4` |
| Browser/device | Несколько configured Chrome profiles, exact target/resources и host shutdown recovery | `3ac1f57`, `877a011` |
| Installer | Immutable release, code identity, readiness config, drain/rollback и atomic failure recovery | `43ab9a6`, `73fc53a` |
| Acceptance | Real contracts/native/runtime/RuntimeHost→UDS→MCP probes, bounded runner, A01–A45 с `pass/fail/not-run` | `4fffcd6`, `e7c084a`, `c777397` |

Это source/test acceptance названных блоков. Она не подтверждает установленный
artifact, фактические macOS permissions, visual result или полный live workflow.

Каждый checkpoint прошёл свою owner/root проверку. Числа test suites здесь не
суммируются: несколько acceptance команд пересекаются по одним и тем же tests,
а арифметическая сумма создала бы ложный aggregate.

## Что ещё не принято

- High-level methods ещё не подключены к production RuntimeHost/MCP catalog.
  Их source tests не являются фактическим вызовом из текущей задачи Codex.
- Сборка общего снимка нескольких экранов проходит проверку ведущего после
  исправления гонки при запуске отдельных захватов. Интеграция observation
  guard и восстановления после сбоя ещё не завершена.
- `RecoveryDomain` и restart-quarantine integration находятся в текущем dirty
  tree как WIP; они не активированы, не приняты и не входят в baseline.
- Текущий установленный helper, LaunchAgent и Codex MCP configuration ещё не
  переключены на новый runtime комплект.
- Старые REST listeners и их restart/CLI paths ещё находятся в source; наличие
  нового UDS не удаляет обход автоматически.
- A02 требует настоящих concurrent runtime/MCP subprocesses, A31 — проверки
  peer identity/forged credential на private socket, A43 — вызова из свежей
  реальной задачи Codex.
- Полная live матрица окон, ввода, capture, Chrome и Android не выполнена.
- Механическая сборка AppKit fixture не является visual/AX/input acceptance.
- Решение по внешнему API принято: удобный слой поверх runtime использует opaque
  `targetId`, snapshot-bound `elementId`, точную адресацию и не включает полный
  REPL. Design и source implementation существуют, включая AXPress и
  concurrent cancel/status. Остаются Host binding, contract/integration
  validation и live acceptance; source presence не означает установленный API.

## Граница готовности

Текущий статус: **accepted source blocks, pre-cutover**. Нельзя заявлять
`desktop.core full`, `browser.chrome full`, installed readiness или M7 complete.
Финальный переход допустим только после:

1. Полного RuntimeHost/native method binding и зелёного root integration.
2. Установки одного совместимого runtime/native release и exact doctor receipt.
3. Миграции актуальных callers из `docs/legacy-callers.md`.
4. Exact retirement собственных listeners 7878–7882 без воздействия на чужие
   или архивные процессы.
5. Удаления legacy entrypoints/CLI/bootstrap по
   `scripts/legacy-source-removal-plan.json`.
6. Повторного source/full acceptance и обязательной live-проверки root.
7. Contract/integration validation и production Host/MCP wiring уже выбранного
   high-level API; повторное решение о направлении не требуется.

## Эксплуатационные ограничения

До cutover продолжает действовать подключённый MCP 0.3.0 и старый runtime
contour.
Новые source capabilities не следует использовать как доказательство того, что
установленная задача Codex уже видит новый catalog. Live input, clipboard,
capture, browser, ADB и permission actions выполняет только root после отдельной
проверки текущих grants и точных targets.
