#include "meta_operation_receipts.h"
#include <assert.h>

static NSMutableDictionary *status(NSString *operation) {
  return [@{@"operationId": operation, @"requestId": @"source", @"runtimeEpoch": @"runtime", @"loginSessionId": @"login", @"nativeGeneration": @"native",
    @"acceptedFence": @{@"runtimeEpoch": @"runtime", @"loginSessionId": @"login", @"nativeGeneration": @"native", @"counter": @1},
    @"execution": @"finished", @"observer": @{@"state": @"unavailable", @"coveredKinds": @[]}} mutableCopy];
}
int main(void) {
  @autoreleasepool {
    MetaOperationReceipts *store = [[MetaOperationReceipts alloc] init];
    NSMutableDictionary *first = status(@"first");
    assert([store recordStatus:first]);
    first[@"execution"] = @"failed";
    assert([[store statusForOperation:@"first" requestId:@"query"][@"execution"] isEqual:@"finished"]);
    assert([store recordStatus:status(@"second")]);
    assert([[store statusForOperation:@"first" requestId:@"new-query"][@"requestId"] isEqual:@"new-query"]);
    NSMutableDictionary *forged = status(@"first"); forged[@"nativeGeneration"] = @"foreign";
    assert(![store recordStatus:forged]);
    forged = status(@"payload"); forged[@"text"] = @"plaintext";
    assert(![store recordStatus:forged]);
    forged = status(@"nested"); forged[@"observer"] = @{@"payload": @"plaintext"};
    assert(![store recordStatus:forged]);
    for (NSUInteger index = 2; index < 10000; index += 1) {
      @autoreleasepool { assert([store recordStatus:status([NSString stringWithFormat:@"operation-%lu", (unsigned long)index])]); }
    }
    assert(![store recordStatus:status(@"overflow")]);
    assert([store statusForOperation:@"first" requestId:@"oldest"] != nil);
    puts("operation receipts fixture: ok");
  }
  return 0;
}
