// Agent Deck is its own copy of iTerm2 under its own name and icon, so deck
// windows stay apart from everyday terminal windows. build-app loads this file
// into that copy. It keeps the decks' panels in place, gives it New Deck (a new
// tab of the deck window) in the Dock menu and on ⌘N, Hide Conversations in
// the View and Dock menus and on ⌃⌘S, Auto-Continue in the Dock and app menus,
// and starts the deck controller (iterm.py) that arranges the windows,
// starting it again if it stops.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <sys/socket.h>
#import <sys/un.h>

// The parts of iTerm2 used here: a key to its Python API for the controller.
@protocol AgentDeckITerm2
+ (id)sharedInstance;
- (NSString *)randomStringForCookie;
- (NSString *)identifierForKey:(NSString *)key;
- (id)initWithName:(NSString *)name fullPath:(NSString *)fullPath identifier:(NSString *)identifier relaunch:(id)relaunch;
- (void)addHistoryEntry:(id)entry;
@end

static NSString *const AgentDeckLog = @"Library/Logs/Agent Deck.log";

static void AgentDeckNote(NSString *text) {
    NSString *path = [NSHomeDirectory() stringByAppendingPathComponent:AgentDeckLog];
    if (![NSFileManager.defaultManager fileExistsAtPath:path]) [NSFileManager.defaultManager createFileAtPath:path contents:nil attributes:nil];
    NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
    [handle seekToEndOfFile];
    NSString *line = [NSString stringWithFormat:@"%@ App: %@\n", [[NSISO8601DateFormatter new] stringFromDate:NSDate.date], text];
    [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
    [handle closeFile];
}

@interface AgentDeck : NSObject
@end

@implementation AgentDeck {
    NSString *_folder;
    dispatch_queue_t _queue;
    NSTask *_controller;
    NSDate *_started;
    NSTimeInterval _pause;
    BOOL _quitting;
}

+ (instancetype)shared {
    static AgentDeck *deck;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ deck = [AgentDeck new]; });
    return deck;
}

- (instancetype)init {
    if ((self = [super init])) {
        _folder = NSProcessInfo.processInfo.environment[@"AGENT_DECK_HOME"] ?: [NSHomeDirectory() stringByAppendingPathComponent:@".config/agent-deck"];
        _queue = dispatch_queue_create("local.agentdeck.controller", DISPATCH_QUEUE_SERIAL);
        _pause = 1;
    }
    return self;
}

#pragma mark Settings

// Settings the deck relies on, whatever was changed in Settings.
+ (void)applySettings {
    NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
    NSDictionary *settings = @{
        // The controller arranges the windows through iTerm2's Python API.
        @"EnableAPIServer": @YES,
        // The controller opens the decks that were open last time; nothing else opens on its own.
        @"OpenNoWindowsAtStartup": @YES,
        @"OpenArrangementAtStartup": @NO,
        @"AlwaysOpenWindowAtStartup": @NO,
        @"OpenUntitledFile": @NO,
        @"QuitWhenAllWindowsClosed": @NO,
        // Quitting or closing a deck only closes the views; the chats carry on and come back next time.
        @"PromptOnQuit": @NO,
        @"OnlyWhenMoreTabs": @NO,
        // No offer to move the app; it is installed where it belongs.
        @"moveToApplicationsFolderAlertSuppress": @YES,
        // An iTerm2 update would turn the app back into plain iTerm2; build-app follows updates instead.
        @"SUEnableAutomaticChecks": @NO,
        @"SUAutomaticallyUpdate": @NO,
        // Its own config folder, apart from iTerm2's.
        @"PreferredBaseDir": [NSHomeDirectory() stringByAppendingPathComponent:@".local/share/agent-deck/app-config"],
    };
    [settings enumerateKeysAndObjectsUsingBlock:^(NSString *key, id value, BOOL *stop) {
        if (![[defaults objectForKey:key] isEqual:value]) [defaults setObject:value forKey:key];
    }];
}

#pragma mark App

