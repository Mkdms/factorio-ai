@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package factorioai.client

/**
 * Offsets for memory_read: the host reads the attached client's memory from outside the process (ReadProcessMemory);
 * nothing runs inside the game. Every layout comes from the game's debug information at attach and the adapter is
 * refused when a type, size or base class differs from what the chain expects.
 *
 * Chain: `global` (the static GlobalContext, or a pointer to it) → game → localPlayer → controllerManager.controller
 * → (CharacterController) character → Entity.position / Character.inventory → ItemStack[]. Prototype ids come from the
 * static registries `PrototypeList<X>::indexToPrototype` (std::vector<X*>, indexed by the numeric id).
 */
internal class MemoryLayouts(
    debug: DebugTypes,
    /** Address of the `global` symbol. */
    val global: ULong,
    /** Image base, for RTTI type descriptors (image-relative in the x64 complete object locator). */
    val moduleBase: ULong,
    itemRegistries: List<ULong>,
    qualityRegistries: List<ULong>,
    characterControllerTypes: List<ULong>,
) {
    private val string = "std::basic_string<char,std::char_traits<char>,std::allocator<char> >"
    private val itemId = "ID<ItemPrototype,unsigned short>"
    private val qualityId = "ID<QualityPrototype,unsigned char>"
    private val targeter = "Targeter<Character,0,0>"
    private val itemPrototypeBase = "Prototype<$itemId >"
    private val qualityPrototypeBase = "Prototype<$qualityId >"

    val itemRegistry = itemRegistries.singleOrNull() ?: error("Missing or ambiguous item prototype registry")
    val qualityRegistry = qualityRegistries.singleOrNull() ?: error("Missing or ambiguous quality prototype registry")
    /** `??_R0?AVCharacterController@@@8`: the controller must be a CharacterController before its character is read. */
    val characterControllerType =
        characterControllerTypes.singleOrNull() ?: error("Missing or ambiguous CharacterController type descriptor")

    val globalGame = debug.pointerMember("GlobalContext", "game", "Game")
    val gameLocalPlayer = debug.pointerMember("Game", "localPlayer", "Player")
    val playerControllerManager =
        debug.namedMember("Player", "controllerManager", "ControllerManager", debug.aggregateSize("ControllerManager"))
    val managerPlayer = debug.pointerMember("ControllerManager", "player", "Player")
    val managerController = debug.pointerMember("ControllerManager", "controller", "Controller")
    val controllerPlayer = debug.pointerMember("Controller", "player", "Player")
    /** CharacterController.character is a Targeter whose TargeterBase.target points at the Character (its Targetable base is at offset 0). */
    val controllerCharacter =
        debug.namedMember("CharacterController", "character", targeter, debug.aggregateSize(targeter)) +
            debug.directBaseOffset(targeter, "TargeterBase") +
            debug.pointerMember("TargeterBase", "target", "Targetable")
    val characterEntity =
        debug.directBaseOffset("Character", "EntityWithOwner") +
            debug.directBaseOffset("EntityWithOwner", "EntityWithHealth") +
            debug.directBaseOffset("EntityWithHealth", "Entity")
    val entityPosition = debug.namedMember("Entity", "position", "MapPosition", 8u)
    val positionX = debug.namedMember("MapPosition", "x", "FixedPointNumberTemplate<int,8,0>", 4u)
    val positionY = debug.namedMember("MapPosition", "y", "FixedPointNumberTemplate<int,8,0>", 4u)
    val characterInventory =
        debug.namedMember("Character", "inventory", "InventoryWithFilters", debug.aggregateSize("InventoryWithFilters")) +
            debug.directBaseOffset("InventoryWithFilters", "Inventory")
    val inventoryData =
        debug.namedMember("Inventory", "data", "std::unique_ptr<ItemStack [0],std::default_delete<ItemStack [0]> >", 8u)
    val inventorySize = debug.scalarMember("Inventory", "dataSize", 2u, 7u)
    val stackSize = debug.size("ItemStack")
    val stackCount = debug.scalarMember("ItemStack", "count", 4u, 7u)
    val stackItem = debug.namedMember("ItemStack", "itemID", itemId, 2u)
    val stackQuality = debug.namedMember("ItemStack", "qualityID", qualityId, 1u)
    val itemPrototypeName =
        debug.directBaseOffset("ItemPrototype", itemPrototypeBase) +
            debug.directBaseOffset(itemPrototypeBase, "PrototypeBase") +
            debug.namedMember("PrototypeBase", "name", string, 32u)
    val itemPrototypeId =
        debug.directBaseOffset("ItemPrototype", itemPrototypeBase) + debug.namedMember(itemPrototypeBase, "id", itemId, 2u)
    val qualityPrototypeName =
        debug.directBaseOffset("QualityPrototype", qualityPrototypeBase) +
            debug.directBaseOffset(qualityPrototypeBase, "PrototypeBase") +
            debug.namedMember("PrototypeBase", "name", string, 32u)
    val qualityPrototypeId =
        debug.directBaseOffset("QualityPrototype", qualityPrototypeBase) +
            debug.namedMember(qualityPrototypeBase, "id", qualityId, 1u)

    init {
        check(debug.aggregateSize("MapPosition") == 8uL) { "Unexpected MapPosition size" }
        check(stackSize in 8u..64u) { "Unexpected ItemStack size" }
        check(stackCount + 4u <= stackSize && stackItem + 2u <= stackSize && stackQuality + 1u <= stackSize) {
            "ItemStack fields exceed the stack"
        }
    }
}
