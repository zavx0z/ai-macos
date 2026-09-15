# Снимки и observations

## Текущее состояние

C0 и C1 приняты. C2 scoped capture slice принят ведущим: production
`RuntimeScreenAdapter`, concrete `ProtocolNativeCaptureDriver` и native layout
compositor реализованы в capture-owned paths и проходят injected protocol/
runtime tests. Приняты adapter/protocol driver/orientation/release fixes;
live SCK capability по-прежнему не `ready`.

Изолированный native SCStream-модуль реализован и собран во временный
x86_64 binary; pure fixture и screen metadata tests проходят. Живой capture,
permission prompt, установленный helper и сервисы не запускались. Capability
SCK не объявляется `ready`: compile и fake checks не заменяют проверку кадра на
Intel macOS 13.7.8.

Shared observation contracts импортируются только из опубликованного
`@meta/shared/contracts`; локальная копия `Observation` не создавалась.

## Реализовано в C2

- `screen/src/adapter.ts` — side-effect-free `RuntimeScreenAdapter`:
  - один `authorizeScreenCapture` возвращает единственный snapshot-bound
    `TargetResolution`; повторного resolve и producer-native ID нет;
  - exact capture-stream lease, source/caption/clip/cursor/output/fullPage,
    target mapping и effective result сверяются до binary publication;
  - native region несёт только compositor display ID, полный `DisplayRef`
    добавляется только из authority resolution;
  - stale/future timestamps, overlapping/stale regions, policy/budget mismatch,
    target before/after change и incomplete drain отклоняются;
  - producer occlusion proof не становится runtime ownership, а frame-freshness
    proof не подменяет point-bound interaction ownership;
  - operation deadline вызывает native cancel и bounded 1 s drain wait;
    unresolved task остаётся quarantined, `reconcileCapture` принимает только
    monotonic status revision; late terminal report сохраняется идемпотентно,
    Runtime сначала применяет `ResourceRegistry.reconcileCleanup`, а native
    task release/delete разрешён только после проверенного cleanup receipt;
  - release reply loss не вызывает blind retry: task остаётся в release-stage,
    runtime cleanup остаётся quarantined; ACK хранит tombstone с digest receipt,
    одинаковый повтор идемпотентен, конфликт отклоняется;
  - duplicate taskRef нельзя перезаписать другой operation/handles или ранее
    завершённым tombstone;
  - accepted runtime-issued `publication.frameRef` используется без локальной
    генерации; actual bytes проверяются `verifyAndPublishBinaryFrame` до cache.
- `screen/tests/adapter.test.ts` — 17 injected adapter tests: happy path,
  wrong authority mapping, policy mismatch, unknown→complete reconciliation,
  реальный `ResourceRegistry` quarantine→receipt→native release, invalid
  unknown+drained, bounded timeout/cancel, no producer ownership, isolated
  window CG/PID, foreign/missing/duplicate display regions, foreign frame
  receipt, PNG CRC и stitched layout skew.
- `screen/src/native-driver.ts` — concrete wrapper над
  `@meta/native/capture-client`: async start ACK, bounded result polling,
  status/cancel/release через runtime-issued continuations, mapping terminal
  metadata/raw bytes/evidence receipt и idempotent release key/tombstone.
- `screen/tests/native-driver.test.ts` — 5 tests через настоящий
  `NativeBrokerAdapter`/`NativeCaptureClient` и injected transport: pending poll,
  raw binary без base64, evidence sequence, cancellation terminal без frame,
  dropped late start ACK, unknown→verified status→drained и автоматическая
  регистрация task/status/terminal в настоящем `NativeContinuationRegistry`
  без manual preseed.
- `native/src/capture/meta_capture.{h,m}` дополнен synchronous
  `meta_capture_compose_layout`: несколько complete per-display PNG объединяются
  через CoreGraphics/ImageIO без shell, с common bounded bitmap, encoded cap,
  отрицательными origins, per-display transforms/timestamps и aggregated
  cleanup. Producer `pointerActionable` удалён из C ABI.
- Native fixture проверяет красный 2x3 и corner-pattern 2x3 PNG: negative origin,
  прозрачный gap, rotated non-square display, mixed 2x/1x backing scale при
  output 0.5, точные output pixels/regions, timestamp/cleanup aggregation и
  pre-allocation dimension cap. Region обязан иметь explicit
  `display-oriented`; compositor сохраняет orientation без повторного rotation.

## Реализовано

- `native/src/capture/meta_capture.h` — отдельный Objective-C/C ABI для
  `display-composite` и `window-isolated`, exact `displayID` либо
  `windowID + ownerPID`, обязательного caption, limits, cancel и ownership
  результата.
