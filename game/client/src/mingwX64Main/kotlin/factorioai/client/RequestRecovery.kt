@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package factorioai.client

import factorioai.client.nativebridge.Shared
import factorioai.client.nativebridge.fm_cancel_request
import factorioai.client.nativebridge.fm_take_result
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.pointed
import kotlinx.coroutines.delay

/** Requires the process mutex. A reconnect must not overwrite an orphaned resident request. */
internal suspend fun awaitResidentIdle(
    state: CPointer<Shared>,
    cancelPrevious: Boolean,
    alive: () -> Boolean,
) {
    if (cancelPrevious) fm_cancel_request(state)
    while (state.pointed.command != 0) {
        check(alive()) { "Factorio process exited" }
        if (fm_take_result(state) != 0) break
        check(state.pointed.command in 1..3) { "Invalid resident command state" }
        delay(10)
    }
}
