@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package factorioai.client.offline

import factorioai.client.ChatLayouts
import factorioai.client.DebugTypes
import factorioai.client.EventLayouts
import factorioai.client.RuntimeApi
import factorioai.client.nativebridge.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlinx.cinterop.*
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import platform.posix.getenv
import platform.windows.GetCurrentProcess

class OfflineQueryMetadataTest {
    @Test
    fun eventLayoutResolvesDistinctClickAndReleaseTypesFromPdb() = memScoped {
        val path = checkNotNull(getenv("FACTORIO_AI_CLIENT_TEST_PDB")).toKString()
        val process = checkNotNull(GetCurrentProcess())
        check(SymInitializeW(process, null, 0) != 0)
        try {
            val base =
                SymLoadModuleExW(process, null, path.wcstr.ptr, null, 0x180000000uL, 0u, null, 0u)
            check(base != 0uL)
            val layout = alloc<EventLayout>()
            EventLayouts(DebugTypes(process, base)).write(layout)
            assertNotEquals(layout.up, layout.click)
            assertNotEquals(layout.down, layout.click)
            assertTrue(layout.eventType + 4u <= layout.mouseSize)
            assertTrue(layout.mouseTime + 8u <= layout.mouseSize)
            assertTrue(layout.keyTime + 8u <= layout.keySize)
        } finally {
            SymCleanup(process)
        }
    }

    @Test
    fun chatLayoutResolvesFromPdbWithoutOpeningAGameProcess() = memScoped {
        val path =
            getenv("FACTORIO_AI_CLIENT_TEST_PDB")?.toKString()?.takeIf { it.isNotBlank() }
                ?: return@memScoped
        println("factorio-ai-client: offline chat PDB layout check enabled")
        val process = checkNotNull(GetCurrentProcess())
        check(SymInitializeW(process, null, 0) != 0)
        try {
            val base =
                SymLoadModuleExW(process, null, path.wcstr.ptr, null, 0x180000000uL, 0u, null, 0u)
            check(base != 0uL)
            val layout = alloc<ChatLayout>()
            ChatLayouts(DebugTypes(process, base)).write(layout)
            assertEquals(1u, layout.supported)
            assertEquals(1u, layout.sendSupported)
            assertTrue(layout.actionBuffer + layout.stringSize <= layout.actionSize)
            assertTrue(layout.lists[0] != layout.lists[1])
        } finally {
            SymCleanup(process)
        }
    }

    @Test
    fun installedApiCatalogFitsTheWireAndExcludesMutationMethods() {
        val path =
            getenv("FACTORIO_AI_CLIENT_TEST_RUNTIME_API")?.toKString()?.takeIf { it.isNotBlank() }
                ?: return
        println("factorio-ai-client: offline runtime API catalog check enabled")
        val document = SystemFileSystem.source(Path(path)).buffered().use { it.readString() }
        val api = RuntimeApi(Json.parseToJsonElement(document).jsonObject)
        assertTrue(api.catalog.toString().encodeToByteArray().size < FM_MAX_QUERY_ARGUMENTS)
        val player = api.catalog.getValue("LuaPlayer").jsonObject
        assertTrue(
            player.getValue("attributes").jsonArray.any {
                it.jsonPrimitive.content == "physical_position"
            }
        )
        assertFalse(
            api.catalog.values.any {
                "can_insert" in
                    it.jsonObject.getValue("methods").jsonArray.map { value ->
                        value.jsonPrimitive.content
                    }
            }
        )
    }
}
