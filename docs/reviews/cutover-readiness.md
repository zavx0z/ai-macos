# Готовность финального cutover

Дата: 15 сентября 2026. Сначала выполнена проверка существующего
`scripts/legacy-source-removal-plan.json`, точек запуска и текущих импортов.
Затем добавлен явный профиль установки `desktop-browser-selected` и его тесты.
Установленная конфигурация и старые сервисы не изменялись.

Запрошенный baseline `ee370d7` присутствует в истории. Фактический HEAD во
время проверки — `7902d16`, который дополнительно содержит `check_input` и
обязательный recovery handshake. Текущий dirty native/runtime этап не считается
принятым только из-за наличия в working tree.

## Итог

Cutover пока **не готов**. Installer/runtime foundation и high-level source
существуют, но default installed profile, Host catalog и MCP launcher ещё не
соответствуют выбранному продукту. Удалять legacy source до устранения этих
стыков нельзя.

## Состояние removal plan

`scripts/legacy-source-removal-plan.json` структурно сохраняет полезный exact
список: все 73 `deleteFiles` сейчас существуют. Но metadata устарела:

- `generatedFromCommit` равен `8eabedf`, а не current accepted chain;
- state всё ещё содержит `api-decision`, хотя решение принято: high-level
  `targetId`/`elementId`, без full REPL;
- plan не учитывает новые high-level modules и выбранную замену
  `input.interaction` observation-bound guard-ом;
- применять список до root integration/installed verification по-прежнему
  нельзя.

JSON-план следует обновить root после P1 integration, но сам delete list сейчас
не требует механического расширения из-за новых runtime modules.

## Настоящие блокеры Host/readiness

| Блокер | Evidence | Требуемое закрытие |
| --- | --- | --- |
| High-level API не находится в production catalog | `runtime/src/host.ts` не вызывает `registerAgentMethods`, `registerAgentActionMethods` или `registerAgentAxMethods` | Подключить один lineage-local `AgentTargetRegistry`, registrars и их cleanup к RuntimeHost; проверить actual catalog/schema/calls |
| High-level pointer не объявляется Host | `runtime/src/host-capabilities.ts` не включает `input.pointer`/`input.drag` в `implementedNative`; текущий dirty `agent-view-guard` ещё не принят | Завершить observation-bound guard, затем объявлять pointer/drag только по фактической connected authority |
| Application lifecycle ещё не гарантирован installed profile | Host регистрирует application methods только если native handshake объявил `desktop.application.lifecycle`; end-to-end readiness остаётся pending | Подтвердить handshake capability, Host registration и application methods через aggregate integration |
| Default `full` требует сознательно deferred capability | `DEFAULT_FULL_CAPABILITIES` включает все IDs кроме Android/install, следовательно включает `input.interaction` | Добавлен отдельный `desktop-browser-selected`; до cutover root проверяет его против aggregate Host capabilities |
| Защита между действиями ещё не подключена | Native/runtime observation guard проходит интеграцию; сборка общего снимка уже принята в `ffbb784` | Проверить связку guard и Host до immutable build |

### Точное изменение readiness profile

Выбранный продукт не использует отдельную focus-session capability
`input.interaction`: действие охраняется свежим observation, единым observer и
target-bound input; автоматического восстановления прежнего focus нет.

Текущий выбор `--foundation` слишком слаб, а `full` семантически ложен, если
тихо исключить `input.interaction`. Поэтому installer получил явный profile
`desktop-browser-selected` со следующими свойствами:

1. `requiredCapabilities` перечисляет реально выбранные desktop/browser
   capabilities и не содержит `input.interaction`.
2. Plan/manifest/install result отдельно публикуют `deferredCapabilities`
   с `id: "input.interaction"` и причиной отложенной реализации focus session.
3. Неготовые `input.pointer`/`input.drag` и
   `desktop.application.lifecycle` нельзя переносить в deferred только ради
   установки: они входят в выбранный workflow и должны стать ready до cutover.
4. `readinessProfile:"full"` сохраняет прежнее строгое значение либо удаляется
   отдельным решением root; его нельзя использовать с неполным required set.
5. CLI требует `--desktop-browser-selected`; `--foundation` с ним
   взаимоисключающ. Release identity и strict manifest validation включают тот
   же exact required/deferred set. Doctor проверяет все required capabilities;
   deferred capability не выдаётся за ready.

Изменение реализовано только в installer source и fake-command tests. Install,
doctor реального runtime и profile acceptance ещё не выполнялись.

## Entry points и clean removal blockers

