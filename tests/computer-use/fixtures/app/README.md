# AppKit fixture для live-приёмки

Одна локальная AppKit application для будущей проверки computer use на Intel
macOS 13. Она не является backend, не управляет другими приложениями и не
подменяет direct `ai-macos` tools.

Fixture содержит:

- два обычных окна с одинаковым title `Computer Use Fixture` и разными
  `accessibilityIdentifier`: `fixture.window.primary` и
  `fixture.window.secondary`;
- editable `NSTextView` с `fixture.text.input` и начальным RU/EN/emoji/composed
  текстом;
- button открытия sheet, read-only sheet без файлов/сохранения и button закрытия;
- маленькую scroll area, slider и кнопку воссоздания закрытого secondary window;
- стандартные AppKit hide, minimize, resize, move и close actions.

## Сборка

Сборка выполняется только во временный каталог:

```bash
FIXTURE_BUILD_DIR=$(mktemp -d /tmp/ai-macos-ui-fixture.XXXXXX)
/usr/bin/clang \
  -fobjc-arc \
  -mmacosx-version-min=13.0 \
  -Wall \
  -Wextra \
  -Werror \
  -framework AppKit \
  -framework Foundation \
  tests/computer-use/fixtures/app/main.m \
  -o "$FIXTURE_BUILD_DIR/ComputerUseFixture"
```

Compile success не является runtime, native или visual acceptance.

## Ручной запуск и cleanup

Запуск с read-only test hook:

```bash
"$FIXTURE_BUILD_DIR/ComputerUseFixture" --test-hook
```

После появления окон все capture/input/window actions выполняются только через
direct `ai-macos` tools по правилам проекта. Fixture завершается стандартным
Quit собственного AppKit menu либо закрытием обоих окон. После завершения можно
удалить созданный временный каталог; в repository и installed helper ничего не
копируется.

## Read-only IPC test hook

Hook принимает через stdin JSON Lines размером не более 4096 bytes. Единственная
команда:

```json
{"command":"state","requestId":"manual-1"}
```

Ответы и UI events пишутся в stdout по одной JSON object на строку. State
содержит только собственные title/identifiers/frames, hidden/minimized, sheet,
scroll offset и тестовый text. Hook не принимает mutation-команд. Text ограничен
2048 UTF-16 units, одна сессия пишет не более 1024 envelopes. Это test oracle,
а не способ управлять UI.

## Mapping A14–A29

| ID | Fixture assertion | Статус до live-запуска |
| --- | --- | --- |
| A14 | hide app, minimize/show exact primary/secondary по identifier | Source + compile only |
| A15 | Обычный AX-readable process с двумя окнами | Только позитивная fixture; timeout/denied создаёт backend fault driver |
| A16 | Одинаковый title не разрешает first-match, identifiers различны | Source + compile only |
| A17 | Закрыть secondary и воссоздать с тем же semantic identifier, но новым OS instance | Source + compile only |
| A18 | Обычные AX+CG окна | AX-only вариант требует отдельного native fixture |
| A19 | Открыть/закрыть owned sheet; никаких файлов и повторного close | Source + compile only |
| A20 | Не browser fixture | Не покрыто |
| A21 | Обычное composite window | Overlay/ownership fault требует отдельного capture fixture |
| A22 | Обычный isolated-capture target | Protected/blank content не эмулируется |
| A23 | Move primary между доступными displays, проверить frame и transform с внешней display fixture | Частичное live основание |
| A24 | Resize/move окно через границу displays | Частичное live основание |
| A25 | Capture, затем move/resize и убедиться, что observation стала stale | Source + compile only |
| A26 | Статичное содержимое для first/idle frame | Stream stop/blank fault даёт capture fixture |
| A27 | Перезаписать text RU/EN/emoji/composed и сверить hook readback | Source + compile only |
| A28 | Scroll по `fixture.small-scroll`, click button, drag `fixture.slider` | Source + compile only |
| A29 | Окна поддерживают move/resize | Partial failure задаёт injected backend, не UI application |

При live-приёмке root сначала формулирует ожидаемый кадр, затем использует
direct `ai-macos` capture с обязательным caption и отдельно сравнивает state
hook. Зелёная compilation не подтверждает внешний вид, routing input или AX/CG
identity.
