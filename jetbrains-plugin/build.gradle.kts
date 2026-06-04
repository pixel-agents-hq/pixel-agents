import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.1.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.21"
    id("org.jetbrains.intellij.platform") version "2.16.0"
}

group = "com.pixelagents"
version = "0.2.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2025.1")
        bundledPlugin("org.jetbrains.plugins.terminal")
        testFramework(TestFrameworkType.Platform)
    }
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.0")
    testRuntimeOnly("junit:junit:4.13.2")
    testImplementation("io.mockk:mockk:1.14.7")
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    pluginConfiguration {
        id = "io.github.rlarin.pixelagents"
        name = "IT Crowd Pixel Agents"
        version = "0.2.0"
        description = """
            JetBrains edition of Pixel Agents — a pixel art office where AI agents (Claude Code terminals)
            are animated characters you can watch work in real time.

            Compatible with PyCharm, WebStorm, and all JetBrains IDEs based on IntelliJ Platform 2025.1+.
            Requires Node.js to be installed.

            Based on Pixel Agents by Pablo De Lucca (https://github.com/pixel-agents-hq/pixel-agents), MIT licensed.
        """.trimIndent()
        ideaVersion {
            sinceBuild = "251"
            untilBuild = "261.*"
        }
    }
    publishing {
        token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN")
    }
}

tasks {
    test {
        useJUnitPlatform()
    }
}
