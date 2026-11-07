#include "player_action.h"
#include <cassert>
#include <cstddef>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace {
struct Player {
    uint16_t index;
    uint32_t *handler;
};

struct Location {
    uint8_t standalone, inventory;
    uint16_t slot;
    uint8_t source;
};

struct Stack {
    uint16_t item;
    uint8_t quality;
    uint64_t number;
    Location location;
};

struct Position {
    int32_t x, y;
};

struct Close {
    uint8_t browsing, sound;
};

struct Action {
    uint64_t tick;
    uint16_t type, player;
    alignas(16) unsigned char buffer[112];
};

constexpr uint16_t kClear = 10, kSelect = 90, kClose = 61, kSplit = 80;
std::vector<Action> sent;
int destroyed{};

void *localPlayer(void *game) {
    return game;
}

bool noData(uint16_t type) {
    return type == kClear;
}

bool dataType(uint16_t type, const void *info) {
    if (type == kSplit)
        return info == reinterpret_cast<const void *>(1001);
    if (type == kSelect)
        return info == reinterpret_cast<const void *>(1002);
    if (type == kClose)
        return info == reinterpret_cast<const void *>(1003);
    return false;
}

void send(const void *receiver, void *value) {
    const auto *player = static_cast<const Player *>(receiver);
    const auto &action = *static_cast<Action *>(value);
    assert(action.player == player->index && action.tick == 0);
    sent.push_back(action);
}

void destroyAction(void *) {
    ++destroyed;
}

Symbols symbols() {
    Symbols result{};
    result.address[LocalPlayer] = reinterpret_cast<uintptr_t>(localPlayer);
    result.address[ActionNoData] = reinterpret_cast<uintptr_t>(noData);
    result.address[ActionDataType] = reinterpret_cast<uintptr_t>(dataType);
    result.address[PlayerSend] = reinterpret_cast<uintptr_t>(send);
    result.address[ActionDestroy] = reinterpret_cast<uintptr_t>(destroyAction);
    result.address[StackLocationTypeInfo] = 1001;
    result.address[MapPositionTypeInfo] = 1002;
    result.address[CloseGuiTypeInfo] = 1003;
    result.world.supported = 1;
    result.world.playerIndex = offsetof(Player, index);
    auto &chat = result.chat;
    chat.sendSupported = 1;
    chat.gameHandler = offsetof(Player, handler);
    chat.replayInput = 23;
    auto &layout = result.playerAction;
    layout.supported = 1;
    layout.actionSize = sizeof(Action);
    layout.actionType = offsetof(Action, type);
    layout.actionPlayer = offsetof(Action, player);
    layout.actionBuffer = offsetof(Action, buffer);
    layout.stackSize = sizeof(Stack);
    layout.stackItem = offsetof(Stack, item);
    layout.stackQuality = offsetof(Stack, quality);
    layout.stackNumber = offsetof(Stack, number);
    layout.stackLocation = offsetof(Stack, location);
    layout.locationStandalone = offsetof(Location, standalone);
    layout.locationInventory = offsetof(Location, inventory);
    layout.locationSlot = offsetof(Location, slot);
    layout.locationSource = offsetof(Location, source);
    layout.positionSize = sizeof(Position);
    layout.positionX = offsetof(Position, x);
    layout.positionY = offsetof(Position, y);
    layout.closeSize = sizeof(Close);
    layout.closeBrowsing = offsetof(Close, browsing);
    layout.closeSound = offsetof(Close, sound);
    return result;
}

template <class T> T payload(const Action &action) {
    T value;
    memcpy(&value, action.buffer, sizeof(value));
    return value;
}
} // namespace

int main() {
    auto adapter = symbols();
    uint32_t handler = 17;
    Player player{42, &handler};
    FmResult result{};
    // One action without data.
    FmPlayerActionRequest request{};
    request.type = kClear;
    request.count = 1;
    sendPlayerAction(adapter, &player, request, result);
    assert(sent.size() == 1 && sent[0].type == kClear && destroyed == 1 && result.playerActionsSent == 1);
    // A stack transfer, repeated: every copy carries the same target.
    request = FmPlayerActionRequest{};
    request.type = kSplit;
    request.dataKind = 1;
    request.count = 37;
    request.item = 12;
    request.quality = 1;
    request.itemNumber = 7;
    request.inventory = 2;
    request.slot = 5;
    request.source = 4;
    sendPlayerAction(adapter, &player, request, result);
    assert(sent.size() == 38 && result.playerActionsSent == 38 && destroyed == 38);
    const auto stack = payload<Stack>(sent[20]);
    assert(stack.item == 12 && stack.quality == 1 && stack.number == 7 && stack.location.standalone == 0 &&
           stack.location.inventory == 2 && stack.location.slot == 5 && stack.location.source == 4);
    // A position becomes 8-bit fixed point.
    request = FmPlayerActionRequest{};
    request.type = kSelect;
    request.dataKind = 2;
    request.count = 1;
    request.x = -4.5;
    request.y = 3.25;
    sendPlayerAction(adapter, &player, request, result);
    const auto position = payload<Position>(sent.back());
    assert(position.x == -4 * 256 - 128 && position.y == 3 * 256 + 64);
    // Close flags.
    request = FmPlayerActionRequest{};
    request.type = kClose;
    request.dataKind = 3;
    request.count = 1;
    request.flagB = 1;
    sendPlayerAction(adapter, &player, request, result);
    const auto close = payload<Close>(sent.back());
    assert(close.browsing == 0 && close.sound == 1 && result.playerActionsSent == 40);
    // Mismatches are refused before anything is sent.
    const auto before = sent.size();
    request = FmPlayerActionRequest{};
    request.type = kSplit;
    request.dataKind = 2; // the game says this action carries a stack location, not a position
    request.count = 1;
    try {
        sendPlayerAction(adapter, &player, request, result);
        assert(false);
    } catch (const std::runtime_error &) {
    }
    request.type = kClear;
    request.dataKind = 1; // the game says this action carries no data
    try {
        sendPlayerAction(adapter, &player, request, result);
        assert(false);
    } catch (const std::runtime_error &) {
    }
    request.type = kSelect;
    request.dataKind = 0;
    try {
        sendPlayerAction(adapter, &player, request, result);
        assert(false);
    } catch (const std::runtime_error &) {
    }
    request.dataKind = 2;
    request.count = 0;
    try {
        sendPlayerAction(adapter, &player, request, result);
        assert(false);
    } catch (const std::runtime_error &) {
    }
    request.count = 1;
    handler = adapter.chat.replayInput;
    try {
        sendPlayerAction(adapter, &player, request, result);
        assert(false);
    } catch (const std::runtime_error &) {
    }
    assert(sent.size() == before && result.playerActionsSent == 40);
}
