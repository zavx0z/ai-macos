# Проверка high-level computer use interface на четырёх сценариях

Дата: 15 сентября 2026. Статус: **design candidate принят, implementation не
начата**. Приняты opaque `targetId` и snapshot-bound `elementId`, полный REPL не
входит в направление. Точные production schemas ещё требуют owner review.
Facade и runtime code этим проходом не создаются.
Проверяемый candidate: `docs/high-level-agent-api.md`.

Итог четырёх traces: hidden-window, exact browser profile/target и concurrent
cancel интерфейсно реализуемы поверх текущего runtime при добавлении
lineage-local handle registry/facade coordination. AX element mutation имеет
настоящий backend feature gap: inspect уже есть, AXPress/action ещё нет. Поэтому
candidate пригоден как направление, но не готов к реализации целиком до решения
этого owner gap и проверки cancel/handle lifecycle tests.
Все verdicts ниже относятся к design/schema composition, а не к фактически
прошедшему high-level behavior или live acceptance.

## Проверенное текущее основание

Текущий model-visible catalog собран из:

- `runtime/src/window-methods.ts`: `list_windows`, `window_transition`,
  `inspect_accessibility`;
- `runtime/src/input-methods.ts`: `mouse_move`, `mouse_click`, `mouse_scroll`,
  `mouse_drag`, `keyboard_type`, `keyboard_key`, `keyboard_shortcut`;
- `runtime/src/browser-methods.ts`: browser instances/targets/operation,
  reservation/resume/recover;
- `runtime/src/host.ts`: `get_operation`, `cancel_operation` и health;
- соответствующих window/input/browser tests.

Текущий runtime корректно владеет generations, inventory, observations,
evidence, resources, fences и operation journal. Проблема интерфейса не в этих
проверках, а в том, что их внутренние DTO сейчас частично видит и должен
компоновать агент.

## Предлагаемая граница

Facade выдаёт `targetId` — opaque handle текущей authenticated client lineage.
Handle может обозначать application window, sheet, configured browser instance
или exact browser tab. AX element получает отдельный opaque `elementId`,
подчинённый target и snapshot. Runtime хранит полные refs и authority metadata
за facade.

Обязательные правила:

1. `get_state` возвращает handles и достаточные metadata для выбора: kind,
   title, application, PID, hidden/minimized, browser profile. Он не выбирает
   первое окно и не требует отдельного bind call.
2. После runtime/native epoch change, close/reopen, replacement identity или
   обычного binding expiry старый handle не разрешает новую mutation/observation.
   Новый `get_state` не перенаправляет его на окно с тем же title. При этом
   lineage-scoped tombstone сохраняет bounded права cancel/status для уже
   admitted/queued operations; close или expiry не стирают cleanup evidence.
3. `get_state` не подключает все Chrome profiles и не создаёт ADB forward.
   `get_tabs({browserId})` получает targets только выбранного явно
   configured browser и управляет его reservation внутри runtime.
4. `observe({targetId, mode: "ax" | "screenshot" | "both"})` использует тот же
   handle. Возвращённые AX elements получают lineage-local `elementId`,
   привязанные к этому target и snapshot.
5. `show_window({targetId})` работает только с exact существующим native window,
   повторно проверяет свежий AX target и не запускает browser/application.
6. `click`, `type_text`, `press_key`, `scroll`, `drag` принимают `targetId` и
   простое действие. Semantic click получает отдельный opaque `elementId`,
   связанный с последним AX snapshot того же target; это не новый target и не
   числовой индекс. Inventory, observation, evidence, lease и fence создаёт и
   проверяет runtime.
7. Agent не передаёт `clientRequestId`, generations, inventory IDs/revisions,
   observation/evidence refs или fence.
8. Facade регистрирует внутреннюю operation до ожидания backend. Пока action call
   pending, `cancel_target({targetId})` отменяет только active/queued actions той
   же lineage и target и возвращает cleanup receipt.
