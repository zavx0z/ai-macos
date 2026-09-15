# Нестандартные случаи ai-macos

Журнал наблюдений. Скриншот и сообщение об отправке события не заменяют проверку результата. Непроверенную гипотезу не записывать как установленную причину.

## 2026-09-14 — системный диалог сохранения Яндекс Браузера

- Контекст: Дзен-студия, Yandex PID 3355, родительское окно index 2; сохранение страницы через Cmd+S.
- Симптом: `POST /focus failed (409): focused-window verification failed`; отклонены и ввод имени, и клик по «Отменить».
- Факт: отказ произошёл до отправки ввода. Повтор координат не устраняет отказ проверки фокуса.
- Причина: работавший старый backend возвращал `frontmost.window: null` для sheet. Сервис возвращал фокус ChatGPT между действиями.
- Решение: по прямому запросу пользователя обновлена текущая main fast-forward `5f0c47d → 0bd9eaf`; проверены cwd слушателей; обновлены input/window/screen из канонического checkout. Native backend возвращает геометрию sheet с `index: 0`.
- Проверка: тот же диалог принял новое имя файла и путь через Cmd+Shift+G; HTML списка сохранён в канонический каталог Дзена.
- Правило: адресовать родительское окно и его локальные координаты, не передавать index 0 как обычное окно. Не отключать проверку фокуса.

## 2026-09-14 — git pull не обновляет уже запущенный сервис

- Симптом: новая реализация есть на диске, а `system_health` по-прежнему показывает старый backend.
- Причина: процессы `bun src/index.ts` были запущены без hot reload.
- Решение: сначала проверить PID/порт/cwd, затем контролируемо обновить только затронутые сервисы в рамках разрешённого пользователем ремонта. Совместимые чужие слушатели не заменять.
- Проверка: health сообщает `window.backend: meta-input-helper`, Accessibility сохранён; input readiness успешен.
- Граница: обычный вызов навыка не разрешает такой перезапуск. Здесь пользователь прямо поручил обновить и доработать ai-macos.

## 2026-09-14 — восстановление фокуса скриншота на sheet

- Симптом: ввод в Save/Open сработал, но `verificationCapture.restored.ok: false`: попытка найти отдельное окно с index 0.
- Причина: screen передавал вложенный sheet в `/focus` как самостоятельное окно.
- Исправление: если фокус остался на том же sheet, ничего не менять. Если изменился — искать единственное содержащее его окно того же PID; после фокуса владельца проверить возврат sheet. Не угадывать владельца при неоднозначности.
- Проверки: 5 regression tests в `screen/tests/restore-focus.test.ts`; live Cmd+Shift+G с успешным `verificationCapture.restored.ok: true`.
- Отдельное наблюдение: при закрытии Save/Open индексы/заголовки AX-окон могут кратковременно меняться. Один возврат после Save ещё дал ошибку восстановления; файл при этом существует. Не объявлять все варианты восстановления исправленными.

## 2026-09-14 — адресная строка закрывается между действиями

- Симптом: после Cmd+L виден выделенный адрес, следующий ввод не виден в адресной строке.
- Наблюдение: input-инструмент возвращал фокус ChatGPT после каждого действия. Yandex закрывал popup адресной строки.
- Рабочий приём: явно `focus_window` перед серией Cmd+L → текст → Enter. Проверять каждое действие. После этого адрес был введён и статья открылась.
- Ограничение: компьютер общий. Если пользователь начал печатать или переместил фокус, не перетирать неожиданный текст; заново проверить окно и состояние. Не удерживать браузер вопреки активному действию пользователя.

## Шаблон следующей записи

Дата; приложение/окно; ожидаемый эффект; фактический результат; была ли отправка ввода; доказательства; причина или гипотеза; исправление; проверка; ограничения; ссылка на правило или regression test.

## 2026-09-14 — изменение AX index после Save подтверждено повторно

На «Школьном входном блоке» результат mouse_click: delivered:true, verificationComplete:false; frontmostAfterInput index 3; capture упал на `window not found: pid=3355 index=3`, restoration — на уже закрытом sheet. Действие не повторять. Readback файла и новая инвентаризация — отдельное восстановление наблюдения. Нужна дальнейшая доработка устойчивой идентичности окна между inventory/raise и восстановления MCP после намеренного закрытия sheet; текущие изменения screen эту гонку полностью не закрывают.

