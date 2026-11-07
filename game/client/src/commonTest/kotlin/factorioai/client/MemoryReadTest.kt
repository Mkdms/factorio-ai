package factorioai.client

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class MemoryReadTest {
    private fun parse(value: String) = parseMemoryRead(Json.parseToJsonElement(value).jsonObject)

    @Test
    fun kindIsRequiredAndBounded() {
        assertEquals(MemoryReadRequest("player"), parse("""{"kind":"player"}"""))
        assertEquals(MemoryReadRequest("item_ids"), parse("""{"kind":"item_ids"}"""))
        assertEquals(MemoryReadRequest("quality_ids"), parse("""{"kind":"quality_ids"}"""))
        assertFailsWith<IllegalArgumentException> { parse("""{}""") }
        assertFailsWith<IllegalArgumentException> { parse("""{"kind":"entities"}""") }
        assertFailsWith<IllegalArgumentException> { parse("""{"kind":"player","limit":1}""") }
        assertEquals(memoryReadKinds.sorted(), memoryReadSchema()["kind"]!!.jsonObject["enum"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun playerSnapshotCarriesPositionAndOccupiedSlotsOnly() {
        val json =
            MemorySnapshot(
                    "player",
                    x = 4.5078125,
                    y = -21.0,
                    inventorySize = 80,
                    stacks = listOf(MemoryStack(1, 159, 1, 100), MemoryStack(3, 141, 1, 37)),
                    reads = 2,
                )
                .toJson()
        assertEquals("memory_read", json["observation"]!!.jsonPrimitive.content)
        assertEquals("player", json["kind"]!!.jsonPrimitive.content)
        assertEquals(2, json["reads"]!!.jsonPrimitive.content.toInt())
        assertEquals(true, json["stable"]!!.jsonPrimitive.content.toBoolean())
        val position = json["position"]!!.jsonObject
        assertEquals(4.5078125, position["x"]!!.jsonPrimitive.content.toDouble())
        assertEquals(-21.0, position["y"]!!.jsonPrimitive.content.toDouble())
        val inventory = json["inventory"]!!.jsonObject
        assertEquals(80, inventory["size"]!!.jsonPrimitive.content.toInt())
        val stacks = inventory["stacks"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf(1, 3), stacks.map { it["slot"]!!.jsonPrimitive.content.toInt() })
        assertEquals(listOf(159, 141), stacks.map { it["item"]!!.jsonPrimitive.content.toInt() })
        assertEquals(listOf(100, 37), stacks.map { it["count"]!!.jsonPrimitive.content.toInt() })
    }

    @Test
    fun idTablesAreKeyedByName() {
        val json = MemorySnapshot("quality_ids", ids = mapOf("normal" to 1, "legendary" to 5), stable = false).toJson()
        assertEquals("quality_ids", json["kind"]!!.jsonPrimitive.content)
        assertEquals(2, json["count"]!!.jsonPrimitive.content.toInt())
        assertEquals(false, json["stable"]!!.jsonPrimitive.content.toBoolean())
        val ids = json["ids"]!!.jsonObject
        assertEquals(1, ids["normal"]!!.jsonPrimitive.content.toInt())
        assertEquals(5, ids["legendary"]!!.jsonPrimitive.content.toInt())
    }
}