9. При lost reply `get_target_status({targetId})` возвращает bounded active,
   queued и recent terminal status для этой lineage. Action автоматически не
   повторяется. Internal operation IDs остаются optional diagnostics после
   завершения, а не условием cancel. После runtime restart facade использует
   durable operation identity и поддерживаемый recovery path, но никогда не
   ретаргетит tombstone на похожую новую цель.

Согласованный design-набор имён:

| Область | Методы |
| --- | --- |
| Discovery | `get_state`, `get_tabs` |
| Observation | `observe` |
| Window | `show_window` |
| Actions | `click`, `type_text`, `press_key`, `scroll`, `drag` |
| Control/recovery | `cancel_target`, `get_target_status`; существующий `get_operation` остаётся optional diagnostics |

### Требуемая server-side binding metadata

| Public handle/call | Скрытая authoritative связь |
| --- | --- |
| Window `targetId` | Client lineage, runtime/login/native generations, application/window identity, current inventory revision, expiry/closed tombstone |
| Browser `targetId` | Client lineage, configured profile/endpoint identity, browser instance ref и current transport generation; без автоматического connect при `get_state` |
| Tab `targetId` | Parent browser handle/reservation, exact CDP target ID, target resource ref и transport generation |
| `observe` | Exact target handle, observation/frame или AX snapshot, freshness, bounds/coordinate transform и proof refs |
| `elementId` | Parent target handle, exact AX `ElementRef`, snapshot ID, advertised actions и expiry |
| Action admission | Target binding, internal client request ID, operation ID, resource lease, observation/element proof, fence и deadline до backend await |
| `cancel_target` / `get_target_status` | Индекс active/queued/recent operations только по той же lineage и target, с bounded retention и cleanup outcomes |

### Результат проверки candidate

| Сценарий | Вердикт | Недостающая реализация |
| --- | --- | --- |
| Hidden Chrome | Интерфейс подходит | Lineage-local handle registry и facade mapping к exact `window_transition` |
| Одинаковый URL в двух profiles | Интерфейс подходит условно | `get_tabs` обязан явно резервировать только выбранный configured browser и вернуть новый current target handle |
| AX element action | Заблокирован backend gap | Native AXPress/action, runtime element authority и readback; pointer center запрещён |
| Cancel pending input | Интерфейс подходит условно | Admission index до backend await, target-scoped cancel queued/active calls и lost-reply status |

## Измерение fixture payloads

Скрипт `tests/computer-use/design/high-level-api-payloads.ts` проверяет raw
current payloads действующими Zod schemas, но измеряет исходные supplied JSON
objects, а не результат parse с добавленными defaults. Proposed payloads проверяются только как
JSON design fixtures: в них нет internal generation/inventory/fence/proof/
observation fields. Это не production facade schema.

Размер — UTF-8 bytes compact JSON envelope `{method,arguments}` только для
requests. Variable responses, изображения и AX tree не учитываются.

| Сценарий | Current calls / bytes | Proposed calls / bytes | Изменение |
| --- | ---: | ---: | ---: |
| Hidden Chrome | 2 / 424 | 2 / 148 | Та же последовательность, internal ref скрыт |
| Два profiles, одинаковый URL | 4 / 1899 | 3 / 202 | Одинаковая read-only AX задача, нет agent-authored intent/resources |
| AX element action | 2 / 446, blocked до action | 3 / 261 design fixture | Не является сравнением завершённых flows |
| Cancel input | 3 / 622, blocked pending ID | 3 / 303 design fixture | Cancel должен работать во время pending call |
| Lost-reply recovery cancel case | Нет надёжного target-only вызова | +1 / 80 | `get_target_status`, без replay |

Это измерение формы интерфейса, не benchmark скорости, latency, token economy
или live reliability.

