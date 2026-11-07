import factorioai.client.buildlogic.*
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget
import org.jetbrains.kotlin.gradle.plugin.mpp.MetadataDependencyTransformationTask
import org.jetbrains.kotlin.gradle.plugin.mpp.NativeBuildType
import org.jetbrains.kotlin.gradle.targets.native.tasks.KotlinNativeTest
import org.jetbrains.kotlin.gradle.tasks.KotlinNativeLink
import org.jetbrains.kotlin.gradle.utils.NativeCompilerDownloader
import org.jetbrains.kotlin.konan.target.HostManager
import java.nio.file.Files

// Factorio AI: this build file is the Windows part of factorio-mcp's (see NOTICE); the Linux target and npm packaging were removed.
plugins {
    alias(libs.plugins.kotlinMultiplatform)
}

group = "factorioai"

version = ProjectInfo.VERSION

// The generated library indexes contain absolute paths and are shared by Windows and WSL.
tasks.withType<MetadataDependencyTransformationTask>().configureEach {
    inputs.property("factorioAiClientMetadataProjectPath", layout.projectDirectory.asFile.absolutePath)
}

tasks.register<PrintVersion>("printVersion") {
    group = "help"
    description = "Prints the project version; use --quiet for machine-readable output."
    releaseVersion.set(project.version.toString())
}

val generateBuildVersion = tasks.register<GenerateBuildVersion>("generateBuildVersion") {
    group = "build"
    description = "Generates the runtime version type with KotlinPoet."
    releaseVersion.set(project.version.toString())
    outputDirectory.set(layout.buildDirectory.dir("generated/build-version/kotlin"))
}

val kotlinNativeHome =
    providers
        .gradleProperty("kotlin.native.home")
        .getOrElse(NativeCompilerDownloader(project).compilerDirectory.absolutePath)
val konanData =
    providers
        .gradleProperty("konan.data.dir")
        .orElse(providers.environmentVariable("KONAN_DATA_DIR"))
        .orElse(providers.systemProperty("user.home").map { "$it/.konan" })

