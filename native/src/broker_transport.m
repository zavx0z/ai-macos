#include "meta_broker_transport.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>

static const NSUInteger messageLimit = 1024 * 1024;
static const NSUInteger clipboardMessageLimit = 8 * 1024 * 1024;
static const uint32_t clipboardFrameFlag = 0x80000000u;
static const NSUInteger queuedByteLimit = 4 * 1024 * 1024;
static const NSUInteger queuedMessageLimit = 128;
static const NSUInteger binaryLimit = 64 * 1024 * 1024;
static const NSUInteger queuedBinaryLimit = 128 * 1024 * 1024 + 4 * (1024 * 1024 + 4);

static uint64_t monotonic_millis(void) {
  struct timespec time = {0};
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * 1000 + (uint64_t)time.tv_nsec / 1000000;
}

@implementation MetaBrokerTransport {
  int _input;
  int _output;
  dispatch_queue_t _io;
  dispatch_queue_t _callbacks;
  dispatch_source_t _reader;
  dispatch_source_t _writer;
  dispatch_source_t _watchdog;
  BOOL _writerSuspended;
  BOOL _started;
  BOOL _closed;
  MetaTransportMessage _onMessage;
  MetaTransportFailure _onFailure;
  uint8_t _header[4];
  NSUInteger _headerLength;
  NSMutableData *_payload;
  NSUInteger _payloadLength;
  BOOL _clipboardProfile;
  NSMutableArray<NSData *> *_writes;
  NSMutableArray<NSNumber *> *_writeProfiles;
  NSUInteger _writeOffset;
  NSUInteger _queuedBytes;
  NSUInteger _queuedClipboardBytes;
  NSUInteger _queuedBinaryBytes;
  NSUInteger _queuedBinaries;
  NSUInteger _pendingMessages;
  NSUInteger _pendingBytes;
  NSUInteger _pendingClipboardBytes;
  uint64_t _partialSince;
  uint64_t _lastWriteProgress;
}

- (instancetype)initWithInput:(int)input output:(int)output
                 callbackQueue:(dispatch_queue_t)callbackQueue
                     onMessage:(MetaTransportMessage)onMessage
                     onFailure:(MetaTransportFailure)onFailure {
  self = [super init];
  if (self) {
    if (callbackQueue == nil || onMessage == nil || onFailure == nil) return nil;
    _input = dup(input);
    _output = dup(output);
    if (_input < 0 || _output < 0) {
      if (_input >= 0) close(_input);
      if (_output >= 0) close(_output);
      return nil;
    }
    if (fcntl(_input, F_SETFL, fcntl(_input, F_GETFL) | O_NONBLOCK) < 0 ||
        fcntl(_output, F_SETFL, fcntl(_output, F_GETFL) | O_NONBLOCK) < 0 ||
        fcntl(_output, F_SETNOSIGPIPE, 1) < 0) {
      close(_input);
      close(_output);
      return nil;
    }
    _io = dispatch_queue_create("meta.native.transport", DISPATCH_QUEUE_SERIAL);
    _callbacks = callbackQueue;
    _onMessage = [onMessage copy];
    _onFailure = [onFailure copy];
    _writes = [NSMutableArray array];
    _writeProfiles = [NSMutableArray array];
  }
  return self;
}

- (void)fail:(NSString *)reason {
  if (_closed) return;
  [self closeOnQueue];
  MetaTransportFailure failure = _onFailure;
  dispatch_async(_callbacks, ^{ failure(reason); });
}

- (void)closeOnQueue {
  if (_closed) return;
  _closed = YES;
  if (_watchdog != nil) dispatch_source_cancel(_watchdog);
  if (_reader != nil) dispatch_source_cancel(_reader);
  else close(_input);
  if (_writer != nil) {
    if (_writerSuspended) {
      dispatch_resume(_writer);
      _writerSuspended = NO;
    }
    dispatch_source_cancel(_writer);
  } else close(_output);
  [_writes removeAllObjects];
  [_writeProfiles removeAllObjects];
  _payload = nil;
  _queuedBytes = 0;
  _queuedClipboardBytes = 0;
  _queuedBinaryBytes = 0;
  _queuedBinaries = 0;
}