- (void)didLaunch {
    [self tidyMenu:NSApp.mainMenu];
    // Auto-Continue in the app menu, under Settings.
    NSMenu *appMenu = NSApp.mainMenu.itemArray.firstObject.submenu;
    NSInteger index = 1;
    for (NSInteger i = 0; i < appMenu.numberOfItems; i++) {
        if ([[appMenu itemAtIndex:i].keyEquivalent isEqualToString:@","]) { index = i + 1; break; }
    }
    if (appMenu) [appMenu insertItem:[self autoContinueItem] atIndex:MAX(0, MIN(index, appMenu.numberOfItems))];
    // Hide Conversations first in the View menu.
    NSMenu *viewMenu = [NSApp.mainMenu itemWithTitle:@"View"].submenu;
    if (viewMenu) {
        [viewMenu insertItem:NSMenuItem.separatorItem atIndex:0];
        [viewMenu insertItem:[self listItem] atIndex:0];
    }
    [self send:@{@"cmd": @"restore"} raise:YES];
}

- (void)willQuit {
    _quitting = YES;
    [_controller terminate];
}

- (NSMenu *)dockMenu {
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
    [menu addItemWithTitle:@"New Deck" action:@selector(newDeck:) keyEquivalent:@""].target = self;
    [menu addItem:NSMenuItem.separatorItem];
    [menu addItem:[self listItem]];
    [menu addItem:[self autoContinueItem]];
    return menu;
}

#pragma mark Auto-continue

// Whether a chat that reaches its plan limit carries on in another account of
// its subscription by itself. The deck's settings file holds it; panels show
// and switch the same setting.
- (NSString *)settingsPath {
    return [_folder stringByAppendingPathComponent:@"settings.json"];
}

- (NSMutableDictionary *)settings {
    NSData *data = [NSData dataWithContentsOfFile:self.settingsPath];
    id value = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil] : nil;
    return [value isKindOfClass:NSDictionary.class] ? value : [NSMutableDictionary dictionary];
}

- (BOOL)autoContinue {
    id value = self.settings[@"autoContinue"];
    return [value isKindOfClass:NSNumber.class] ? [value boolValue] : YES;
}

- (NSMenuItem *)autoContinueItem {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:@"Auto-Continue" action:@selector(toggleAutoContinue:) keyEquivalent:@""];
    item.target = self;
    item.toolTip = @"When a chat reaches an account's limit, it carries on in another account of the same subscription.";
    return item;
}

- (void)toggleAutoContinue:(id)sender {
    NSMutableDictionary *settings = self.settings;
    settings[@"autoContinue"] = @(!self.autoContinue);
    NSData *data = [NSJSONSerialization dataWithJSONObject:settings options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
    if (![data writeToFile:self.settingsPath atomically:YES]) AgentDeckNote(@"Could not save Auto-Continue.");
}

- (BOOL)validateMenuItem:(NSMenuItem *)item {
    if (item.action == @selector(toggleAutoContinue:)) item.state = self.autoContinue ? NSControlStateValueOn : NSControlStateValueOff;
    if (item.action == @selector(toggleList:)) item.title = self.showList ? @"Hide Conversations" : @"Show Conversations";
    return YES;
}

#pragma mark Conversation list

// Whether deck windows show the conversation list. The controller hides and
// shows it in every deck window and keeps the choice in the settings file.
- (BOOL)showList {
    id value = self.settings[@"showList"];
    return [value isKindOfClass:NSNumber.class] ? [value boolValue] : YES;
}

- (NSMenuItem *)listItem {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:@"Hide Conversations" action:@selector(toggleList:) keyEquivalent:@"s"];
    item.keyEquivalentModifierMask = NSEventModifierFlagControl | NSEventModifierFlagCommand;
    item.target = self;
    return item;
}

- (void)toggleList:(id)sender {
    [self send:@{@"cmd": @"list-toggle", @"show": @(!self.showList)} raise:NO];
}

- (void)newDeck:(id)sender {
    [self send:@{@"cmd": @"new"} raise:YES];
}

