#pragma once
#include "observation_storage.h"

// Build one game InputAction from a client request and submit it through Player::sendToListeners, the same
// path chat submission uses. The game owns replication; the result counts dispatched actions only.
void sendPlayerAction(const Symbols &symbols, void *game, const FmPlayerActionRequest &request, FmResult &result);
