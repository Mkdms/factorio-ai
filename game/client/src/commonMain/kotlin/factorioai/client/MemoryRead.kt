package factorioai.client

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** memory_read: one read of the attached client's memory from outside the process; nothing runs inside the game. */
internal data class MemoryReadRequest(val kind: String)

internal val memoryReadKinds = setOf("player", "item_ids", "quality_ids")

internal fun parseMemoryRead(args: JsonObject): MemoryReadRequest {
    require(args.keys.all { it == "kind" }) { "memory_read accepts kind" }
    val kind = requireNotNull(args["kind"]) { "kind is required" }.stringArgument()
    require(kind in memoryReadKinds) { "Unsupported kind: $kind" }
    return MemoryReadRequest(kind)
}

internal fun memoryReadSchema() = buildJsonObject {
    putJsonObject("kind") {
        put("type", "string")
        putJsonArray("enum") { memoryReadKinds.sorted().forEach { add(it) } }
        put(
            "description",
            "player: the local character's map position and main inventory as the client holds them (slot, item id, quality id, count). item_ids / quality_ids: the game's numeric prototype ids by name, the ids player_action targets carry.",
        )
    }
}

/** One occupied inventory slot (1-based) as the client stores it. */
internal data class MemoryStack(val slot: Int, val item: Int, val quality: Int, val count: Int)

/** What one memory read produced; adapters fill the parts their kind covers. */
internal data class MemorySnapshot(
    val kind: String,
    val x: Double? = null,
    val y: Double? = null,
    val inventorySize: Int? = null,
    val stacks: List<MemoryStack> = emptyList(),
    val ids: Map<String, Int> = emptyMap(),
    /** Full reads taken until two consecutive ones agreed (the game thread keeps mutating); false when they never did. */
    val reads: Int = 1,
    val stable: Boolean = true,
)

internal fun MemorySnapshot.toJson(): JsonObject = buildJsonObject {
    put("observation", "memory_read")
    put("kind", kind)
    put("reads", reads)
    put("stable", stable)
    when (kind) {
        "player" -> {
            putJsonObject("position") {
                put("x", x)
                put("y", y)
            }
            putJsonObject("inventory") {
                put("size", inventorySize)
                putJsonArray("stacks") {
                    stacks.forEach { s ->
                        add(
                            buildJsonObject {
                                put("slot", s.slot)
                                put("item", s.item)
                                put("quality", s.quality)
                                put("count", s.count)
                            }
                        )
                    }
                }
            }
        }
        else -> {
            put("count", ids.size)
            putJsonObject("ids") { ids.forEach { (name, id) -> put(name, id) } }
        }
    }
}