- `native/src/capture/meta_capture.m` — `SCStream` backend для macOS 13:
  - passive `CGPreflightScreenCaptureAccess`, без request/System Settings;
  - `SCShareableContent` с exact target и
    `SCContentFilter(desktopIndependentWindow:)` для isolated window;
  - frame принимается только если `CMSampleBuffer` valid/data-ready и
    `SCFrameStatusComplete`; `started/idle/blank/suspended/stopped` считаются
    skipped, missing/invalid metadata — invalid;
  - сохраняются actual pixel dimensions, `displayTime`, real frame wall
    timestamp, `contentRect`, `contentScale`, `scaleFactor`, `screenRect` при
    доступности;
  - dimensions/pixel cap проверяется до создания stream и повторно по
    `CVPixelBuffer`; PNG кодируется через bounded `CGDataConsumer`, не растущий
    сверх `maxEncodedBytes`;
  - `stopCapture` ограничен таймером; timeout и stop error возвращают
    `cleanup: unknown`, а объект stream удерживается до позднего подтверждения;
    start pending допускает не более двух stop attempts, чтобы late start после
    раннего stop error получил bounded повтор, но clean stop не создал новый stream;
  - completion одноразовый; `meta_capture_task_status` публикует revision и
    поздний unknown → complete reconciliation без второй completion;
  - task считается drained только после подтверждённого stream stop и окончания
    encode job; единый stop/cleanup deadline продолжает тикать после clean stop
    ACK, поэтому зависший encoder даёт одноразовый `cleanup: unknown`, а позднее
    завершение только reconciles status; `MetaCaptureResult` резервируется до возврата start, поэтому
    allocation failure наблюдаем как синхронный `NULL`, а не потерю callback;
  - regions строятся по пересечениям с каждым display, содержат negative
    origins, rotation, backing scales, image-to-screen transform и frame time;
  - composite никогда не выдаёт геометрию за pixel ownership; producer-controlled
    `pointerActionable` полностью отсутствует в C ABI;
  - модуль не делает raise, focus, restore, AppleScript или Chrome proxy.
- `native/src/capture/tests/meta_capture_fixture.m` — чистая проверка A23/A26/A37:
  overflow-safe pixel budget, только complete frame, transforms с отрицательным
  origin и image-region mapping. Injected fake stream дополнительно покрывает
  cancel/capture-timeout при pending start, stop error → late start → bounded
  retry, stop timeout → late success, одноразовую completion, status revision,
  encode drain, clean stop + зависший encoder → deadline unknown → late status
  reconciliation и ранний allocation failure. Ни одна capture API из fixture
  не вызывается.
- `screen/src/capture.ts` — единый разбор named/fractional scale, exact PNG
  byte-view dimensions/IHDR, caption metadata и локальные 32 MP / 64 MiB /
  32768 px guards.
- `screen/src/index.ts` — desktop caption round-trip, actual pixel/byte metadata,
  fractional `scale` для desktop/window/rect и negative x/y для display layouts.
- `screen/tests/capture-metadata.test.ts` — regressions для caption-independent
  scale parser, Buffer view offsets и limits. Transform/freshness checks остаются
  в native fixture; adapter использует принятые shared types без локальной копии DTO.

## Native API для общего build

Native-задаче после проверки ведущим нужны только эти исходники и frameworks:

- header: `native/src/capture/meta_capture.h`
- implementation: `native/src/capture/meta_capture.m`
- compile flags: `-fobjc-arc -fblocks -mmacosx-version-min=13.0`
- frameworks: `Foundation`, `CoreGraphics`, `CoreImage`, `CoreMedia`,
  `CoreVideo`, `ImageIO`, `ScreenCaptureKit`
- lifecycle: `meta_capture_start` → optional `meta_capture_cancel` →
  `meta_capture_task_status` до drained при unknown → `meta_capture_task_release`;
  completion владеет `MetaCaptureResult` и вызывает `meta_capture_result_release`
- passive permission: `meta_capture_preflight_screen_recording`; request API в
  capture-модуле отсутствует

При `MetaCaptureCleanupUnknown` native broker/runtime обязан quarantine этот
capture resource/native generation и не считать task release доказательством
остановки системного stream.

## Интеграционные зависимости C2

Accepted C1 теперь предоставляет runtime-issued `ObservationPublication`
вместе с `frameRef`, один snapshot-bound `TargetResolution`, structural
comparison, binary publisher и `EvidenceIssuer.issueFrameFreshness`.
`RuntimeScreenAdapter` использует эти interfaces напрямую: actual bytes сначала
проходят publication, затем verified native frame receipt выпускает runtime
frame-freshness proof; producer proof или ID не принимаются.

