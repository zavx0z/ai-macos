# Потребители старого REST-контура

Срез ведущего: 15 сентября 2026. Поиск выполнен только в канонических
репозиториях `/Users/zavx0z/repozitarium`. Архивный контур не читался.
Наличие ссылки в исходнике не доказывает, что потребитель сейчас работает.

| Потребитель | Найденная зависимость | Решение перед удалением старого API |
| --- | --- | --- |
| Codex, `~/.codex/config.toml`, `mcp_servers.ai-macos` | `mcp/src/launcher.ts`; env `INPUT_API`, `SCREEN_API`, `WINDOW_API` | Переключить launcher/config на thin MCP и private runtime; проверить tool call в задаче |
| ai-macos root scripts, package CLI, `.http`, API docs и skill | Порты 7878–7882, старые selectors и отдельные mutex/restore | Мигрировать поддерживаемые команды на runtime; удалить второй путь mutation |
| `interpreter/packages/browser-agent/src/meta-chrome.ts` | Экспортируемый REST client: `/session`, `/windows`, `/eval`, `/activate`; selector windowId/tabIndex | В просмотренном interpreter найдены export и tests, другие callers класса не найдены. Пакет принадлежит interpreter; требуется его миграция при использовании старого client |
| `demo/scripts/build-print-pdf.ts` | `package.json` script `print-pdf`, Chrome REST 7880 | Потребитель принадлежит demo; перед следующим использованием нужен новый browser adapter либо собственный специализированный CDP workflow |
| `demo/scripts/export-print-pdf.ts`, `demo/editor/dev/snap-run.ts` | Chrome REST capture/navigation | Аналогичная миграция в demo; новые runtime refs нельзя подменять URL/title |
| Storybook | Упоминания ai-macos в запретах и regression tests | Storybook владеет отдельным private CDP и не использует ai-macos как backend; менять его не требуется |
| task/archive docs в других canonical repos | Исторические ссылки | Не являются runtime callers; не переписывать историю |

## Граница обновления

Этот список не разрешает редактировать чужие репозитории и не означает,
что старые открытые REST listeners следует сохранять как постоянный fallback.
При переходе ai-macos на новый контракт в финальном отчёте указываются breaking
changes для найденных внешних скриптов. Старый API нельзя объявить совместимым,
если его selectors, authentication и resource ownership больше не поддерживаются.

Перед остановкой каждого действующего старого сервиса ведущий проверяет PID,
исполняемый файл, cwd и порт. Останавливаются только процессы самого ai-macos
из канонического checkout. Неназванные и архивные процессы не затрагиваются.
