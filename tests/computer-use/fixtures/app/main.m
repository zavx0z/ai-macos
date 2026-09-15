#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

static const NSUInteger kMaximumTextLength = 2048;
static const NSUInteger kMaximumIpcLineBytes = 4096;
static const NSUInteger kMaximumEmissions = 1024;

@interface FixtureController
    : NSObject <NSApplicationDelegate, NSWindowDelegate, NSTextViewDelegate>

@property(nonatomic, strong) NSWindow *primaryWindow;
@property(nonatomic, strong) NSWindow *secondaryWindow;
@property(nonatomic, strong) NSWindow *sheetWindow;
@property(nonatomic, strong) NSTextView *textView;
@property(nonatomic, strong) NSScrollView *smallScrollView;
@property(nonatomic, strong) NSMutableData *ipcBuffer;
@property(nonatomic) BOOL testHookEnabled;
@property(nonatomic) NSUInteger emissionCount;
@property(nonatomic) NSUInteger sequence;
@property(nonatomic) NSUInteger secondaryInstance;

- (instancetype)initWithTestHookEnabled:(BOOL)testHookEnabled;

@end

@implementation FixtureController

- (instancetype)initWithTestHookEnabled:(BOOL)testHookEnabled {
  self = [super init];
  if (self != nil) {
    _testHookEnabled = testHookEnabled;
    _ipcBuffer = [NSMutableData data];
    _secondaryInstance = 1;
  }
  return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  [self buildMenu];
  self.primaryWindow = [self buildPrimaryWindow];
  self.secondaryWindow = [self buildSecondaryWindow];
  [self.primaryWindow makeKeyAndOrderFront:nil];
  [self.secondaryWindow orderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  if (self.testHookEnabled) [self startReadOnlyTestHook];
  [self emitEvent:@"application-ready" details:@{}];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:
    (NSApplication *)sender {
  (void)sender;
  return YES;
}

- (void)applicationDidHide:(NSNotification *)notification {
  (void)notification;
  [self emitEvent:@"application-hidden" details:@{}];
}

- (void)applicationDidUnhide:(NSNotification *)notification {
  (void)notification;
  [self emitEvent:@"application-unhidden" details:@{}];
}

- (void)buildMenu {
  NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@"Main"];
  NSMenuItem *applicationItem = [[NSMenuItem alloc] initWithTitle:@"Fixture"
                                                           action:nil
                                                    keyEquivalent:@""];
  [mainMenu addItem:applicationItem];
  NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@"Fixture"];
  [applicationMenu
      addItemWithTitle:@"Скрыть Computer Use Fixture"
                action:@selector(hide:)
         keyEquivalent:@"h"];
  [applicationMenu addItem:[NSMenuItem separatorItem]];
  [applicationMenu addItemWithTitle:@"Завершить Computer Use Fixture"
                              action:@selector(terminate:)
                       keyEquivalent:@"q"];
  [applicationItem setSubmenu:applicationMenu];
  [NSApp setMainMenu:mainMenu];
}