- (void)start {
  dispatch_async(_io, ^{
    if (self->_started || self->_closed) return;
    self->_started = YES;
    self->_reader = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, self->_input, 0, self->_io);
    self->_writer = dispatch_source_create(DISPATCH_SOURCE_TYPE_WRITE, self->_output, 0, self->_io);
    int input = self->_input;
    int output = self->_output;
    dispatch_source_set_cancel_handler(self->_reader, ^{ close(input); });
    dispatch_source_set_cancel_handler(self->_writer, ^{ close(output); });
    __weak MetaBrokerTransport *weakSelf = self;
    dispatch_source_set_event_handler(self->_reader, ^{ [weakSelf readAvailable]; });
    dispatch_source_set_event_handler(self->_writer, ^{ [weakSelf writeAvailable]; });
    self->_watchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self->_io);
    dispatch_source_set_timer(self->_watchdog, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
    dispatch_source_set_event_handler(self->_watchdog, ^{
      MetaBrokerTransport *transport = weakSelf;
      if (transport == nil || transport->_closed) return;
      uint64_t now = monotonic_millis();
      if ((transport->_partialSince != 0 && now - transport->_partialSince >= 5000) ||
          (transport->_writes.count > 0 && now - transport->_lastWriteProgress >= 5000)) {
        [transport fail:@"Native framed transport deadline exceeded"];
      } else [transport armDeadline];
    });
    dispatch_resume(self->_watchdog);
    [self armDeadline];
    dispatch_resume(self->_reader);
    self->_writerSuspended = YES;
    if (self->_writes.count > 0) {
      self->_writerSuspended = NO;
      dispatch_resume(self->_writer);
    }
  });
}

// Вызывается только на _io после изменения неполного frame или очереди записи.
- (void)armDeadline {
  if (_watchdog == nil || _closed) return;
  uint64_t due = UINT64_MAX;
  if (_partialSince != 0) due = _partialSince + 5000;
  if (_writes.count > 0) due = MIN(due, _lastWriteProgress + 5000);
  if (due == UINT64_MAX) {
    dispatch_source_set_timer(_watchdog, DISPATCH_TIME_FOREVER, DISPATCH_TIME_FOREVER, 0);
  } else {
    uint64_t now = monotonic_millis();
    dispatch_source_set_timer(_watchdog,
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(due > now ? due - now : 0) * NSEC_PER_MSEC),
      DISPATCH_TIME_FOREVER, 0);
  }
}

