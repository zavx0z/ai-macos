# Текущий статус computer use

Дата: 15 сентября 2026. Подтверждённый Git baseline: `8eabedf`, ветка `main`,
`origin/main` совпадал с ним в начале этого прохода. Текущий working tree содержит
следующий параллельный native/runtime этап; он не включён в принятые результаты
до отдельного review, tests и commit.

## Принятые source blocks

| Область | Подтверждённый результат | Git evidence |
| --- | --- | --- |
| Контракты и runtime core | Общие schemas, authenticated client lineage, leases/fences, journal/dedup, bounded cancellation, quarantine, recovery и retention | `f901082`, `2b724a4` и предшествующие C1/C2 commits |
| Runtime host и MCP | Private UDS, method registry, dynamic catalog, один immutable runtime/MCP executable, host crash/renewal/heartbeat и единый native observer | `cc8241c`, `8315c2e`, `0a27d81`, `a2fc466`, `4bd4c09`, `2d2c237`, `7678d60` |
| Native broker | Audit identity, framed command loop, AX-only identity, окна/ввод/permissions, observer targets, passive recovery и release live-owned input при потере parent ACK | `8eabedf`, `806a5b0`, `cc2fd8a`, `bedf0bf`, `13ae782`, `e39e7d4`, `abd965a`, `8741017` |
| Input | Observation-point authority, общий observer stream, physical budget после target proof и delivery probe в active executor | `1a28b2b`, `13e6640`, `a815fbc` |
| Capture | Desktop layout, binary transport, runtime observations и bounded cleanup | `06c613b` |
| Applications | Bundle resolution, exact lifecycle и сохранение позднего completion | `d8568a4`, `f2169c4` |
| Browser/device | Несколько configured Chrome profiles, exact target/resources и host shutdown recovery | `3ac1f57`, `877a011` |
| Installer | Immutable release, code identity, readiness config, drain/rollback и atomic failure recovery | `43ab9a6`, `73fc53a` |
| Acceptance | Real contracts/native/runtime/RuntimeHost→UDS→MCP probes, bounded runner, A01–A45 с `pass/fail/not-run` | `4fffcd6`, `e7c084a`, `c777397` |

Это source/test acceptance названных блоков. Она не подтверждает установленный
artifact, фактические macOS permissions, visual result или полный live workflow.

Последние принятые проверки ведущего:

- новый hub/long-stream slice: 12 tests, 40 assertions, TypeScript check pass;
- cleanup slice: 23 tests, 101 assertion.

## Что ещё не принято

- Actual production host binding полного native catalog, capture, observer,
  readiness, interaction и recovery продолжает собираться в dirty tree.
- Текущий установленный helper, LaunchAgent и Codex MCP configuration ещё не
  переключены на новый runtime комплект.
- Старые REST listeners и их restart/CLI paths ещё находятся в source; наличие
  нового UDS не удаляет обход автоматически.
- A02 требует настоящих concurrent runtime/MCP subprocesses, A31 — проверки
  peer identity/forged credential на private socket, A43 — вызова из свежей
  реальной задачи Codex.
- Полная live матрица окон, ввода, capture, Chrome и Android не выполнена.
- Механическая сборка AppKit fixture не является visual/AX/input acceptance.
- Пользователь запросил сравнить наш внешний API с Computer Use API
  Codex/ChatGPT и сначала оценить целесообразность перехода. Точный
  интерфейс найден в bundled `@oai/cua` 0.2.4 приложения
  `/Applications/ChatGPT.app` и зафиксирован в `docs/computer-use-api.md`.
  Владимир согласовал удобный слой поверх нашего runtime с точной адресацией;
  полный REPL отложен. Четыре design-трассы проверены, см.
  `docs/high-level-agent-api.md` и `docs/reviews/high-level-api-scenarios.md`.
  Начинается реализация привязок; AXPress и concurrent cancel/status остаются
  обязательными условиями полной приёмки.

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
7. Решения о внешнем API после сравнения вариантов и проверки выбранного
   интерфейса на сквозных сценариях.

## Эксплуатационные ограничения

До cutover продолжает действовать подключённый старый MCP/runtime contour.
Новые source capabilities не следует использовать как доказательство того, что
установленная задача Codex уже видит новый catalog. Live input, clipboard,
capture, browser, ADB и permission actions выполняет только root после отдельной
проверки текущих grants и точных targets.