## 2026-09-14 — агент повторно использовал устаревший index

После серии Save основное окно Yandex стало index 3, а служебная полоска — index 2. Повторный keyboard_shortcut с прежним index 2 был отклонён до ввода. Это ошибка выбора цели агентом, отличная от гонки внутри post-action capture. При однозначном устойчивом заголовке использовать `app + title` без index (для текущей серии публикаций `app:Yandex,title:Дзен`), чтобы сервер каждый раз разрешал актуальное окно. При отказе сначала читать новый list_windows и применять именно его результат. Не делать capture с прежним index после получения новой инвентаризации.

## 2026-09-15 — устойчивый CGWindowID реализован и проверен

В 0.3.0 введены windowId и ownerWindowId во всей цепочке native → input → window → screen → MCP. Основное окно Yandex сохранило CGWindowID 6627. Первый sheet имел ID 8218, после закрытия и повторного открытия — 8224; оба указывали ownerWindowId 6627. MCP-тест с намеренно неверными index=999 и title выбрал правильный windowId. Cancel и повторный Cmd+S завершились с verificationComplete/restorationComplete=true. [Save с владельцем](screenshots/2026-09-15-save-stable-id.png), [возврат к родителю](screenshots/2026-09-15-parent-restored.png).

33 автоматические проверки закрывает смену index/title/frame, окно-двойник, неизвестный/закрытый ID, привязку sheet и совместимость legacy-селекторов. Нативное соответствие CG→AX требует однозначности; при неразличимых перекрывающихся окнах оно отклоняется. Старые подключения MCP сохраняют прежние схемы до переподключения — это отдельно от версии файлов и REST-сервисов.

Один запуск live-test остановился на input_readiness до любого клавиатурного ввода. Пассивная проверка подтвердила сохранённые Accessibility/post-events; следующая отдельная активная проверка успешна. Причина единичного active-probe failure не установлена. Тест не считал доставку клавиши состоявшейся и не открывал System Settings.

## 2026-09-15 — выпадающее меню отсутствует на снимке отдельного окна

- Контекст: меню «Формат» в системном Save диалоге Yandex, владелец windowId 6627.
- Симптом: меню видно на desktop screenshot, но его нет на изолированном снимке родительского CGWindowID. Повторное нажатие без desktop readback могло закрыть уже открытое меню.
- Причина: popup — отдельная поверхность compositor; `screencapture -l` родителя её не включает.
- Исправление: screen разрешает цель по стабильному ID и снимает видимую область окна вместе с меню; после захвата повторно проверяет ID и геометрию. Изменившееся окно отклоняется. Focus не переактивирует уже выбранное окно/sheet; если фокус успело забрать другое приложение, выполняется одна явная активация с проверкой. MCP не повторяет focus при восстановлении того же владельца.
- Проверка: свежий MCP 0.3.0, намеренно устаревшие index/title, успешный capture по ID; [меню формата присутствует](screenshots/2026-09-15-save-format-popup.png). Два MCP regression tests проверяют отсутствие лишнего focus при открытом и закрытом sheet.
- Ограничение: это снимок видимой композиции, а не изолированное изображение окна. Постороннее перекрытие нужно распознавать по изображению; меню за границами родителя требует desktop capture.


## 2026-09-15 — доставленный ввод не гарантирует точность текста в редакторе