- (void)readAvailable {
  @try {
  NSUInteger readBudget = 256 * 1024;
  while (!_closed && readBudget > 0) {
    void *destination = _payload == nil ? _header + _headerLength : (uint8_t *)_payload.mutableBytes + _payloadLength;
    NSUInteger remaining = _payload == nil ? 4 - _headerLength : _payload.length - _payloadLength;
    ssize_t received = read(_input, destination, MIN(remaining, readBudget));
    if (received < 0 && errno == EINTR) continue;
    if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    if (received <= 0) { [self fail:@"Native input channel закрыт или повреждён"]; return; }
    if (_partialSince == 0) _partialSince = monotonic_millis();
    readBudget -= (NSUInteger)received;
    if (_payload == nil) {
      _headerLength += (NSUInteger)received;
      if (_headerLength < 4) continue;
      uint32_t encoded;
      memcpy(&encoded, _header, sizeof(encoded));
      uint32_t header = ntohl(encoded);
      _clipboardProfile = (header & clipboardFrameFlag) != 0;
      NSUInteger length = header & 0x7fffffffu;
      NSUInteger limit = _clipboardProfile ? clipboardMessageLimit : messageLimit;
      if (length == 0 || length > limit) { [self fail:@"Native frame length вне budget"]; return; }
      NSUInteger pending = _clipboardProfile ? _pendingClipboardBytes : _pendingBytes - _pendingClipboardBytes;
      NSUInteger queueLimit = _clipboardProfile ? clipboardMessageLimit : queuedByteLimit;
      if (pending > queueLimit || length > queueLimit - pending) { [self fail:@"Native control byte budget исчерпан"]; return; }
      _payload = [NSMutableData dataWithLength:length];
      _payloadLength = 0;
    } else {
      _payloadLength += (NSUInteger)received;
      if (_payloadLength < _payload.length) continue;
      NSUInteger messageBytes = _payload.length;
      id value = [NSJSONSerialization JSONObjectWithData:_payload options:0 error:NULL];
      _payload = nil;
      _payloadLength = 0;
      _headerLength = 0;
      _partialSince = 0;
      if (![value isKindOfClass:NSDictionary.class]) { [self fail:@"Native frame должен быть JSON object"]; return; }
      if (_clipboardProfile && ![value[@"channel"] isEqual:@"clipboard"]) { [self fail:@"Clipboard frame profile содержит другой channel"]; return; }
      if (_pendingMessages >= queuedMessageLimit) { [self fail:@"Native control queue overflow"]; return; }
      _pendingMessages += 1;
      _pendingBytes += messageBytes;
      BOOL clipboard = _clipboardProfile;
      if (clipboard) _pendingClipboardBytes += messageBytes;
      NSDictionary *message = value;
      dispatch_async(_callbacks, ^{
        __block BOOL admitted = NO;
        dispatch_sync(self->_io, ^{ admitted = !self->_closed; });
        @try {
          if (admitted) self->_onMessage(message);
        } @finally {
          dispatch_async(self->_io, ^{
            self->_pendingMessages -= 1;
            self->_pendingBytes -= messageBytes;
            if (clipboard) self->_pendingClipboardBytes -= messageBytes;
          });
        }
      });
    }
  }

  } @finally { [self armDeadline]; }
}

- (BOOL)enqueueFrame:(NSDictionary *)frame {
  if ([frame[@"channel"] isEqual:@"binary"]) return NO;
  BOOL clipboard = [frame[@"channel"] isEqual:@"clipboard"];
  NSUInteger limit = clipboard ? clipboardMessageLimit : messageLimit;
  NSData *payload = [NSJSONSerialization dataWithJSONObject:frame options:0 error:NULL];
  if (payload == nil || payload.length == 0 || payload.length > limit) return NO;
  __block BOOL accepted = NO;
  dispatch_sync(_io, ^{
    if (self->_closed) return;
    NSUInteger length = payload.length + 4;
    NSUInteger queued = clipboard ? self->_queuedClipboardBytes : self->_queuedBytes - self->_queuedClipboardBytes - self->_queuedBinaryBytes;
    NSUInteger queueLimit = clipboard ? clipboardMessageLimit + 4 : queuedByteLimit;
    if (self->_writes.count >= queuedMessageLimit || queued > queueLimit || length > queueLimit - queued) {
      [self fail:@"Native writer queue overflow"];
      return;
    }
    NSMutableData *encoded = [NSMutableData dataWithLength:4];
    uint32_t header = htonl((uint32_t)payload.length | (clipboard ? clipboardFrameFlag : 0));
    memcpy(encoded.mutableBytes, &header, sizeof(header));
    [encoded appendData:payload];
    if (self->_writes.count == 0) self->_lastWriteProgress = monotonic_millis();
    [self->_writes addObject:encoded];
    [self->_writeProfiles addObject:clipboard ? @YES : @NO];
    self->_queuedBytes += length;
    if (clipboard) self->_queuedClipboardBytes += length;
    accepted = YES;
    [self armDeadline];
    if (self->_started && self->_writerSuspended) {
      self->_writerSuspended = NO;
      dispatch_resume(self->_writer);
    }
  });
  return accepted;
}