Для AX current trace заканчивается после inspection: третьего action call нет.
Proposed 261 bytes включают иллюстративный `click`, который ещё нельзя выполнить.
Поэтому уменьшение bytes в этой строке не является выигрышем рабочего сценария.

## Сценарий 1: показать скрытое окно Chrome

### Текущий trace

1. `list_windows({app: "Google Chrome"})` возвращает полный inventory.
2. Агент выбирает exact `WindowRef` и вызывает
   `window_transition({inventoryId, inventoryRevision, clientRequestId,
   request: {kind: "show", target: WindowRef}})`.

Текущий contract безопасен, если агент действительно выбрал ref, но заставляет
его переносить runtime/login/native generations и inventory revision.

### Proposed trace

```json
{"method":"get_state","arguments":{"kind":"window","app":"Google Chrome"}}
{"method":"show_window","arguments":{"targetId":"window_hidden_chrome_7"}}
```

`get_state` может вернуть несколько одноимённых Chrome windows. Агент обязан
выбрать конкретный `targetId` по записи/PID/state metadata; `show_window` не
имеет first-match fallback.

Success invariants:

- exact identity до и после show совпадает;
- actual state подтверждает unhidden/unminimized/visible/focused результат либо
  возвращает partial/typed error;
- show не создаёт новое окно и не запускает Chrome.

Recovery:

- stale/closed handle возвращает `target-stale`;
- новый `get_state` выдаёт новый handle, но старый handle не ретаргетится на
  replacement с тем же title.

## Сценарий 2: два Chrome profiles с одинаковым URL

### Текущий trace

1. `browser_chrome_instances({})` возвращает structured instance refs.
2. `browser_chrome_operation({intent, request: {kind: "connect-instance"}})`;
   agent payload содержит precondition, inventory и resources; response может
   вернуть instance ref с новым transport generation.
3. `browser_chrome_targets({instance})` допустим только при active exclusive
   reservation выбранного instance и использует именно возвращённый current ref.
4. Exact `read-accessibility` получает полный target ref и новый
   intent/resources.

### Proposed trace

```json
{"method":"get_state","arguments":{"kind":"browser"}}
{"method":"get_tabs","arguments":{"browserId":"browser_work_profile"}}
{"method":"observe","arguments":{"targetId":"tab_identical_url_b","mode":"ax"}}
```

Первый вызов показывает только configured browser summaries, а не targets всех
profiles. Второй явно выбирает один browser handle и внутри runtime получает его
session/reservation. Одинаковый URL не является identity.

Success invariants:

- response `get_tabs` и AX `observe` относится к выбранному profile/instance;
- exact tab handle сохраняется при одинаковых URL;
- другой profile не подключается и не активируется скрыто;
- Android/ADB не затрагивается.

Recovery: закрытый target или сменившийся transport epoch инвалидирует tab
handle; нужен `get_tabs` того же browser handle либо новый `get_state`, но не
поиск/fallback по URL.

## Сценарий 3: действие по AX element

### Текущий trace и feature gap

1. `list_windows({app: "Computer Use Fixture"})`.
2. `inspect_accessibility({inventoryId, inventoryRevision,
   request: {target, depth, maxNodes, maxBytes}})` возвращает snapshot-bound
   `ElementRef` и advertised AX actions.

После этого текущий public catalog не имеет AX element mutation. Input methods
принимают window/surface и координату/текст, но не `ElementRef`. Нажатие центра
`frame` не является semantic AX action и запрещено как workaround.

### Proposed trace

```json
{"method":"get_state","arguments":{"kind":"window","app":"Computer Use Fixture"}}
{"method":"observe","arguments":{"targetId":"window_fixture_primary","mode":"ax"}}
{"method":"click","arguments":{"targetId":"window_fixture_primary","elementId":"element_save_42"}}
```

`elementId` — короткая ссылка на server-side `ElementRef` и snapshot, а не копия
изменяемого числового индекса. Третий вызов является требованием к новой owner capability, а не переименованием
существующей pointer action. До реализации native AX press/action и runtime
authority этот scenario должен отвечать `unsupported-capability`, а не fake
success.

