@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package factorioai.client

import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.toCPointer
import kotlinx.cinterop.usePinned
import kotlinx.cinterop.ULongVar
import kotlinx.cinterop.value
import platform.windows.HANDLE
import platform.windows.ReadProcessMemory

/** Absolute-address reads of the attached process (heap included); each failure names the address. */
internal class ProcessMemory(private val process: HANDLE) {
    fun read(address: ULong, size: Int): ByteArray = memScoped {
        require(size in 1..(1 shl 20)) { "Unsupported read size $size" }
        val bytes = ByteArray(size)
        val count = alloc<ULongVar>()
        check(
            bytes.usePinned {
                ReadProcessMemory(
                    process,
                    address.toLong().toCPointer<ByteVar>(),
                    it.addressOf(0),
                    size.toULong(),
                    count.ptr,
                )
            } != 0 && count.value == size.toULong()
        ) {
            "Cannot read process memory at 0x${address.toString(16)} ($size bytes)"
        }
        bytes
    }

    fun u64(address: ULong): ULong = read(address, 8).u64(0)

    fun u32(address: ULong): UInt = read(address, 4).u32(0)

    fun u16(address: ULong): UInt = read(address, 2).u16(0)

    fun u8(address: ULong): UInt = read(address, 1)[0].toUInt() and 0xFFu

    /** MSVC std::string: 16 bytes of inline text or a pointer, then size and capacity (capacity >= 16 means heap). */
    fun string(address: ULong): String {
        val raw = read(address, 32)
        val size = raw.u64(16)
        val capacity = raw.u64(24)
        check(size <= 4096uL) { "Implausible string length $size at 0x${address.toString(16)}" }
        val bytes = if (capacity >= 16uL) read(raw.u64(0), size.toInt()) else raw.copyOfRange(0, size.toInt())
        return bytes.decodeToString()
    }
}

internal fun ByteArray.u64(offset: Int): ULong =
    (0 until 8).fold(0uL) { acc, i -> acc or ((this[offset + i].toULong() and 0xFFuL) shl (8 * i)) }

internal fun ByteArray.u32(offset: Int): UInt =
    (0 until 4).fold(0u) { acc, i -> acc or ((this[offset + i].toUInt() and 0xFFu) shl (8 * i)) }

internal fun ByteArray.u16(offset: Int): UInt =
    (this[offset].toUInt() and 0xFFu) or ((this[offset + 1].toUInt() and 0xFFu) shl 8)

private fun plausible(pointer: ULong) = pointer > 0x10000uL && pointer < 0x7FFFFFFFFFFFuL

/** One memory_read against the attached client. */
internal fun readProcessMemory(process: HANDLE, layouts: MemoryLayouts, request: MemoryReadRequest): MemorySnapshot {
    val memory = ProcessMemory(process)
    return when (request.kind) {
        "item_ids" ->
            MemorySnapshot(
                request.kind,
                ids = registry(memory, layouts.itemRegistry, layouts.itemPrototypeName, layouts.itemPrototypeId, 2),
            )
        "quality_ids" ->
            MemorySnapshot(
                request.kind,
                ids = registry(memory, layouts.qualityRegistry, layouts.qualityPrototypeName, layouts.qualityPrototypeId, 1),
            )
        "player" -> player(memory, layouts)
        else -> error("Unsupported memory read: ${request.kind}")
    }
}

/** PrototypeList<X>::indexToPrototype: every entry's own id must equal its index, or the table is not what we think. */
private fun registry(memory: ProcessMemory, vector: ULong, nameOffset: UInt, idOffset: UInt, idBytes: Int): Map<String, Int> {
    val begin = memory.u64(vector)
    val end = memory.u64(vector + 8uL)
    check(begin <= end && (end - begin) % 8uL == 0uL && (end - begin) / 8uL <= 65536uL) {
        "Prototype registry is not a plausible vector"
    }
    val count = ((end - begin) / 8uL).toInt()
    if (count == 0) return emptyMap()
    val pointers = memory.read(begin, count * 8)
    val ids = LinkedHashMap<String, Int>()
    for (index in 0 until count) {
        val prototype = pointers.u64(index * 8)
        if (prototype == 0uL) continue
        check(plausible(prototype)) { "Implausible prototype pointer at registry index $index" }
        val id = if (idBytes == 2) memory.u16(prototype + idOffset).toInt() else memory.u8(prototype + idOffset).toInt()
        check(id == index) { "Prototype id $id differs from its registry index $index" }
        ids[memory.string(prototype + nameOffset)] = index
    }
    return ids
}