- Контекст: Yandex, pid 3355, windowId 6627, editor Дзена; это историческая идентичность из сохранённых ответов, не готовый селектор для нового действия.
- Ожидание: абзацы совпадут с переданными строками. Факт: Complete DOM содержит три расхождения (`вид. сулицы`, `света. ирабочего места`, `Куда. вэтот`). Для двух абзацев сохранённое сравнение фактических args доказывает input==expected при delayMs=1; raw responses имеют delivered=true и effectVerified=false. Точные args третьего в этом диагностическом файле отсутствуют.
- Причина: не установлена. Гипотеза исключительно про batching при delay0 не подтверждает эти delay1 случаи. Последний абзац с пометкой delay20 совпал; n=1, другой текст, причинного сравнения и универсальной гарантии нет.
- Рабочее действие: readback и локальное восстановление до expected в уже разрешённой операции; проверять также границы/типы блоков. По сообщению оркестратора, полное paragraph selection захватило границу и склеило блоки, оператор отменил. Сохранённые кадры 125–127 осмотрены: после замены видна склейка, после Cmd+Z разделение визуально вернулось. PNG совпадают с raw image bytes. Полного post-undo DOM нет; это проверка видимого участка, не всей статьи.
- Доказательства: `editorial/runs/live-draft-2026-09-15-theatre/publisher/root-input-diagnostics.json`, `root-dom-diagnostic.json`, raw `30`, `32`, `41`, `101`; точные полные пути и SHA-256 — `editorial/runs/ui-lessons-2026-09-15/methodologist/read_log.json` в каноническом dzen. Повторный offline разбор — `replay-results.json` там же.
- Regression: точное сравнение args/readback; непустой diff отклоняет text acceptance; синтетическая склейка обнаруживается по count/text. Методолог не управлял UI: selection/undo проверены только по сохранённым кадрам, парный delay-тест не выполнялся. Внешние инструкции и настройки этим предложением не меняются.

## 2026-09-15 — scroll deltas mistaken for pixels

Yandex editor navigation alternated dy650, -900, 350, -600 and250 while seeking a nearby paragraph. Native command_scroll uses kCGScrollEventUnitLine, so these values represent wheel lines, not pixels. The MCP schema did not state the units. Clarified tool description, dx/dy field descriptions and API reference without changing native behavior. Start with a small step and verify the resulting viewport; do not claim a fixed pixel distance. The large-step tool arguments are retained in the publisher task history and local operation evidence in canonical dzen.

## 2026-09-15 — Cyrillic mojibake after plain clipboard paste

A known approved two-paragraph string was written through clipboard_write and inserted using the visible Paste menu in the Dzen editor. The write reported 796 input bytes, but screenshot06 in canonical dzen's week-live-2026-09-15/05-covered-market-glazing/create/publisher/screens shows mojibake. This differs from the earlier three punctuation errors during native keyboard typing.

The implementation spawned pbcopy/pbpaste with inherited locale. The installed macOS pbcopy manual states that these utilities choose input/output encoding from locale and recommends UTF-8; a headless service need not inherit Terminal's UTF-8 locale. Both child processes now explicitly receive LANG, LC_CTYPE and LC_ALL=en_US.UTF-8. No global shell or macOS setting is changed.

Regression tests mock the subprocess boundary, cover missing/C/non-UTF-8 parent locales and multilingual text, and do not read or replace the user's general clipboard. The previous automatic real-clipboard round trip was removed from the default tests. TypeScript and four unit tests passed. Live verification is performed only through the assigned operator's direct MCP write and visible Paste/readback in the existing draft. A successful byte-count response alone is not application-level verification. Evidence remains in the local Dzen incident archive; the draft is not duplicated.

## 2026-09-15 — manually reproducing image base64 delayed evidence storage

During a Dzen draft operation, the operator generated an approximately156k-character patch containing the capture's base64 image, then decoded it in a separate command. This needlessly routes binary data through model generation and risks corruption. Preserve the original direct MCP response in a code variable instead: serialize it programmatically, save it through a file tool such as a programmatically constructed `tools.apply_patch`, and decode the image block from that saved response. Return the native image to the model for inspection and only short paths/status as text. Do not print the large JSON/base64 and then ask the model to reproduce it. Avoid passing the whole image in a shell command argument, which may exceed macOS ARG_MAX.

Use a unique checkpoint and check that files do not already exist. Preserve the full response, the real clock observation when available, the selected image-block index, and hashes. Verify that the PNG exactly equals the image bytes in raw evidence. A file-storage failure does not authorize repeating the UI mutation: recover the response or observe current state first. The operational correction is recorded separately from the frozen prompt of the already-running task. The local Dzen guide `editorial/OBSERVATION-STORAGE.md` contains the storage recipe; this is an orchestration lesson, not a clean model-quality comparison.