// The Dock icon clicked with every deck minimized or closed.
- (void)showDecks {
    [self send:@{@"cmd": @"show"} raise:YES];
}

// Menu items about iTerm2 itself, which Agent Deck leaves out.
+ (NSSet<NSString *> *)iTerm2Only {
    return [NSSet setWithArray:@[@"checkForUpdatesFromMenu:", @"makeDefaultTerminal:", @"unmakeDefaultTerminal:",
                                 @"installShellIntegration:", @"showTipOfTheDay:"]];
}

// iTerm2's menus under Agent Deck's name, with ⌘N for a new deck.
- (void)tidyMenu:(NSMenu *)menu {
    for (NSMenuItem *item in menu.itemArray.copy) {
        if ([item.title containsString:@"iTerm2"]) item.title = [item.title stringByReplacingOccurrencesOfString:@"iTerm2" withString:@"Agent Deck"];
        NSString *action = item.action ? NSStringFromSelector(item.action) : @"";
        if ([AgentDeck.iTerm2Only containsObject:action]) {
            item.hidden = YES;
        } else if ([action isEqualToString:@"newWindow:"]) {
            item.title = @"New Deck";
            item.target = self;
            item.action = @selector(newDeck:);
        }
        if (item.submenu) [self tidyMenu:item.submenu];
    }
}

#pragma mark Controller

// Sends a request to the controller, starting it first if needed; `raise` brings the app forward after.
- (void)send:(NSDictionary *)command raise:(BOOL)raise {
    NSMutableDictionary *payload = command.mutableCopy;
    payload[@"frame"] = [AgentDeck screenFrame];
    dispatch_async(_queue, ^{
        if (![self ensureController]) return;
        if (![self request:payload timeout:60]) AgentDeckNote(@"The deck controller did not answer.");
        if (raise) dispatch_async(dispatch_get_main_queue(), ^{ [NSApp activate]; });
    });
}

// The visible area of the screen under the pointer, where new decks open.
+ (NSDictionary *)screenFrame {
    NSPoint mouse = NSEvent.mouseLocation;
    NSScreen *screen = NSScreen.mainScreen;
    for (NSScreen *candidate in NSScreen.screens) {
        if (NSMouseInRect(mouse, candidate.frame, NO)) { screen = candidate; break; }
    }
    NSRect frame = screen.visibleFrame;
    return @{@"x": @(frame.origin.x), @"y": @(frame.origin.y), @"width": @(frame.size.width), @"height": @(frame.size.height)};
}

// On the controller queue.
- (BOOL)ensureController {
    if ([self request:@{@"cmd": @"ping"} timeout:2]) return YES;
    if (!_controller.running && ![self startController]) return NO;
    for (int i = 0; i < 150; i++) {
        if ([self request:@{@"cmd": @"ping"} timeout:2]) return YES;
        if (!_controller.running) break;
        [NSThread sleepForTimeInterval:0.2];
    }
    AgentDeckNote(@"The deck controller did not start.");
    return NO;
}