- (NSWindow *)baseWindowWithFrame:(NSRect)frame identifier:(NSString *)identifier {
  NSWindowStyleMask style = NSWindowStyleMaskTitled |
                            NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable |
                            NSWindowStyleMaskResizable;
  NSWindow *window = [[NSWindow alloc] initWithContentRect:frame
                                                styleMask:style
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
  window.title = @"Computer Use Fixture";
  window.accessibilityIdentifier = identifier;
  window.releasedWhenClosed = NO;
  window.delegate = self;
  window.minSize = NSMakeSize(420, 320);
  return window;
}

- (NSWindow *)buildPrimaryWindow {
  NSWindow *window = [self baseWindowWithFrame:NSMakeRect(120, 220, 560, 440)
                                    identifier:@"fixture.window.primary"];
  NSView *content = window.contentView;

  NSTextField *heading = [NSTextField labelWithString:
      @"Primary — ввод, sheet и прокрутка"];
  heading.frame = NSMakeRect(20, 400, 520, 22);
  heading.accessibilityIdentifier = @"fixture.primary.heading";
  [content addSubview:heading];

  NSScrollView *textScroll = [[NSScrollView alloc]
      initWithFrame:NSMakeRect(20, 160, 520, 225)];
  textScroll.hasVerticalScroller = YES;
  textScroll.hasHorizontalScroller = NO;
  textScroll.borderType = NSBezelBorder;
  textScroll.accessibilityIdentifier = @"fixture.text.scroll";
  self.textView = [[NSTextView alloc]
      initWithFrame:NSMakeRect(0, 0, 500, 225)];
  self.textView.richText = NO;
  self.textView.automaticQuoteSubstitutionEnabled = NO;
  self.textView.automaticDashSubstitutionEnabled = NO;
  self.textView.delegate = self;
  self.textView.accessibilityIdentifier = @"fixture.text.input";
  self.textView.string =
      @"English | Русский | emoji: 👩🏽‍💻 | composed: e\u0301";
  textScroll.documentView = self.textView;
  [content addSubview:textScroll];

  NSButton *sheetButton = [NSButton buttonWithTitle:@"Открыть sheet"
                                             target:self
                                             action:@selector(openSheet:)];
  sheetButton.frame = NSMakeRect(20, 112, 160, 32);
  sheetButton.accessibilityIdentifier = @"fixture.sheet.open";
  [content addSubview:sheetButton];

  NSButton *recreateButton =
      [NSButton buttonWithTitle:@"Воссоздать второе окно"
                         target:self
                         action:@selector(recreateSecondaryWindow:)];
  recreateButton.frame = NSMakeRect(190, 112, 200, 32);
  recreateButton.accessibilityIdentifier = @"fixture.secondary.recreate";
  [content addSubview:recreateButton];

  self.smallScrollView = [[NSScrollView alloc]
      initWithFrame:NSMakeRect(20, 20, 360, 80)];
  self.smallScrollView.hasVerticalScroller = YES;
  self.smallScrollView.borderType = NSBezelBorder;
  self.smallScrollView.accessibilityIdentifier = @"fixture.small-scroll";
  NSView *scrollDocument = [[NSView alloc]
      initWithFrame:NSMakeRect(0, 0, 330, 320)];
  for (NSInteger index = 0; index < 12; index += 1) {
    NSTextField *row = [NSTextField
        labelWithString:[NSString stringWithFormat:@"Строка прокрутки %02ld",
                                                   (long)index + 1]];
    row.frame = NSMakeRect(12, 290 - index * 25, 280, 20);
    row.accessibilityIdentifier =
        [NSString stringWithFormat:@"fixture.scroll.row.%02ld",
                                   (long)index + 1];
    [scrollDocument addSubview:row];
  }
  self.smallScrollView.documentView = scrollDocument;
  self.smallScrollView.contentView.postsBoundsChangedNotifications = YES;
  [[NSNotificationCenter defaultCenter]
      addObserver:self
         selector:@selector(scrollBoundsDidChange:)
             name:NSViewBoundsDidChangeNotification
           object:self.smallScrollView.contentView];
  [content addSubview:self.smallScrollView];

  NSSlider *slider = [NSSlider sliderWithValue:25
                                      minValue:0
                                      maxValue:100
                                        target:self
                                        action:@selector(sliderChanged:)];
  slider.frame = NSMakeRect(395, 45, 145, 24);
  slider.accessibilityIdentifier = @"fixture.slider";
  [content addSubview:slider];
  return window;
}

- (NSWindow *)buildSecondaryWindow {
  NSWindow *window = [self baseWindowWithFrame:NSMakeRect(720, 220, 460, 360)
                                    identifier:@"fixture.window.secondary"];
  NSTextField *label = [NSTextField labelWithString:
      @"Secondary — тот же title, другой accessibilityIdentifier"];
  label.frame = NSMakeRect(20, 310, 420, 24);
  label.accessibilityIdentifier = @"fixture.secondary.label";
  [window.contentView addSubview:label];

  NSTextField *instance = [NSTextField
      labelWithString:[NSString stringWithFormat:@"Instance: %lu",
                                                 (unsigned long)self.secondaryInstance]];
  instance.frame = NSMakeRect(20, 275, 300, 22);
  instance.accessibilityIdentifier = @"fixture.secondary.instance";
  [window.contentView addSubview:instance];
  return window;
}

- (NSWindow *)buildSheetWindow {
  NSWindow *sheet = [[NSWindow alloc]
      initWithContentRect:NSMakeRect(0, 0, 380, 190)
                styleMask:NSWindowStyleMaskTitled
                  backing:NSBackingStoreBuffered
                    defer:NO];
  sheet.title = @"Fixture Sheet";
  sheet.accessibilityIdentifier = @"fixture.sheet";
  sheet.releasedWhenClosed = NO;
  NSTextField *label = [NSTextField
      labelWithString:@"Этот sheet не читает и не сохраняет данные."];
  label.frame = NSMakeRect(24, 125, 332, 24);
  label.accessibilityIdentifier = @"fixture.sheet.label";
  [sheet.contentView addSubview:label];
  NSButton *closeButton = [NSButton buttonWithTitle:@"Закрыть sheet"
                                             target:self
                                             action:@selector(closeSheet:)];
  closeButton.frame = NSMakeRect(110, 55, 160, 34);
  closeButton.keyEquivalent = @"\r";
  closeButton.accessibilityIdentifier = @"fixture.sheet.close";
  [sheet.contentView addSubview:closeButton];
  return sheet;
}

- (void)openSheet:(id)sender {
  (void)sender;
  if (self.primaryWindow.attachedSheet != nil) return;
  if (self.sheetWindow == nil) self.sheetWindow = [self buildSheetWindow];
  [self.primaryWindow beginSheet:self.sheetWindow completionHandler:nil];
  [self emitEvent:@"sheet-opened" details:@{}];
}

- (void)closeSheet:(id)sender {
  (void)sender;
  if (self.primaryWindow.attachedSheet == nil) return;
  [self.primaryWindow endSheet:self.sheetWindow];
  [self.sheetWindow orderOut:nil];
  [self emitEvent:@"sheet-closed" details:@{}];
}

- (void)recreateSecondaryWindow:(id)sender {
  (void)sender;
  if (self.secondaryWindow.visible) {
    [self emitEvent:@"secondary-recreate-skipped"
            details:@{ @"reason" : @"window-visible" }];
    return;
  }
  self.secondaryInstance += 1;
  self.secondaryWindow = [self buildSecondaryWindow];
  [self.secondaryWindow orderFront:nil];
  [self emitEvent:@"secondary-recreated"
          details:@{ @"instance" : @(self.secondaryInstance) }];
}

- (void)sliderChanged:(NSSlider *)sender {
  [self emitEvent:@"slider-changed"
          details:@{ @"value" : @(sender.doubleValue) }];
}

- (void)scrollBoundsDidChange:(NSNotification *)notification {
  (void)notification;
  NSPoint origin = self.smallScrollView.contentView.bounds.origin;
  [self emitEvent:@"scroll-changed"
          details:@{ @"x" : @(origin.x), @"y" : @(origin.y) }];
}

- (void)textDidChange:(NSNotification *)notification {
  (void)notification;
  [self emitEvent:@"text-changed"
          details:@{ @"length" : @(self.textView.string.length) }];
}

- (BOOL)textView:(NSTextView *)textView
    shouldChangeTextInRange:(NSRange)affectedCharRange
          replacementString:(NSString *)replacementString {
  NSUInteger currentLength = textView.string.length;
  NSUInteger replacementLength = replacementString.length;
  NSUInteger nextLength = currentLength - affectedCharRange.length +
                          replacementLength;
  return nextLength <= kMaximumTextLength;
}

- (void)windowDidMiniaturize:(NSNotification *)notification {
  [self emitWindowEvent:@"window-miniaturized" window:notification.object];
}

- (void)windowDidDeminiaturize:(NSNotification *)notification {
  [self emitWindowEvent:@"window-deminiaturized" window:notification.object];
}

- (void)windowWillClose:(NSNotification *)notification {
  [self emitWindowEvent:@"window-closed" window:notification.object];
}

- (void)emitWindowEvent:(NSString *)name window:(NSWindow *)window {
  [self emitEvent:name
          details:@{
            @"identifier" : window.accessibilityIdentifier ?: @"unknown"
          }];
}

- (NSDictionary *)windowState:(NSWindow *)window
                      instance:(NSUInteger)instance {
  NSRect frame = window.frame;
  return @{
    @"accessibilityIdentifier" : window.accessibilityIdentifier ?: @"",
    @"title" : window.title ?: @"",
    @"instance" : @(instance),
    @"visible" : @(window.visible),
    @"miniaturized" : @(window.miniaturized),
    @"frame" : @{
      @"x" : @(frame.origin.x),
      @"y" : @(frame.origin.y),
      @"width" : @(frame.size.width),
      @"height" : @(frame.size.height)
    }
  };
}

- (NSDictionary *)stateForRequestId:(NSString *)requestId {
  NSPoint scrollOrigin = self.smallScrollView.contentView.bounds.origin;
  return @{
    @"type" : @"state",
    @"requestId" : requestId,
    @"applicationHidden" : @(NSApp.hidden),
    @"windows" : @[
      [self windowState:self.primaryWindow instance:1],
      [self windowState:self.secondaryWindow instance:self.secondaryInstance]
    ],
    @"text" : self.textView.string ?: @"",
    @"sheet" : @{
      @"open" : @(self.primaryWindow.attachedSheet != nil),
      @"accessibilityIdentifier" : @"fixture.sheet"
    },
    @"scroll" : @{
      @"x" : @(scrollOrigin.x),
      @"y" : @(scrollOrigin.y)
    }
  };
}

- (void)emitEvent:(NSString *)name details:(NSDictionary *)details {
  NSMutableDictionary *event = [@{
    @"type" : @"event",
    @"name" : name,
    @"details" : details
  } mutableCopy];
  [self emitObject:event];
}

- (void)emitError:(NSString *)code requestId:(NSString *)requestId {
  [self emitObject:@{
    @"type" : @"error",
    @"code" : code,
    @"requestId" : requestId ?: @"unknown"
  }];
}

- (void)emitObject:(NSDictionary *)object {
  if (!self.testHookEnabled || self.emissionCount >= kMaximumEmissions) return;
  NSMutableDictionary *envelope = [object mutableCopy];
  self.sequence += 1;
  envelope[@"sequence"] = @(self.sequence);
  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:envelope
                                                 options:0
                                                   error:&error];
  if (json == nil || error != nil || json.length > kMaximumIpcLineBytes) return;
  NSMutableData *line = [json mutableCopy];
  const uint8_t newline = '\n';
  [line appendBytes:&newline length:1];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:line];
  self.emissionCount += 1;
}

