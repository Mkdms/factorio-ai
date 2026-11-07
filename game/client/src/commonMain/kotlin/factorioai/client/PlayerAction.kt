package factorioai.client

import kotlinx.serialization.json.*

/** One item-stack slot as the game addresses it: a source inventory kind, an inventory index and a slot index. */
internal data class StackTarget(
    val source: String,
    val inventory: Int,
    val slot: Int,
    val standalone: Boolean,
    val item: Int,
    val quality: Int,
    val itemNumber: Long,
)

/** A validated player_action request; platform adapters map the names to the game's enum values. */
internal data class PlayerActionRequest(
    val action: String,
    val count: Int,
    val target: StackTarget?,
    val x: Double?,
    val y: Double?,
    val openedByBrowsing: Boolean,
    val playSound: Boolean,
)

/** Which data each public action carries: none, a stack target, a map position or close-GUI flags. */
internal val playerActionKinds =
    mapOf(
        "clear_cursor" to "none",
        "open_gui" to "none",
        "close_gui" to "close",
        "select_entity" to "position",
        "cursor_transfer" to "stack",
        "cursor_split" to "stack",
        "stack_transfer" to "stack",
        "inventory_transfer" to "stack",
    )

internal val stackSources =
    listOf(
        "player_inventory",
        "player_external_inventory",
        "entity_inventory",
        "vehicle_inventory",
        "opened_item_inventory",
        "opened_equipment_inventory",
        "player_quickbar",
        "opened_script_inventory",
    )

internal fun parsePlayerAction(args: JsonObject): PlayerActionRequest {
    require(args.keys.all { it in setOf("action", "count", "target", "position", "opened_by_browsing", "play_sound") }) {
        "player_action accepts action, count, target, position, opened_by_browsing and play_sound"
    }
    val action = requireNotNull(args["action"]) { "action is required" }.stringArgument()
    val kind = requireNotNull(playerActionKinds[action]) { "Unsupported action: $action" }
    val count = args["count"]?.intArgument() ?: 1
    require(count in 1..256) { "count must be between 1 and 256" }
    val target =
        args["target"]?.let { element ->
            require(kind == "stack") { "$action does not take a target" }
            val target = requireNotNull(element as? JsonObject) { "target must be an object" }
            require(target.keys.all { it in setOf("source", "inventory", "slot", "standalone", "item", "quality", "item_number") }) {
                "target accepts source, inventory, slot, standalone, item, quality and item_number"
            }
            val source = requireNotNull(target["source"]) { "target.source is required" }.stringArgument()
            require(source in stackSources) { "Unsupported target.source: $source" }
            val inventory = target["inventory"]?.intArgument() ?: 0
            val slot = requireNotNull(target["slot"]) { "target.slot is required" }.intArgument()
            require(inventory in 0..255 && slot in 0..65535) { "target.inventory must be 0..255 and target.slot 0..65535" }
            val item = target["item"]?.intArgument() ?: 0
            val quality = target["quality"]?.intArgument() ?: 0
            require(item in 0..65535 && quality in 0..255) { "target.item must be 0..65535 and target.quality 0..255" }
            val itemNumber = target["item_number"]?.jsonPrimitive?.longOrNull ?: 0L
            require(itemNumber >= 0) { "target.item_number must not be negative" }
            StackTarget(
                source,
                inventory,
                slot,
                target["standalone"]?.jsonPrimitive?.booleanOrNull ?: false,
                item,
                quality,
                itemNumber,
            )
        }
    require(kind != "stack" || target != null) { "$action requires a target" }
    val position =
        args["position"]?.let { element ->
            require(kind == "position") { "$action does not take a position" }
            val position = requireNotNull(element as? JsonObject) { "position must be an object with x and y" }
            require(position.keys == setOf("x", "y")) { "position must be an object with x and y" }
            val x = position.getValue("x").jsonPrimitive.doubleOrNull
            val y = position.getValue("y").jsonPrimitive.doubleOrNull
            require(
                x != null && y != null && x.isFinite() && y.isFinite() &&
                    kotlin.math.abs(x) < 8_000_000 && kotlin.math.abs(y) < 8_000_000
            ) {
                "position.x and position.y must be finite map coordinates"
            }
            x to y
        }
    require(kind != "position" || position != null) { "$action requires a position" }
    val browsing = args["opened_by_browsing"]?.jsonPrimitive?.booleanOrNull
    val sound = args["play_sound"]?.jsonPrimitive?.booleanOrNull
    require((browsing == null && sound == null) || kind == "close") { "opened_by_browsing and play_sound apply to close_gui only" }
    return PlayerActionRequest(action, count, target, position?.first, position?.second, browsing ?: false, sound ?: true)
}

internal fun playerActionSchema() = buildJsonObject {
    putJsonObject("action") {
        put("type", "string")
        putJsonArray("enum") { playerActionKinds.keys.sorted().forEach { add(it) } }
        put(
            "description",
            "Game input action to submit as the local player. clear_cursor and open_gui carry no data; select_entity takes position; close_gui takes the optional flags; the four transfers take target.",
        )
    }
    putJsonObject("count") {
        put("type", "integer")
        put("minimum", 1)
        put("maximum", 256)
        put("description", "Submit the same action this many times in one safe point (default 1); cursor_split moves one item per action.")
    }
    putJsonObject("target") {
        put("type", "object")
        put(
            "description",
            "Item-stack slot for the transfer actions: source (one of ${stackSources.joinToString()}), inventory index, slot index (0-based), optional standalone, item (prototype id), quality (id) and item_number.",
        )
        putJsonObject("properties") {
            putJsonObject("source") {
                put("type", "string")
                putJsonArray("enum") { stackSources.forEach { add(it) } }
            }
            putJsonObject("inventory") {
                put("type", "integer")
                put("minimum", 0)
                put("maximum", 255)
            }
            putJsonObject("slot") {
                put("type", "integer")
                put("minimum", 0)
                put("maximum", 65535)
            }
            putJsonObject("standalone") { put("type", "boolean") }
            putJsonObject("item") {
                put("type", "integer")
                put("minimum", 0)
                put("maximum", 65535)
            }
            putJsonObject("quality") {
                put("type", "integer")
                put("minimum", 0)
                put("maximum", 255)
            }
            putJsonObject("item_number") {
                put("type", "integer")
                put("minimum", 0)
            }
        }
        putJsonArray("required") {
            add("source")
            add("slot")
        }
    }
    putJsonObject("position") {
        put("type", "object")
        put("description", "Map position for select_entity (tile coordinates on the current surface).")
        putJsonObject("properties") {
            putJsonObject("x") { put("type", "number") }
            putJsonObject("y") { put("type", "number") }
        }
        putJsonArray("required") {
            add("x")
            add("y")
        }
    }
    putJsonObject("opened_by_browsing") {
        put("type", "boolean")
        put("description", "close_gui flag; default false.")
    }
    putJsonObject("play_sound") {
        put("type", "boolean")
        put("description", "close_gui flag; default true.")
    }
}