Success invariants будущей реализации:

- element handle принадлежит exact target и AX snapshot;
- requested action присутствует в advertised/permitted actions;
- native повторно подтверждает свежий element перед action;
- result разделяет dispatch/effect/cleanup и содержит readback evidence.

Recovery: stale element требует новый `observe(mode:"ax")`; facade не вычисляет
центр frame и не переводит semantic click в global pointer click.

## Сценарий 4: отменить pending text input

### Текущий trace и ограничение

1. `list_windows({app: "Computer Use Fixture"})`.
2. `keyboard_type({clientRequestId, precondition:{target,inventory...},action})`
   остаётся pending до terminal result.
3. `cancel_operation({operationId,...})` работает только когда operation ID уже
   известен. В обычном model-visible flow ID приходит в terminal tool response;
   значит этот метод сам по себе не решает concurrent cancel pending call.

MCP protocol cancellation может оборвать request transport, но facade всё равно
должен сохранить зарегистрированную operation и cleanup outcome.

### Proposed normal trace

```json
{"method":"get_state","arguments":{"kind":"window","app":"Computer Use Fixture"}}
{"method":"type_text","arguments":{"targetId":"window_fixture_primary","text":"English Русский 👩🏽‍💻"}}
{"method":"cancel_target","arguments":{"targetId":"window_fixture_primary","reason":"user-requested"}}
```

`type_text` и `cancel_target` выполняются конкурентно. Cancel не требует
operation ID и не затрагивает actions другого target или другой lineage.

Success invariants:

- operation записана до backend await;
- cancel останавливает будущие clusters и queued actions этого lineage/target;
- уже отправленные events остаются partial, не выдаются за rollback;
- receipt содержит `dispatch` и `cleanup`; новый action допускается только после
  complete cleanup, иначе target/resource остаётся quarantined.

Lost-reply recovery:

```json
{"method":"get_target_status","arguments":{"targetId":"window_fixture_primary"}}
```

Status возвращает bounded active/queued/recent terminal records собственной
lineage. Агент не повторяет `type_text` вслепую. После close, normal binding
expiry или replacement старый handle запрещает новые действия, но его
lineage-scoped tombstone остаётся пригодным для cancel/status и cleanup receipt
в пределах retention. После epoch restart status восстанавливается через
durable operation identity; target handle не переносится на одноимённое окно.

## Критика proposed interface

Плюсы:

- агент выбирает exact объект, но не переносит authority DTO;
- одинаковые title/URL не становятся selector;
- один handle связывает state, observation, action, cancel и recovery;
- три из четырёх traces короче по payload и не требуют agent-generated request
  IDs/resources;
- cancel становится возможен во время pending action.

Цена и риски:

- runtime обязан хранить bounded lineage-local handle registry и строгие expiry/
  invalidation rules;
- `cancel_target` намеренно шире operation cancel: он отменяет все active/queued
  actions этой lineage на target. UI/result должны показать количество и cleanup
  каждой затронутой operation;
- `get_target_status` должен иметь явный bounded retention/order, иначе lost
  reply снова станет неоднозначным;
- `get_tabs` не может маскировать browser connect/reservation failure;
- AX element case требует новую реальную capability. Без неё high-level facade
  неполон, даже если типы и method names готовы.

## Решение после четырёх checks

Интерфейс стоит реализовывать только если owner review подтверждает:

1. `targetId` lifecycle и lineage binding можно доказать без title/URL fallback.
2. `get_tabs` сохраняет explicit configured profile и reservation semantics.
3. Native/runtime получают настоящую AX element action capability.
4. `cancel_target` и `get_target_status` работают конкурентно с pending call и
   не допускают blind replay.

До этого facade implementation, production schemas и catalog changes остаются
на паузе.