Concrete `@meta/native/capture-client` уже подключён: start/status advance/
terminal registration, bounded continuation control, cancel/release cleanup
channel, binary bytes и evidence receipts проверены без local control/schema.

Остаются общие runtime/native условия вне scoped C2 acceptance:

1. Layout native router владеет aggregate task/status дочерних per-display streams и
   вызывает capture-owned `meta_capture_compose_layout`; native-owner не
   реализует второй stitcher.
2. `NativeTargetMapping.window.displays` подтверждён как exact covered display
   set окна на topology revision, не весь layout context; adapter требует этот
   unique set целиком либо typed unavailable.
3. Dropped start ACK безопасно не становится consumer success и не регистрирует
   task у Screen. Native production C core теперь адресует такой task через
   operation: `meta_broker_core_cancel_operation` вызывает capture-router cancel,
   operation status сохраняет task/drain/result, а
   `meta_broker_core_release_drained_operation` освобождает только complete+
   drained tasks. `broker_core_test.m` покрывает ignored start ACK → generic
   cancel → late completion/status → authoritative release. Открыто command-loop
   wiring этого core API; live-ready по fixture не заявляется.

## Выполненные checks

```text
/usr/bin/clang -fobjc-arc -fblocks -Wall -Wextra -Werror -arch x86_64 \
  -DMETA_CAPTURE_TESTING=1 \
  -mmacosx-version-min=13.0 -I native/src/capture \
  native/src/capture/meta_capture.m \
  native/src/capture/tests/meta_capture_fixture.m \
  -framework Foundation -framework CoreGraphics -framework CoreImage \
  -framework CoreMedia -framework CoreVideo -framework ImageIO \
  -framework ScreenCaptureKit -o /tmp/meta-capture-c2.*/meta-capture-fixture
# Mach-O 64-bit executable x86_64
# meta_capture_fixture: pass

bun run --cwd screen test
# 34 pass, 0 fail, 170 assertions

cd screen && bun run typecheck
# exit 0

bun build screen/src/adapter.ts screen/src/native-driver.ts \
  --target bun --outdir /tmp/meta-screen-adapter.*
# bundled two side-effect-free entrypoints

/usr/bin/clang --analyze ... native/src/capture/meta_capture.m
# exit 0
```

`screen/tsconfig.json` исправлен в своей области: extends `../tsconfig.json`,
tests включены. Текущий корневой TypeScript check во время C2 временно зависит
от соседних test fixtures, которые догоняют `advanceVerifiedStatus`; `screen`
package typecheck проходит самостоятельно.

## Acceptance по этой границе

- A21: модель не обещает ownership для composite; producer actionable flag
  отсутствует, interaction target/point требует отдельный runtime proof.
  Injected evidence готово; live overlay остаётся ведущему.
- A22: isolated filter и excluded auxiliary surfaces явны; publish допускает
  только fresh complete frame. Hidden/protected live result не проверен.
- A23: per-display transforms, negative origins, mixed DPI scale/rotation,
  round-trip и decoded composed PNG checks готовы; live остаётся.
- A24: настоящий native layout compositor, regions и timestamps/exact skew
  и display-oriented pixel placement готовы; live spanning-window остаётся.
- A25: exact window before/after CG evidence отклоняет подтверждённый move/resize
  или исчезновение; runtime revision/disconnect fault injection ждёт общего facade.
- A26: status filter, bounded stop/unknown cleanup, late reconciliation и fake
  SCStream lifecycle injection реализованы; live test ещё нужен после integration.
- A32–A33: passive preflight реализован, request API отсутствует; exact signed
  helper identity/update/rollback принадлежат native/runtime и live installation.
- A37: dimension/pixel caps до stream/composition allocation, bounded encoded
  sink и actual PNG CRC/length/hash checks готовы.
- A41: caption, runtime-issued observation/frame IDs, verified binary
  publication и frame evidence готовы; MCP/PiP caller integration ещё не C3.
- A45: capture callbacks/encoding вынесены с control queue; slow AX integration
  принадлежит native/runtime и ещё не проверена.

## Unresolved и next step

- Старый `screen/src/index.ts` всё ещё содержит legacy raise/focus restore,
  Chrome proxy и `screencapture`; новый adapter их не импортирует. Они будут
  отключены только при согласованном cutover после общего native facade.
- Native compile не проверяет реальный `SCStream` callback, качество кадра,
  Screen Recording ownership или stop timeout macOS 13.7.8.
- Дальнейший шаг выполняется только по concrete Runtime/Native handoff:
  command-loop wiring уже реализованного core router cancel/status/release.
  Установленный helper, live SCK и реальные hidden/offscreen/mixed-display
  сценарии проверяет ведущий позже.
