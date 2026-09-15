# Промежуточное сохранение computer use — 15 сентября 2026

Это WIP checkpoint исходников и проверок шести задач. Он сохраняет текущую
работу в Git и не является готовым выпуском или разрешением переключать
установленные сервисы. Все исполнители подтвердили остановку записи перед
созданием checkpoint.

## Состояние

- В локальную `main` включён `origin/main` на `614231e` через fast-forward:
  сохранены новые инструкции о единицах прокрутки и инцидентах ввода.
- Аудит, архитектура, матрица возможностей и координация сохранены отдельным
  коммитом `6dcfc95`.
- Этот checkpoint сохраняет shared contracts, Runtime, native C/Objective-C
  core и transport, Input/Screen/Chrome/Android/Window adapters, MCP foundation
  и tests. Package dependencies и lock-файл входят в тот же snapshot.
- Installed helper, сервисы и конфигурация Codex не переключались.

## Незавершённая переработка

`runtime/src/reservations.ts` содержит новый `BrowserLifetimeCoordinator`.
`runtime/src/core.ts` и два reservation test-файла ещё используют старый
`LifetimeReservationRegistry` и ручные reserve/release. Следующий шаг — связать
coordinator с настоящим journal/connect result и проверками до side effect,
затем заменить старые tests. Возврат к caller-owned operation/verifier ради
зелёной сборки запрещён принятой архитектурой.

Native session lifecycle также находится в работе: rotation разрешается только
после подтверждённого полного drain, сохранения terminal receipts и отсутствия
callbacks/in-flight/result borrowers. Последние изменения
`native/src/session-lifecycle.ts` и `NativeBrokerAdapter.sessionState` ещё не
прошли финальную приёмку и не подключены к работающему helper.

## Проверка именно этого snapshot

- `git diff --check`: pass.
- `bunx --no-install tsc --noEmit`: exit 2. Семь ошибок относятся к незавершённой
  замене reservation registry: отсутствует старый export в `runtime/src/core.ts`,
  шесть implicit-any параметров в двух старых reservation tests.
- Старые зелёные package checks в handoff-файлах относятся к указанным там
  этапам. Они не объявляются полным проходом текущего WIP.
- Системный clipboard test явно opt-in; общий live test suite не запускался.
  Исторический инцидент случайного clipboard-теста описан в
  [handoff Input](../workstreams/input.md).

## Дальнейшее сохранение

Ведущий фиксирует и отправляет каждый завершённый проверенный checkpoint.
При длительной переработке отдельный WIP checkpoint должен явно указывать
непройденные проверки и следующие шаги. Исполнители согласуют остановку записи
на время staging/commit; параллельные коммиты в общем checkout не выполняются.