- (void)startReadOnlyTestHook {
  NSFileHandle *input = [NSFileHandle fileHandleWithStandardInput];
  __weak FixtureController *weakSelf = self;
  input.readabilityHandler = ^(NSFileHandle *handle) {
    NSData *data = handle.availableData;
    if (data.length == 0) {
      handle.readabilityHandler = nil;
      return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf acceptIpcData:data];
    });
  };
}

- (void)acceptIpcData:(NSData *)data {
  [self.ipcBuffer appendData:data];
  while (self.ipcBuffer.length > 0) {
    const uint8_t *bytes = self.ipcBuffer.bytes;
    NSUInteger newlineIndex = NSNotFound;
    for (NSUInteger index = 0; index < self.ipcBuffer.length; index += 1) {
      if (bytes[index] == '\n') {
        newlineIndex = index;
        break;
      }
    }
    if (newlineIndex == NSNotFound) {
      if (self.ipcBuffer.length > kMaximumIpcLineBytes) {
        [self.ipcBuffer setLength:0];
        [self emitError:@"ipc-line-too-large" requestId:nil];
      }
      return;
    }
    NSData *line = [self.ipcBuffer subdataWithRange:NSMakeRange(0, newlineIndex)];
    [self.ipcBuffer replaceBytesInRange:NSMakeRange(0, newlineIndex + 1)
                              withBytes:NULL
                                 length:0];
    if (line.length == 0) continue;
    [self handleIpcLine:line];
  }
}

