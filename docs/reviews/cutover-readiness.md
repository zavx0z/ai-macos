# Готовность удаления legacy source

Дата проверки: 15 сентября 2026 года.

Этот документ описывает состояние после installed cutover. Исторические сбои
и переход к постоянной подписи подробно зафиксированы в
[`startup-permissions-and-identity.md`](./startup-permissions-and-identity.md).

## Подтверждённый installed checkpoint

Установлен source commit `c671b7d` в подписанном `computer-use.app` с иконкой.
LaunchAgent запускает стабильный executable
`Application Support/ai-macos/runtime/computer-use.app/Contents/MacOS/computer-use`;
helper расположен внутри того же bundle в `Contents/Helpers/meta-input-helper`.

При приёмке в 18:02:23 installed runtime подтвердил все четыре права,
`startup.permissions.state: ready`, `observer.state: ready`, `viewReady: true`
и profile `desktop-browser-selected`. Installed launcher вернул каталог
`ai-macos-runtime-catalog` версии `0.4.0` с 36 tools. Диагностический client
выполнил только initialize, `tools/list` и passive `system_health`.

## Новый live recovery blocker

В 18:05:11 runtime был перезапущен через managed recovery. Root после
установки его не перезапускал. `launchctl` показал `runs: 2` и предыдущий
`last exit code: 0`.

Последующая проверка нашла durable restart receipt предыдущего epoch:
`state: restart-safe-quarantined`, `operationIds: []`, Native PID 89646 завершён
с exit code 75 в 18:05:10.971 UTC. Это подтверждает managed recovery после
завершения Native; конкретная ветвь exit 75 в старом релизе не логировалась.

Новый runtime epoch `a0a3…` сохранил все четыре grants, но observer prepare
завершился причиной `Observer index, identity или readiness недоступны`.
Admission осталась закрытой, поэтому catalog сократился до восьми
диагностических tools.

Resumed acceptance task уже достигла нового direct MCP runtime, то есть A43
подтвердила переключение на installed launcher. Полная A43 acceptance не
пройдена: после restart runtime не восстановил observer и основной каталог.
Этот recovery regression сейчас анализируют владельцы Native и Runtime.

Source checkpoint `f9925a1` добавил типизированную причину Native prepare,
ограниченные повторные попытки только после доказанного отсутствия незавершённого
observer и журнал lifecycle без пользовательского содержимого.

Попытка обновить работающий app выявила отдельную ошибку установщика.
В 21:43:57.049 по местному времени launchd отклонил bootstrap с внутренним
кодом 37 «Operation already in progress»; удаление старой службы завершилось
в 21:43:57.071. `bootout` вернулся раньше фактического удаления. Rollback
загрузил предыдущий `c671b7d`, и тот снова подтвердил права и observer ready.
До повторного обновления требуется проверка исчезновения exact службы и
прежних процессов; фиксированная задержка не заменяет это доказательство.

Для обычного нового окна выбран более простой контракт: полученное от
подписанного AX-источника событие с неизвестным target инвалидирует все views,
но само по себе не означает потерю событий. Существующий optional target
уже поддерживает это поведение. Настоящие ошибки подписки/последовательности
остаются fail-closed; новый supervisor или протокол смены epoch не вводятся.

Отдельно текущая root-задача сохраняет прежнее соединение package version
`0.3.0`. Его stale catalog не является причиной нового regression и не служит
evidence нового installed runtime.

## Решение по removal

Legacy source пока удалять нельзя. Installed cutover подтвердил Host wiring и
реальный запуск установленного приложения. Остаются независимые preconditions:

| Gate | Состояние | Требуемое закрытие |
| --- | --- | --- |
| A02 | Проверяется | Отдельные runtime/MCP subprocess checks принятого entrypoint |
| A31 | Проверяется | Private socket peer/token boundary без legacy transport |
| A43 | Достигнут новый runtime, acceptance failed | Observer и полный 36-tool catalog должны восстановиться после restart в новой Codex-задаче |
| Reverse imports | Требует повтора перед deletion delta | Ни один сохраняемый consumer не ссылается на удаляемый file или symbol |

Один diagnostic client не разрешает deletion. Успешная первоначальная приёмка
также не заменяет проверку startup recovery после самостоятельного restart.

## Stable app и legacy helper

Текущий runtime является реальным подписанным bundle, а не symlink на release:

- stable app: `Application Support/ai-macos/runtime/computer-use.app`;
- runtime: `Contents/MacOS/computer-use`;
- helper: `Contents/Helpers/meta-input-helper`;
- immutable release выбирается отдельным symlink `current`.

Старый source-controlled `input/bin/meta-input-helper` оставлен нетронутым. Он
не является stable TCC subject нового bundle. Будущая source-removal delta не
должна удалять или перезаписывать вложенный helper установленного приложения.

## Актуальность removal plan

`scripts/legacy-source-removal-plan.json` содержит 73 repository-relative
`deleteFiles`; повторный scan подтвердил существование всех 73 путей. Новые
Host, installer, signed bundle и launcher files не попали в delete scope.

Перед применением списка нужен новый symbol-level reverse import scan. Особенно
важны сохраняемые части смешанных modules: Chrome adapter dependencies и
Android target helpers.

## Что дальше

1. Исправить и проверить observer recovery после самостоятельного restart.
2. Повторить A43 в новой задаче: installed `0.4.0`, полный каталог и
   согласованный сценарий.
3. Закрыть A02 отдельными subprocess checks.
4. Закрыть A31 на private UDS peer/token boundary.
5. Повторить exact reverse-import scan и migration-before-delete checks.
6. Только после этих evidence сформировать одну reviewable deletion delta,
   обновить manifests и один раз перегенерировать `bun.lock`.
7. После удаления повторить source/full checks, installed doctor и fresh-task
   catalog verification.

До выполнения этих шагов removal plan остаётся планом с закрытым admission, а
не разрешением на удаление.

## Граница текущей проверки

В этом checkpoint выполнены только чтение source/reviews, проверка наличия
`deleteFiles` и актуализация документации. Live UI, services, installation,
keychain, permissions и legacy files не изменялись.
