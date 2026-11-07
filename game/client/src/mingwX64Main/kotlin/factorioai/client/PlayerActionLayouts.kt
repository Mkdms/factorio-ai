@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package factorioai.client

import factorioai.client.nativebridge.FmPlayerActionLayout

/**
 * Offsets and enum values for building game InputAction values directly (player_action). Every layout comes from
 * the game's own debug information; the resident still asks the game which data type an action carries before
 * sending it.
 */
internal class PlayerActionLayouts(debug: DebugTypes) {
    private val stack = "ClientItemStackLocation"
    private val idWithQuality = "IDWithQuality<ID<ItemPrototype,unsigned short> >"
    private val relative = "RelativeItemStackLocation"
    private val stackSize = debug.size(stack).also { check(it in 8u..64u) }
    private val actionSize = debug.size("InputAction")
    private val actionType = debug.namedMember("InputAction", "type", "InputActionType", 2u)
    private val actionPlayer = debug.scalarMember("InputAction", "playerIndex", 2u, 7u)
    private val actionBuffer = debug.byteArrayMember("InputAction", "buffer", stackSize)
    private val itemId = debug.namedMember(stack, "itemID", idWithQuality, debug.aggregateSize(idWithQuality))
    private val stackItem = itemId + debug.namedMember(idWithQuality, "baseID", "ID<ItemPrototype,unsigned short>", 2u)
    private val stackQuality =
        itemId + debug.namedMember(idWithQuality, "qualityID", "ID<QualityPrototype,unsigned char>", 1u)
    private val stackNumber = debug.scalarMember(stack, "targetableItemNumber", 8u, 7u)
    private val stackLocation = debug.namedMember(stack, "location", relative, debug.aggregateSize(relative))
    private val base = debug.directBaseOffset(relative, "ItemStackLocation")
    private val locationStandalone = base + debug.scalarMember("ItemStackLocation", "standaloneStack", 1u, 7u)
    private val locationInventory = base + debug.scalarMember("ItemStackLocation", "inventoryIndex", 1u, 7u)
    private val locationSlot = base + debug.scalarMember("ItemStackLocation", "slotIndex", 2u, 7u)
    private val locationSource = debug.namedMember(relative, "source", "$relative::Source", 1u)
    private val fixed = "FixedPointNumberTemplate<int,8,0>"
    private val positionSize = debug.size("MapPosition").also { check(it == 8u) }
    private val positionX = debug.namedMember("MapPosition", "x", fixed, 4u)
    private val positionY = debug.namedMember("MapPosition", "y", fixed, 4u)
    private val close = "ActionData::CloseGuiData"
    private val closeSize = debug.size(close).also { check(it in 1u..8u) }
    private val closeBrowsing = debug.namedMember(close, "openedByBrowsing", "NamedBool<OpenedByBrowsingTag>", 1u)
    private val closeSound = debug.namedMember(close, "playSound", "NamedBool<PlaySoundTag>", 1u)

    /** Public action name -> InputActionType value. */
    val actionTypes: Map<String, UInt> =
        ACTIONS.mapValues { (_, entry) -> debug.enumValue("InputActionType", entry).also { check(it <= 65535u) } }

    /** Public source name -> RelativeItemStackLocation::Source value. */
    val sources: Map<String, UInt> =
        SOURCES.mapValues { (_, entry) -> debug.enumValue("$relative::Source", entry).also { check(it <= 255u) } }

    init {
        debug.plainMembers("InputAction", setOf("updateTick", "type", "playerIndex", "align", "buffer"))
        check(actionBuffer + stackSize <= actionSize && actionBuffer + positionSize <= actionSize) {
            "InputAction buffer cannot hold the action data"
        }
    }

    fun write(target: FmPlayerActionLayout) {
        target.supported = 1u
        target.actionSize = actionSize
        target.actionType = actionType
        target.actionPlayer = actionPlayer
        target.actionBuffer = actionBuffer
        target.stackSize = stackSize
        target.stackItem = stackItem
        target.stackQuality = stackQuality
        target.stackNumber = stackNumber
        target.stackLocation = stackLocation
        target.locationStandalone = locationStandalone
        target.locationInventory = locationInventory
        target.locationSlot = locationSlot
        target.locationSource = locationSource
        target.positionSize = positionSize
        target.positionX = positionX
        target.positionY = positionY
        target.closeSize = closeSize
        target.closeBrowsing = closeBrowsing
        target.closeSound = closeSound
    }

    companion object {
        /** Public name -> game enum entry. The data kind of each is fixed in commonMain playerActionKinds. */
        val ACTIONS =
            mapOf(
                "clear_cursor" to "ClearCursor",
                "open_gui" to "OpenGui",
                "close_gui" to "CloseGui",
                "select_entity" to "SelectedEntityChanged",
                "cursor_transfer" to "CursorTransfer",
                "cursor_split" to "CursorSplit",
                "stack_transfer" to "StackTransfer",
                "inventory_transfer" to "InventoryTransfer",
            )
        val SOURCES =
            mapOf(
                "player_inventory" to "PlayerInventory",
                "player_external_inventory" to "PlayerExternalInventory",
                "entity_inventory" to "EntityInventory",
                "vehicle_inventory" to "VehicleInventory",
                "opened_item_inventory" to "OpenedItemInventory",
                "opened_equipment_inventory" to "OpenedEquipmentInventory",
                "player_quickbar" to "PlayerQuickBar",
                "opened_script_inventory" to "OpenedScriptInventory",
            )
    }
}