// On the controller queue.
- (BOOL)startController {
    NSString *home = NSHomeDirectory();
    NSString *python = [home stringByAppendingPathComponent:@".local/share/agent-deck/iterm-env/bin/python"];
    if (![NSFileManager.defaultManager isExecutableFileAtPath:python]) {
        AgentDeckNote(@"The deck controller is not installed. Run the Agent Deck setup again.");
        return NO;
    }
    __block NSDictionary *access;
    dispatch_sync(dispatch_get_main_queue(), ^{ access = [self apiAccess]; });
    if (!access) return NO;

    NSMutableDictionary *environment = [NSMutableDictionary dictionary];
    [NSProcessInfo.processInfo.environment enumerateKeysAndObjectsUsingBlock:^(NSString *key, NSString *value, BOOL *stop) {
        if (![key hasPrefix:@"CLAUDE"] && ![key hasPrefix:@"ANTHROPIC_"] && ![key isEqualToString:@"AI_AGENT"] && ![key isEqualToString:@"TMUX"]) environment[key] = value;
    }];
    [environment addEntriesFromDictionary:access];
    environment[@"PATH"] = [home stringByAppendingString:@"/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"];
    environment[@"LANG"] = @"en_US.UTF-8";
    // The Python API's socket sits in this app's own support folder, named after its executable.
    environment[@"IT2_SUITE"] = NSBundle.mainBundle.infoDictionary[@"CFBundleExecutable"];

    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:python];
    task.arguments = @[[_folder stringByAppendingPathComponent:@"iterm.py"]];
    task.currentDirectoryURL = [NSURL fileURLWithPath:home];
    task.environment = environment;
    task.standardInput = NSFileHandle.fileHandleWithNullDevice;
    NSString *logPath = [home stringByAppendingPathComponent:AgentDeckLog];
    NSFileHandle *log = [NSFileHandle fileHandleForWritingAtPath:logPath];
    if (log) {
        [log seekToEndOfFile];
        task.standardOutput = log;
        task.standardError = log;
    }
    __weak AgentDeck *weakSelf = self;
    task.terminationHandler = ^(NSTask *ended) { [weakSelf controllerEnded:ended]; };
    NSError *error;
    if (![task launchAndReturnError:&error]) {
        AgentDeckNote([@"Could not start the deck controller: " stringByAppendingString:error.localizedDescription]);
        return NO;
    }
    _controller = task;
    _started = NSDate.date;
    return YES;
}

// The controller keeps running while the app is open; it comes back if it stops.
- (void)controllerEnded:(NSTask *)ended {
    dispatch_async(_queue, ^{
        if (self->_quitting || ended != self->_controller) return;
        self->_pause = -[self->_started timeIntervalSinceNow] > 60 ? 1 : MIN(self->_pause * 2, 30);
        [NSThread sleepForTimeInterval:self->_pause];
        if (!self->_quitting && !self->_controller.running) [self ensureController];
    });
}

// A one-time key to iTerm2's Python API, as iTerm2 gives its own scripts.
- (NSDictionary *)apiAccess {
    Class jar = NSClassFromString(@"iTermWebSocketCookieJar");
    Class identifiers = NSClassFromString(@"iTermAPIConnectionIdentifierController");
    Class entries = NSClassFromString(@"iTermScriptHistoryEntry");
    Class history = NSClassFromString(@"iTermScriptHistory");
    if (!jar || !identifiers || !entries || !history) {
        AgentDeckNote(@"This version of iTerm2 does not give the deck controller a key. Run build-app again.");
        return nil;
    }
    NSString *cookie = [[jar sharedInstance] randomStringForCookie];
    NSString *key = NSUUID.UUID.UUIDString;
    NSString *identifier = [[identifiers sharedInstance] identifierForKey:key];
    id entry = [[entries alloc] initWithName:@"Agent Deck" fullPath:nil identifier:identifier relaunch:nil];
    [[history sharedInstance] addHistoryEntry:entry];
    return @{@"ITERM2_COOKIE": cookie, @"ITERM2_KEY": key};
}

// One JSON line out, one JSON line back over the controller's socket.
- (NSDictionary *)request:(NSDictionary *)payload timeout:(int)seconds {
    NSString *path = [_folder stringByAppendingPathComponent:@"iterm.sock"];
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    if (strlen(path.fileSystemRepresentation) >= sizeof(address.sun_path)) return nil;
    strlcpy(address.sun_path, path.fileSystemRepresentation, sizeof(address.sun_path));
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return nil;
    NSDictionary *reply = nil;
    struct timeval wait = {seconds, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &wait, sizeof(wait));
    int quiet = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &quiet, sizeof(quiet));
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0) {
        NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:payload options:0 error:nil] mutableCopy];
        [data appendBytes:"\n" length:1];
        if (write(fd, data.bytes, data.length) == (ssize_t)data.length) {
            NSMutableData *received = [NSMutableData data];
            char chunk[4096];
            ssize_t count;
            while (!memchr(received.bytes, '\n', received.length) && (count = read(fd, chunk, sizeof(chunk))) > 0) {
                [received appendBytes:chunk length:count];
            }
            const char *end = memchr(received.bytes, '\n', received.length);
            if (end) {
                NSData *line = [received subdataWithRange:NSMakeRange(0, end - (const char *)received.bytes)];
                reply = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
            }
        }
    }
    close(fd);
    return [reply isKindOfClass:NSDictionary.class] ? reply : nil;
}