- (BOOL)enqueueBinaryFrame:(NSDictionary *)frame bytes:(NSData *)bytes {
  if (![frame isKindOfClass:NSDictionary.class] || ![frame[@"channel"] isEqual:@"binary"] ||
      ![frame[@"payload"] isKindOfClass:NSDictionary.class] ||
      ![bytes isKindOfClass:NSData.class] || bytes.length == 0 || bytes.length > binaryLimit) return NO;
  NSDictionary *metadata = frame[@"payload"];
  NSNumber *declared = metadata[@"byteLength"];
  if (![metadata[@"binaryToken"] isKindOfClass:NSString.class] || [metadata[@"binaryToken"] length] == 0 ||
      ![declared isKindOfClass:NSNumber.class] || declared.doubleValue != (double)bytes.length) return NO;
  NSData *payload = [NSJSONSerialization dataWithJSONObject:frame options:0 error:NULL];
  if (payload == nil || payload.length == 0 || payload.length > messageLimit) return NO;
  __block BOOL accepted = NO;
  dispatch_sync(_io, ^{
    if (self->_closed) return;
    NSUInteger length = payload.length + 4 + bytes.length;
    if (self->_writes.count >= queuedMessageLimit || self->_queuedBinaries >= 4 ||
        self->_queuedBinaryBytes > queuedBinaryLimit || length > queuedBinaryLimit - self->_queuedBinaryBytes) {
      [self fail:@"Native binary writer queue overflow"];
      return;
    }
    NSMutableData *encoded = [NSMutableData dataWithLength:4];
    uint32_t header = htonl((uint32_t)payload.length);
    memcpy(encoded.mutableBytes, &header, sizeof(header));
    [encoded appendData:payload];
    [encoded appendData:bytes];
    if (self->_writes.count == 0) self->_lastWriteProgress = monotonic_millis();
    [self->_writes addObject:encoded];
    [self->_writeProfiles addObject:@2];
    self->_queuedBytes += length;
    self->_queuedBinaryBytes += length;
    self->_queuedBinaries += 1;
    accepted = YES;
    [self armDeadline];
    if (self->_started && self->_writerSuspended) {
      self->_writerSuspended = NO;
      dispatch_resume(self->_writer);
    }
  });
  return accepted;
}

- (void)writeAvailable {
  @try {
  NSUInteger writeBudget = 256 * 1024;
  while (!_closed && _writes.count > 0 && writeBudget > 0) {
    NSData *data = _writes[0];
    NSUInteger remaining = data.length - _writeOffset;
    ssize_t sent = write(_output, (const uint8_t *)data.bytes + _writeOffset, MIN(remaining, writeBudget));
    if (sent < 0 && errno == EINTR) continue;
    if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    if (sent <= 0) { [self fail:@"Native output channel закрыт или повреждён"]; return; }
    _writeOffset += (NSUInteger)sent;
    _lastWriteProgress = monotonic_millis();
    _queuedBytes -= (NSUInteger)sent;
    NSUInteger profile = [_writeProfiles[0] unsignedIntegerValue];
    if (profile == 1) _queuedClipboardBytes -= (NSUInteger)sent;
    if (profile == 2) _queuedBinaryBytes -= (NSUInteger)sent;
    writeBudget -= (NSUInteger)sent;
    if (_writeOffset == data.length) {
      if (profile == 2) _queuedBinaries -= 1;
      [_writes removeObjectAtIndex:0];
      [_writeProfiles removeObjectAtIndex:0];
      _writeOffset = 0;
    }
  }
  if (!_closed && _writes.count == 0 && !_writerSuspended) {
    dispatch_suspend(_writer);
    _writerSuspended = YES;
  }

  } @finally { [self armDeadline]; }
}

- (void)close { dispatch_async(_io, ^{ [self closeOnQueue]; }); }
@end
