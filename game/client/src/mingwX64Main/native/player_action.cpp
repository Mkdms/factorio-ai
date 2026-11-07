#include "player_action.h"
#include "protocol.h"
#include <cmath>
#include <cstring>
#include <limits>

namespace {
template <class T> T read(const void *object, unsigned offset) {
    T result;
    memcpy(&result, static_cast<const unsigned char *>(object) + offset, sizeof(result));
    return result;
}

template <class T> void write(void *object, unsigned offset, T value) {
    memcpy(static_cast<unsigned char *>(object) + offset, &value, sizeof(value));
}

template <class T> T function(const Symbols &symbols, FmSymbol id) {
    return reinterpret_cast<T>(symbols.address[id]);
}

// MapPosition stores tiles as a 32-bit fixed-point number with 8 fractional bits.
int32_t fixedPoint(double value) {
    require(std::isfinite(value) && std::fabs(value) < 8000000.0, "Map position is outside the representable range");
    return static_cast<int32_t>(std::llround(value * 256.0));
}
} // namespace

void sendPlayerAction(const Symbols &symbols, void *game, const FmPlayerActionRequest &request, FmResult &result) {
    const auto &layout = symbols.playerAction;
    const auto &chat = symbols.chat;
    require(layout.supported && chat.sendSupported && symbols.world.supported && game,
            "Player action adapter is unavailable");
    require(request.count >= 1 && request.count <= 256, "Player action count must be between 1 and 256");
    const auto *handler = read<void *>(game, chat.gameHandler);
    require(handler && read<uint32_t>(handler, chat.handlerInputType) != chat.replayInput,
            "Player actions are unavailable for the current input handler");
    void *player = function<void *(*)(void *)>(symbols, LocalPlayer)(game);
    require(player, "Player action requires a local player");
    const uint16_t type = request.type;
    const auto noData = function<bool (*)(uint16_t)>(symbols, ActionNoData);
    const auto dataType = function<bool (*)(uint16_t, const void *)>(symbols, ActionDataType);
    uint64_t typeInfo = 0;
    unsigned dataSize = 0;
    switch (request.dataKind) {
    case 0:
        require(noData(type), "This action carries data; the request names none");
        break;
    case 1:
        typeInfo = symbols.address[StackLocationTypeInfo];
        dataSize = layout.stackSize;
        break;
    case 2:
        typeInfo = symbols.address[MapPositionTypeInfo];
        dataSize = layout.positionSize;
        break;
    case 3:
        typeInfo = symbols.address[CloseGuiTypeInfo];
        dataSize = layout.closeSize;
        break;
    default:
        require(false, "Unknown player action data kind");
    }
    if (request.dataKind) {
        // The game's own table decides which data type each action carries; a mismatch is refused, never guessed.
        require(!noData(type) && dataType(type, reinterpret_cast<const void *>(typeInfo)),
                "Action data type does not match the game's definition for this action");
        require(dataSize && layout.actionBuffer + dataSize <= layout.actionSize, "Action data exceeds the action buffer");
    }
    alignas(16) unsigned char action[256]{};
    require(layout.actionSize <= sizeof(action), "Action storage exceeds bound");
    const auto playerIndex = read<uint16_t>(player, symbols.world.playerIndex);
    for (uint32_t i = 0; i < request.count; ++i) {
        memset(action, 0, sizeof(action));
        write(action, layout.actionType, type);
        write(action, layout.actionPlayer, playerIndex);
        unsigned char *data = action + layout.actionBuffer;
        if (request.dataKind == 1) {
            write(data, layout.stackItem, request.item);
            write(data, layout.stackQuality, request.quality);
            write(data, layout.stackNumber, request.itemNumber);
            write(data, layout.stackLocation + layout.locationStandalone, request.standalone);
            write(data, layout.stackLocation + layout.locationInventory, request.inventory);
            write(data, layout.stackLocation + layout.locationSlot, request.slot);
            write(data, layout.stackLocation + layout.locationSource, request.source);
        } else if (request.dataKind == 2) {
            write(data, layout.positionX, fixedPoint(request.x));
            write(data, layout.positionY, fixedPoint(request.y));
        } else if (request.dataKind == 3) {
            write(data, layout.closeBrowsing, uint8_t(request.flagA != 0));
            write(data, layout.closeSound, uint8_t(request.flagB != 0));
        }
        // The game's destructor handles a moved-from or trivially copyable value either way.
        struct DestroyAction {
            const Symbols &symbols;
            void *value;

            ~DestroyAction() {
                function<void (*)(void *)>(symbols, ActionDestroy)(value);
            }
        } cleanup{symbols, action};
        function<void (*)(const void *, void *)>(symbols, PlayerSend)(player, action);
        ++result.playerActionsSent;
    }
}
