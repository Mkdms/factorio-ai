@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package factorioai.client.offline

import factorioai.client.BinaryView
import factorioai.client.ComparisonStrings
import factorioai.client.DebugTypes
import factorioai.client.PeImage
import factorioai.client.nativebridge.*
import kotlinx.cinterop.*
import platform.posix.getenv
import platform.windows.GetCurrentProcess
import kotlin.test.Test
import kotlin.test.assertEquals

class ComparisonMetadataTest {
    @Test
    fun readsNativeComparisonStringsFromSelectedMatchingPeAndPdb() = memScoped {
        val path = checkNotNull(getenv("FACTORIO_AI_CLIENT_TEST_EXE")).toKString()
        val image = PeImage(path)
        val process = checkNotNull(GetCurrentProcess())
        SymSetOptions((SYMOPT_EXACT_SYMBOLS or SYMOPT_FAIL_CRITICAL_ERRORS).toUInt())
        check(SymInitializeW(process, null, 0) != 0)
        try {
            val base = SymLoadModuleExW(process, null, path.wcstr.ptr, null, 0x180000000uL, 0u, null, 0u)
            check(base != 0uL)
            val names = mutableListOf<ULong>()
            val reference = StableRef.create(names)
            try {
                check(SymEnumSymbols(process, base, "?str@Comparison*", staticCFunction {
                        info: CPointer<SYMBOL_INFO>?, _: UInt, context: COpaquePointer? ->
                    if (info!!.pointed.Name.toKString() == "?str@Comparison@@QEBAPEBDXZ")
                        context!!.asStableRef<MutableList<ULong>>().get().add(info.pointed.Address)
                    1
                }, reference.asCPointer()) != 0)
            } finally {
                reference.dispose()
            }
            val rva = (names.single() - base).toLong()
            val types = DebugTypes(process, base)
            val end = image.functionEnd(rva)
            val values = ComparisonStrings.analyze(BinaryView(image.readonlyBytes(rva.toInt(), (end - rva).toInt())),
                rva, types.namedMember("Comparison", "value", "Comparison::Enum", 1uL).toLong(),
                types.aggregateSize("Comparison").toLong(), types.enumValues("Comparison::Enum").values.toSet(),
                image::readonlyBytes)
            assertEquals(setOf(">", "<", "=", "≥", "≤", "≠"), values.values.toSet())
            println("Native comparison strings: $values")
        } finally {
            SymCleanup(process)
        }
    }
}