kotlin {
    mingwX64 {
        val mainDirectory = "src/${compilations.getByName("main").defaultSourceSet.name}"
        val testDirectory = "src/${compilations.getByName("test").defaultSourceSet.name}"
        compilations.getByName("main").cinterops.create("image") {
            definitionFile.set(layout.projectDirectory.file("$mainDirectory/cinterop/image.def"))
        }
        compilations.getByName("main").cinterops.create("bridge") {
            definitionFile.set(layout.projectDirectory.file("$mainDirectory/cinterop/bridge.def"))
            includeDirs("$mainDirectory/native")
        }
        binaries.executable { entryPoint = "factorioai.client.main" }

        // These adapters execute host tools and require the Windows SDK.
        if (HostManager.host == konanTarget) {
            val taskSuffix = name.replaceFirstChar { it.uppercaseChar() }
            val outputScope = "${HostManager.host.name}/$name"
            val interop = compilations.getByName("main").cinterops.getByName("bridge")

            fun WindowsNativeBuild.configureToolchain() {
                inputs.dir("src/nativeMain/native")
                dependsOn(interop.interopProcessingTaskName)
                nativeHome.set(kotlinNativeHome)
                konanDataDirectory.set(konanData)
                toolchainFile.set(
                    layout.projectDirectory.file("$mainDirectory/native/cmake/KonanWindows.cmake")
                )
                localConfiguration.set(
                    layout.projectDirectory.file("local.properties").takeIf { it.asFile.exists() }
                )
            }

            val nativeBuild =
                tasks.register<WindowsNativeBuild>("build${taskSuffix}Native") {
                    configureToolchain()
                    sourceDirectory.set(layout.projectDirectory.dir("$mainDirectory/native"))
                    outputDirectory.set(layout.buildDirectory.dir("native/$outputScope"))
                }
            val nativeFixtures =
                tasks.register<WindowsNativeBuild>("build${taskSuffix}NativeFixtures") {
                    configureToolchain()
                    sourceDirectory.set(layout.projectDirectory.dir("$testDirectory/native"))
                    inputs.dir("src/nativeTest/lua")
                    inputs.dir("src/nativeTest/native")
                    inputs.dir("$mainDirectory/native")
                    outputDirectory.set(layout.buildDirectory.dir("native-tests/$outputScope"))
                }

            val executable = binaries.getExecutable(NativeBuildType.DEBUG)
            tasks.named<KotlinNativeTest>("${name}Test") {
                dependsOn(executable.linkTaskProvider, nativeFixtures)
                inputs.file(executable.linkTaskProvider.flatMap { it.outputFile })
                environment(
                    "FACTORIO_AI_CLIENT_TEST_EXECUTABLE",
                    executable.outputFile.absolutePath,
                    true,
                )
                val luaFixture =
                    nativeFixtures.flatMap { it.outputDirectory.file("lua/query_lua_fixture.dll") }
                inputs.file(luaFixture)
                environment("FACTORIO_AI_CLIENT_TEST_LUA_LIBRARY", luaFixture.get().asFile.absolutePath, true)
                filter.excludeTestsMatching("factorioai.client.acceptance.*")
                filter.excludeTestsMatching("factorioai.client.offline.*")
            }
            binaries.configureEach {
                linkTaskProvider.configure {
                    dependsOn(nativeBuild)
                    val runtime = outputFile.map { it.parentFile.resolve("factorio_ai_bridge.dll") }
                    val sourceDll =
                        nativeBuild.get().outputDirectory.file("factorio_ai_bridge.dll").get().asFile
                    outputs.file(runtime)
                    inputs.file(sourceDll)
                    doLast {
                        val destination = runtime.get()
                        if (
                            !destination.exists() ||
                            Files.mismatch(sourceDll.toPath(), destination.toPath()) != -1L
                        )
                            sourceDll.copyTo(destination, overwrite = true)
                    }
                }
            }

            val nativeTest =
                tasks.register<Exec>("test${taskSuffix}Native") {
                    dependsOn(nativeFixtures)
                    commandLine(
                        "ctest",
                        "--test-dir",
                        nativeFixtures.get().outputDirectory.get().asFile,
                        "--output-on-failure",
                        "--no-tests=error",
                    )
                }
            tasks.named("check") { dependsOn(nativeTest) }
        }
    }
    sourceSets {
        commonMain { kotlin.srcDir(generateBuildVersion.flatMap { it.outputDirectory }) }
        commonMain.dependencies {
            implementation(libs.mcp.server)
            implementation(libs.ktor.server.cio)
            implementation(libs.serialization.json)
            implementation(libs.io.core)
            implementation(libs.coroutines.core)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.cio)
        }
    }
}

val checkTestPackageBoundaries =
    tasks.register<CheckTestPackageBoundaries>("checkTestPackageBoundaries") {
        group = "verification"
        description = "Rejects external-game test markers outside the excluded test packages."
        sources.from(
            kotlin.sourceSets
                .filter { it.name.endsWith("Test") }
                .map { it.kotlin },
        )
        excludedPackages.addAll(
            "factorioai.client.acceptance",
            "factorioai.client.offline",
        )
        requiredMarkers.addAll(
            "FACTORIO_AI_CLIENT_ACCEPTANCE_URL",
            "FACTORIO_AI_CLIENT_TEST_PID",
            "FACTORIO_AI_CLIENT_UI_SERVER_LOG",
            "FACTORIO_AI_CLIENT_UI_CLIENT_LOG",
        )
    }
tasks.named("check") { dependsOn(checkTestPackageBoundaries) }

// Compilation remains available for metadata and IDE use; only final linking is host-specific.
tasks.withType<KotlinNativeLink>().configureEach {
    if (binary.target.konanTarget != HostManager.host) {
        onlyIf("the binary target matches the current host") { false }
    }
}
