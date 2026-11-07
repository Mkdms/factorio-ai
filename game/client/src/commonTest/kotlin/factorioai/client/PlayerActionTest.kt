package factorioai.client

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.serialization.json.*

class PlayerActionTest {
    private fun parse(value: String) = parsePlayerAction(Json.parseToJsonElement(value).jsonObject)

    @Test
    fun actionsWithoutDataRejectTargetsAndPositions() {
        val request = parse("""{"action":"clear_cursor"}""")
        assertEquals("clear_cursor", request.action)
        assertEquals(1, request.count)
        assertNull(request.target)
        assertFailsWith<IllegalArgumentException> {
            parse("""{"action":"open_gui","target":{"source":"player_inventory","slot":1}}""")
        }
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"clear_cursor","position":{"x":1,"y":2}}""") }
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"mine"}""") }
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"clear_cursor","count":0}""") }
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"clear_cursor","count":257}""") }
    }

    @Test
    fun transfersRequireACompleteTarget() {
        val request =
            parse(
                """{"action":"cursor_split","count":37,"target":{"source":"entity_inventory","inventory":2,"slot":0,"item":12,"quality":1}}"""
            )
        assertEquals(37, request.count)
        assertEquals(StackTarget("entity_inventory", 2, 0, false, 12, 1, 0), request.target)
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"cursor_transfer"}""") }
        assertFailsWith<IllegalArgumentException> {
            parse("""{"action":"cursor_transfer","target":{"source":"nowhere","slot":0}}""")
        }
        assertFailsWith<IllegalArgumentException> {
            parse("""{"action":"cursor_transfer","target":{"source":"player_inventory"}}""")
        }
        assertFailsWith<IllegalArgumentException> {
            parse("""{"action":"cursor_transfer","target":{"source":"player_inventory","slot":70000}}""")
        }
    }

    @Test
    fun selectionTakesAFinitePositionAndCloseTakesFlags() {
        val select = parse("""{"action":"select_entity","position":{"x":-4.5,"y":3.5}}""")
        assertEquals(-4.5 to 3.5, select.x to select.y)
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"select_entity"}""") }
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"select_entity","position":{"x":1}}""") }
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"select_entity","position":{"x":1e9,"y":0}}""") }
        val close = parse("""{"action":"close_gui","play_sound":false}""")
        assertEquals(false to false, close.openedByBrowsing to close.playSound)
        assertEquals(true, parse("""{"action":"close_gui"}""").playSound)
        assertFailsWith<IllegalArgumentException> { parse("""{"action":"clear_cursor","play_sound":false}""") }
    }

    @Test
    fun schemaListsEveryActionAndSource() {
        val schema = playerActionSchema()
        val actions = schema.getValue("action").jsonObject.getValue("enum").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(playerActionKinds.keys.sorted(), actions)
        val sources =
            schema.getValue("target").jsonObject.getValue("properties").jsonObject.getValue("source").jsonObject
                .getValue("enum").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(stackSources, sources)
    }
}
