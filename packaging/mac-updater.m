#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>

static SPUStandardUpdaterController *controller;

static napi_value Start(napi_env env, napi_callback_info info) {
    if (controller != nil) return NULL;

    SPUStandardUpdaterController *candidate = [[SPUStandardUpdaterController alloc]
        initWithStartingUpdater:NO updaterDelegate:nil userDriverDelegate:nil];
    NSError *error = nil;
    if (![candidate.updater startUpdater:&error]) {
        napi_throw_error(env, NULL, error.localizedDescription.UTF8String);
        return NULL;
    }

    controller = candidate;
    if (controller.updater.automaticallyChecksForUpdates) {
        [controller.updater checkForUpdatesInBackground];
    }
    return NULL;
}

static napi_value CheckForUpdates(napi_env env, napi_callback_info info) {
    [controller checkForUpdates:nil];
    return NULL;
}

NAPI_MODULE_INIT() {
    const napi_property_descriptor methods[] = {
        { .utf8name = "start", .method = Start },
        { .utf8name = "checkForUpdates", .method = CheckForUpdates },
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(*methods), methods);
    return exports;
}