@end

#pragma mark Loading

// Nothing splits a tab here, so a tab of several panes is a deck; a tab of one
// is a plain terminal (one opened for agd run).
static BOOL (*AgentDeckCloseSession)(id, SEL, id);

static BOOL AgentDeckIsPane(id session) {
    id tab = [session respondsToSelector:@selector(delegate)] ? [session performSelector:@selector(delegate)] : nil;
    NSArray *panes = [tab respondsToSelector:@selector(sessions)] ? [tab performSelector:@selector(sessions)] : nil;
    return ![panes isKindOfClass:NSArray.class] || panes.count > 1;
}

static void AgentDeckReplace(Class cls, SEL selector, id block) {
    Method method = class_getInstanceMethod(cls, selector);
    if (method) method_setImplementation(method, imp_implementationWithBlock(block));
    else AgentDeckNote([@"iTerm2 has changed; missing " stringByAppendingString:NSStringFromSelector(selector)]);
}

__attribute__((constructor)) static void AgentDeckLoad(void) {
    @autoreleasepool {
        [AgentDeck applySettings];
        Class delegate = NSClassFromString(@"iTermApplicationDelegate");
        AgentDeckReplace(delegate, @selector(applicationDockMenu:), ^NSMenu *(id me, NSApplication *app) {
            return [AgentDeck.shared dockMenu];
        });
        AgentDeckReplace(delegate, @selector(applicationShouldHandleReopen:hasVisibleWindows:), ^BOOL(id me, NSApplication *app, BOOL visible) {
            if (!visible) [AgentDeck.shared showDecks];
            return NO;
        });
        AgentDeckReplace(delegate, @selector(applicationOpenUntitledFile:), ^BOOL(id me, NSApplication *app) {
            return NO;
        });
        AgentDeckReplace(delegate, @selector(newWindow:), ^(id me, id sender) {
            [AgentDeck.shared newDeck:sender];
        });
        // A deck keeps its panels: ⌘W, a pane's close button and Close in its
        // menu leave them in place, and nothing splits a plain shell into a deck.
        // A deck's tab and the window's own close button still close decks, and
        // other terminals close as usual.
        Class terminal = NSClassFromString(@"PseudoTerminal");
        Method close = class_getInstanceMethod(terminal, @selector(closeSessionWithConfirmation:));
        if (close) AgentDeckCloseSession = (BOOL (*)(id, SEL, id))method_getImplementation(close);
        AgentDeckReplace(terminal, @selector(closeSessionWithConfirmation:), ^BOOL(id me, id session) {
            if (AgentDeckIsPane(session) || !AgentDeckCloseSession) return NO;
            return AgentDeckCloseSession(me, @selector(closeSessionWithConfirmation:), session);
        });
        for (NSString *name in @[@"splitVertically:", @"splitHorizontally:"]) {
            AgentDeckReplace(terminal, NSSelectorFromString(name), ^(id me, id sender) {});
        }
        [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidFinishLaunchingNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
            // After iTerm2's own launch work, which starts the Python API.
            dispatch_async(dispatch_get_main_queue(), ^{ [AgentDeck.shared didLaunch]; });
        }];
        // Before iTerm2 closes the windows on quitting, so the decks open now are kept for next time.
        for (NSString *name in @[@"iTermApplicationWillTerminate", NSApplicationWillTerminateNotification]) {
            [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *note) {
                [AgentDeck.shared willQuit];
            }];
        }
    }
}
