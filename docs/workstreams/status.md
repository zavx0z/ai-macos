# Текущий статус computer use

Дата: 15 сентября 2026. Ведущий работает в каноническом checkout, ветка `main`.
Каждый принятый этап сохраняется отдельным коммитом и отправляется в `origin/main`.
Принятый этап исходного кода не означает готовность установленного продукта.

## Подтверждённые результаты

- Native transport: настоящий собранный helper вернул проверенную Darwin audit
  session; runtime выполнил с ним совместимый handshake. Проверка пассивная,
  без действий с окнами, вводом, снимками или clipboard.
- Динамический MCP-каталог приходит из RuntimeHost через аутентифицированный UDS.
  При недоступном runtime MCP оставляет только пассивную диагностику.
- Native transport поддерживает bounded clipboard JSON profile; тест с миллионом
  NUL-символов проходит через настоящий command loop с подставным clipboard.
- Runtime регистрирует точную личность AX-only окна независимо от CG mapping.
  Hidden window и sheet проверены через raw inventory и реальный evidence issuer.
  Для снимка окна по-прежнему требуется отдельное CG-AX подтверждение.
- Каталог окон и ввода передаёт точные refs, inventory и clientRequestId;
  runtime сам выдаёт ресурсы и fence. Потерянный ответ не повторяет действие.
- Приёмочный runner различает pass, fail и not-run. Отсутствующие live checks
  не становятся pass после зелёных unit tests.

## Работа владельцев

| Задача | Принято | Следующий результат |
| --- | --- | --- |
| Computer use: runtime, контракты и MCP | Core authorities, arbitration, continuation, browser lifetime; UDS host и динамический каталог | Durable recovery, bounded storage, admin drain, interaction, общий host wiring |
| Computer use: native broker и окна | Registry, exact identity, framed async key/text, audit identity, clipboard protocol | AX wiring, window transitions, pointer, observer/readiness, capture dispatch и приложения |
| Computer use: ввод и interaction | Input adapter, Unicode compiler, clipboard backend, методы каталога | Граничные бюджеты, readiness/interaction через runtime authority, live |
| Computer use: снимки и координаты | SCStream module, compositor, continuation/cleanup и capture adapter | Publication/commit через core, каталог и production wiring, live |
| Computer use: Chrome и Android | Concrete adapters, bounded CDP/ADB, lifetime recovery | Методы каталога, отмена и idempotent capture, host composition, live |
| Computer use: приёмочные проверки | Native/core fixtures, RuntimeHost → UDS → MCP isolation/catalog/drain | Process startup, durable restart, полная evidence matrix, live |

Ведущий проверяет архитектурные стыки, коммитит и отправляет принятые изменения.
Отдельный helper реализует installer с immutable releases, атомарным обновлением
и rollback; до приёмки он не изменяет действующий сервис.

## Последние проверки ведущего

- Native protocol + host + MCP: 43 tests, 168 assertions.
- AX identity + core + evidence contracts: 17 tests, 97 assertions.
- Каталог окон и ввода: 7 tests, 26 assertions.
- Host/MCP и runner: 5 tests, 25 assertions.
- AX inspector: 8 injected C/Objective-C cases; command loop и AX contract:
  13 tests, 43 assertions. Production AX context wiring ещё проверяется отдельно.
- Общий TypeScript check прошёл после каталога окон и ввода.

Это проверки названных коммитов; во время параллельной работы текущий dirty tree
может содержать следующий ещё не принятый этап.

## Эксплуатационный статус

Установленные сервисы, helper и конфигурация Codex ещё не переключены.
Текущий подключённый MCP остаётся 0.3.0. Финальная приёмка требует полного пути
`discovery → show → observation → input → outcome → recovery` через direct MCP,
включая существующий скрытый Chrome и несколько одноимённых процессов.

Случайный live clipboard test прежнего этапа восстановил текст в finally,
но сохранность прежних non-text formats неизвестна. Инцидент сообщён Владимиру;
live clipboard test теперь opt-in. Остальные проверки этой волны не используют
пользовательский clipboard и не вводят данные в приложения.