| Legacy target | Current blocker/reference | Когда можно удалить |
| --- | --- | --- |
| `mcp/src/launcher.ts`, `mcp/src/index.ts` | `mcp/package.json scripts.start` всё ещё запускает launcher; root `scripts.mcp` вызывает этот start | После переключения default MCP на installed immutable executable `--mcp`, fresh-task verification и отсутствия supported callers legacy MCP |
| Root `module`, `dev`, `dev:android`; package `start/dev/bin` | Manifests всё ещё рекламируют REST entrypoints | В одной manifest cutover delta после default MCP verification; затем один lockfile regeneration |
| Весь `window/**` | Runtime source не импортирует `@meta/window`, но `runtime/package.json` всё ещё содержит dependency; `screen/src/restore-focus.ts` импортирует `window/src/focus.ts` | Удалить runtime dependency и legacy screen restore chain в том же atomic source removal |
| Legacy screen files | Новый Host использует только `@meta/screen/adapter` и `@meta/screen/native-driver` | После capture aggregate pass; сохранить adapter/native-driver и их tests |
| Legacy input helper modules/source | Новый Host использует adapter/clipboard subpaths, но installer, source doctor и retirement tooling завязаны на стабильный `input/bin/meta-input-helper` path | После successful installer switch удалить старый tracked binary/source, но сохранить installer-managed stable pathname/TCC identity |
| `android/src/android.ts` | `android/src/adapter.ts` реально импортирует `selectCreatedTarget` | Сначала вынести helper в adapter-owned module и перевести tests; затем удалить legacy remainder |
| Chrome REST/CLI/session/process files | `chrome/src/adapter.ts` требует `cdp-mode.ts` и `wait-ready.ts`, но не REST entrypoint; CDP launch scripts имеют отдельный ownership вопрос | Сохранить adapter dependencies; удалить REST-only source после symbol reverse scan. CDP scripts — только после explicit endpoint ownership/migration |
| `scripts/legacy-services.ts` | Нужен как одноразовый exact retirement coordinator для listeners 7878–7882 до замены stable helper | Удалить последним после retirement receipt, successful install/doctor и подтверждённого отсутствия owned listeners |
| `.http`, legacy API docs/tests | Ещё описывают поддерживаемый REST workflow | Удалить вместе с source entrypoints после replacement coverage и fresh MCP verification |

Новых imports из accepted high-level modules в legacy files не обнаружено.
Главный обратный blocker наоборот: Host пока не импортирует high-level
registrars, поэтому удаление legacy MCP сейчас оставит установленному агенту
неполный catalog.

## Минимальный порядок root cutover

1. **Закрыть source gates.** Принять observation-bound guard/recovery changes;
   подключить high-level registrars; подтвердить pointer/drag и application
   lifecycle в aggregate Host integration.
2. **Проверить selected profile.** Installer уже формирует явный
   `desktop-browser-selected`, exact required/deferred sets и сохраняет их в
   release identity/manifest. `input.interaction` остаётся рекламируемо deferred;
   pointer/application lifecycle — обязательны и должны пройти aggregate Host.
3. **Подготовить clean immutable source и rollback.** Обновить removal-plan
   metadata, но legacy файлы пока не удалять. Зафиксировать старые source/config,
   stable helper и service state, необходимые для rollback. Запустить root
   source/type/acceptance и убедиться, что working tree clean.
4. **Собрать и проверить candidate без переключения.** `planRuntimeInstall` →
   review exact commit/build/profile/browser config; собрать и проверить
   signature/metadata immutable runtime/native candidate. Stable helper и
   LaunchAgent ещё не менять.
5. **Retire legacy parents до stable helper replacement.** Выпустить и повторно
   проверить exact service plan, затем завершить только owned listeners
   7878–7882 через `LegacyServiceRetirementCoordinator`. Старые REST parents не
   должны оставаться способными запустить новый helper через прежний stable path:
   новый broker несовместим со старым REST ABI. При foreign process, changed
   incarnation или unknown held input cutover останавливается, старый helper и
   config сохраняются.
6. **Применить install transaction.** Только после подтверждённого retirement
   выполнить `applyRuntimeInstall`: переключить stable helper/current/plist и
   загрузить единственный runtime. Если старый managed runtime был загружен,
   получить его exact admin drain до bootout. Rollback material старого
   source/config/helper сохраняется до successful doctor; failed doctor
   восстанавливает старый совместимый комплект, а не запускает старый REST с
   новым broker.
7. **Проверить установленный комплект до MCP switch.** Получить successful
   doctor с exact runtime/native build IDs, selected required capabilities,
   нулём active/quarantined/recovery blockers и совпадающими permissions/code
   identity. Это не live UI acceptance.
8. **Переключить default MCP launcher.** Codex config должен запускать
   установленный `current/runtime --mcp`, а не repository
   `bun run --cwd mcp start`.
9. **Проверить fresh task catalog.** Уже после default launcher switch в новой
   задаче подтвердить dynamic high-level schemas, health/build IDs и
   unavailable/deferred reporting.
10. **Удалить legacy source.** Применить актуализированный exact JSON plan:
   entrypoints/CLI/REST tests/docs, manifests и lockfile одним reviewable
   checkpoint. Stable helper pathname остаётся installer-owned. Retirement
   coordinator удалить последним после сохранённого receipt.
11. **Финальная проверка.** Source/full tests без skip evidence, absence public
   TCP/legacy restart paths, installed doctor, fresh MCP task. Live matrix и
   skill/API docs обновляет root отдельно по actual catalog.

## Remaining evidence

- Aggregate Host high-level pointer/application lifecycle integration: pending.
- Selected readiness profile source/fake-command tests: implemented; real
  plan/install/doctor acceptance not run.
- Installed immutable release/doctor: not run.
- Default Codex MCP switch and fresh task catalog: not run.
- Exact legacy listener retirement: not run.
- Legacy source deletion and post-removal reverse import/typecheck: not run.
- Live window/input/capture/browser/device matrix: not run.

Следовательно, правильный следующий шаг — не удаление файлов, а принятие
aggregate guard/Host binding и проверка selected profile на реальном
plan/install/doctor path.

## Проверки этого checkpoint

- `bun test scripts/runtime-install.test.ts` — 12 pass, 0 fail,
  73 assertions; только fake command/filesystem backend.
- `bunx --no-install tsc --noEmit` — exit 0.
- Install, LaunchAgent/default MCP switch, legacy retirement и live operations
  не выполнялись.