private data class PlayerReading(val x: Double, val y: Double, val size: Int, val stacks: List<MemoryStack>)

private fun player(memory: ProcessMemory, l: MemoryLayouts): MemorySnapshot {
    // `global` is either the GlobalContext itself or a pointer to it (the PDB does not say): both readings are tried and a
    // chain is accepted only when the player's own back references (ControllerManager.player, Controller.player) agree.
    fun resolve(game: ULong): ULong? {
        if (!plausible(game)) return null
        return runCatching {
                val player = memory.u64(game + l.gameLocalPlayer)
                if (!plausible(player) || memory.u64(player + l.playerControllerManager + l.managerPlayer) != player)
                    return null
                val controller = memory.u64(player + l.playerControllerManager + l.managerController)
                if (!plausible(controller) || memory.u64(controller + l.controllerPlayer) != player) return null
                controller
            }
            .getOrNull()
    }
    val direct = runCatching { memory.u64(l.global + l.globalGame) }.getOrDefault(0uL)
    val indirect =
        runCatching {
                val context = memory.u64(l.global)
                if (plausible(context)) memory.u64(context + l.globalGame) else 0uL
            }
            .getOrDefault(0uL)
    val controller =
        resolve(direct) ?: resolve(indirect)
            ?: error("No local player with a consistent controller (not in a loaded world?)")
    // RTTI: vtable[-1] is the complete object locator; its type descriptor is image-relative on x64.
    val vtable = memory.u64(controller)
    check(plausible(vtable)) { "Controller has no vtable" }
    val locator = memory.u64(vtable - 8uL)
    check(plausible(locator) && memory.u32(locator) == 1u) { "Controller RTTI is not an x64 locator" }
    val descriptor = l.moduleBase + memory.u32(locator + 12uL).toULong()
    check(descriptor == l.characterControllerType) {
        "The local player is not controlling a character (remote view, editor, spectator or cutscene)"
    }
    val character = memory.u64(controller + l.controllerCharacter)
    check(plausible(character)) { "The character controller has no character" }

    fun reading(): PlayerReading {
        val position = memory.read(character + l.characterEntity + l.entityPosition, 8)
        val x = position.u32(l.positionX.toInt()).toInt() / 256.0
        val y = position.u32(l.positionY.toInt()).toInt() / 256.0
        val inventory = character + l.characterInventory
        val data = memory.u64(inventory + l.inventoryData)
        val size = memory.u16(inventory + l.inventorySize).toInt()
        check(plausible(data) && size in 1..1000) { "Implausible inventory (data 0x${data.toString(16)}, $size slots)" }
        val stride = l.stackSize.toInt()
        val blob = memory.read(data, size * stride)
        val stacks = ArrayList<MemoryStack>()
        for (index in 0 until size) {
            val base = index * stride
            val count = blob.u32(base + l.stackCount.toInt()).toInt()
            if (count == 0) continue
            stacks.add(
                MemoryStack(
                    index + 1,
                    blob.u16(base + l.stackItem.toInt()).toInt(),
                    blob[base + l.stackQuality.toInt()].toInt() and 0xFF,
                    count,
                )
            )
        }
        return PlayerReading(x, y, size, stacks)
    }
    // The game thread keeps mutating: two consecutive identical readings count as stable.
    var current = reading()
    var reads = 1
    var stable = false
    while (reads < 5) {
        val next = reading()
        reads++
        if (next == current) {
            stable = true
            break
        }
        current = next
    }
    return MemorySnapshot(
        "player",
        x = current.x,
        y = current.y,
        inventorySize = current.size,
        stacks = current.stacks,
        reads = reads,
        stable = stable,
    )
}
