#ifndef META_OWNED_SHEET_DISCOVERY_H
#define META_OWNED_SHEET_DISCOVERY_H

#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, MetaOwnedSheetDiscoveryStatus) {
  MetaOwnedSheetDiscoveryComplete,
  MetaOwnedSheetDiscoveryFailed,
  MetaOwnedSheetDiscoveryTimedOut,
};

@protocol MetaOwnedSheetDiscoveryBackend <NSObject>
- (uint64_t)monotonicMillis;
- (BOOL)prepareElement:(id)element timeoutMillis:(uint64_t)timeoutMillis;
- (AXError)childCountForElement:(id)element count:(NSUInteger *)count;
- (AXError)childrenForElement:(id)element
                         from:(NSUInteger)index
                        count:(NSUInteger)count
                        value:(NSArray **)value;
- (AXError)roleForElement:(id)element value:(NSString **)value;
- (AXError)pidForElement:(id)element value:(pid_t *)value;
- (AXError)parentForElement:(id)element value:(id *)value;
- (BOOL)element:(id)left equals:(id)right;
@end

typedef BOOL (^MetaOwnedSheetConsumer)(id borrowedSheet);

MetaOwnedSheetDiscoveryStatus meta_discover_direct_owned_sheets(
    id borrowedOwner,
    pid_t ownerPid,
    uint64_t deadlineMillis,
    id<MetaOwnedSheetDiscoveryBackend> backend,
    MetaOwnedSheetConsumer consumer);

id<MetaOwnedSheetDiscoveryBackend> meta_owned_sheet_system_backend(void);

#endif