- (void)handleIpcLine:(NSData *)line {
  if (line.length > kMaximumIpcLineBytes) {
    [self emitError:@"ipc-line-too-large" requestId:nil];
    return;
  }
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:line options:0 error:&error];
  if (error != nil || ![value isKindOfClass:[NSDictionary class]]) {
    [self emitError:@"invalid-json" requestId:nil];
    return;
  }
  NSDictionary *request = value;
  NSString *command = [request[@"command"] isKindOfClass:[NSString class]]
                          ? request[@"command"]
                          : nil;
  NSString *requestId = [request[@"requestId"] isKindOfClass:[NSString class]]
                            ? request[@"requestId"]
                            : nil;
  if (requestId.length == 0 || requestId.length > 128) {
    [self emitError:@"invalid-request-id" requestId:nil];
    return;
  }
  if (![command isEqualToString:@"state"]) {
    [self emitError:@"read-only-hook" requestId:requestId];
    return;
  }
  [self emitObject:[self stateForRequestId:requestId]];
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    BOOL testHookEnabled = NO;
    for (int index = 1; index < argc; index += 1) {
      if (strcmp(argv[index], "--test-hook") == 0) testHookEnabled = YES;
    }
    NSApplication *application = [NSApplication sharedApplication];
    FixtureController *controller =
        [[FixtureController alloc] initWithTestHookEnabled:testHookEnabled];
    application.delegate = controller;
    [application run];
  }
  return 0;
}
