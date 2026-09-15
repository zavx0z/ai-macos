# Текущий статус computer use

Этот файл содержит текущий срез координации. История решений и проверок —
[computer-use-coordination.md](../computer-use-coordination.md).
Принятый ограниченный этап не означает готовность установленного сервиса.

| Задача | Что принято | Что остаётся |
| --- | --- | --- |
| Computer use: runtime, контракты и MCP | C2 core/evidence/continuation, thin UDS auth/lineage/status/cancel | На Astra/high исправляет C3 reservation authority и pre-dispatch exclusion; production MCP tools/frame/catalog впереди |
| Computer use: native broker и окна | C0 native core, ABI v2 subset, identity/extractor и часть C2 integration | На Astra/high исправляет concurrent task lifetime, tombstone horizon, capture outcome schema и memory bounds; затем command-loop/live |
| Computer use: ввод и interaction | C2 adapter/authorization/status/compiler, injected clipboard; text bridge до C executor с fake sink | Остальные native actions, runtime wiring, versioned clipboard backend, live |
| Computer use: снимки и координаты | C2 adapter/protocol driver, late reconciliation/ACK tombstones/taskRef protection и pixel orientation | Dropped-start production cancel/drain wiring, installed helper и live capture/mixed displays |
| Computer use: Chrome и Android | C2 adapters/concrete backend и lifecycle/bounded IO review | Runtime lifetime reservation/recovery/composition, live A34–A40 |
| Computer use: приёмочные проверки | ABI v2 + real Runtime cross-client subset: root 25 pass / 56 assertions | UDS/STDIO/client lineage, durable restart/retention и live ещё не приняты |

## Последние подтверждённые проверки

- Runtime: root 23 tests / 114 assertions pass, включая actual NativeCaptureClient
  normal/late cleanup integration. C2 core/continuation scoped accepted;
  единственный текущий UDS test не закрывает известные transport замечания.
- Chrome/Android/CDP: root 62 pass / 121 assertions; C2 scoped accepted.
- Input: independent review 47 pass / 90 assertions, root C bridge fixture
  1 pass / 2 assertions. Последний safe allowlist владельца: 55 pass / 107 assertions.
- Screen: root 22 targeted adapter/protocol tests / 146 assertions pass;
  full package по handoff 34 pass / 170 assertions. C2 scoped accepted.
- Native: root package check — шесть C/Objective-C fixtures и 24 TypeScript
  tests / 129 assertions на предыдущем checkpoint; latest root — семь fixtures,
  28 TypeScript tests / 133 assertions pass. Independent final Native review идёт.
- Thin UDS/MCP foundation: root 6 tests / 39 assertions pass, scoped accepted.
  Это ещё не полный набор computer-use инструментов.

## Следующие зависимости

1. Native завершает C router concurrency/retention и protocol memory bounds.
   Runtime authorities и Capture driver приняты в своей ограниченной области.
2. Native связывает production command loop с operation-level cancel/drain;
   dropped-start C core test не заменяет проверку этого общего пути.
3. Runtime исправляет замечания UDS/MCP и реализует lifetime Android reservation;
   thin transport fixes приняты. Reservation candidate не принят: caller-owned
   connect record/verifier, отсутствие exclusion до reconnect, session freshness
   и external-generation tuple. Требуется automatic Runtime coordinator.
   Workspace связи Runtime→Chrome/Android установлены для concrete composition.
   Старые reservation 3 tests / 21 assertions не покрывали эти defects.
4. QA проверяет реальные межпакетные цепочки, затем ведущий проводит общий
   integration/cutover gate и отдельно живые сценарии.

## Эксплуатационный статус

Общий root TypeScript check и `git diff --check` прошли после последнего
checkpoint; новые edits должны проходить собственные проверки владельцев.

Installed services, helper и Codex configuration не переключены.
Live input/capture/ADB в этой волне не выполнялись, кроме ошибочного запуска
существовавшего clipboard-теста агентом Input: текст восстановлен тестом,
прежние non-text formats неизвестны. Инцидент сообщён Владимиру; test теперь
явно opt-in и root подтвердил его skip в безопасном режиме.
