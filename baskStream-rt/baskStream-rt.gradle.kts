/*
 * Copyright 2026 BASidekick. All Rights Reserved.
 */

import com.tridium.gradle.plugins.bajadoc.task.Bajadoc
import com.tridium.gradle.plugins.module.util.ModulePart.RuntimeProfile.*

plugins {
  // The Niagara Module plugin configures the "moduleManifest" extension and the
  // "jar" and "moduleTestJar" tasks.
  id("com.tridium.niagara-module")

  // The signing plugin configures the correct signing of modules. It requires
  // that the plugin also be applied to the root project.
  id("com.tridium.niagara-signing")

  // The bajadoc plugin configures the generation of Bajadoc for a module.
  id("com.tridium.bajadoc")

  // Configures JaCoCo for the "niagaraTest" task of this module.
  id("com.tridium.niagara-jacoco")

  // The Annotation processors plugin adds default dependencies on ":nre"
  // for the "annotationProcessor" and "moduleTestAnnotationProcessor"
  // configurations by creating a single "niagaraAnnotationProcessor"
  // configuration they extend from. This value can be overridden by explicitly
  // declaring a dependency for the "niagaraAnnotationProcessor" configuration.
  id("com.tridium.niagara-annotation-processors")

  // The niagara_home repositories convention plugin configures !bin/ext and
  // !modules as flat-file Maven repositories so that projects in this build can
  // depend on already-installed Niagara modules.
  id("com.tridium.convention.niagara-home-repositories")
}

moduleManifest {
  moduleName.set("baskStream")
  runtimeProfile.set(rt)
  preferredSymbol.set("bsStream")
  vendor.set("BASidekick")
  vendorVersion.set("1.0")
  bajaVersion.set("4.10") // Match QAGCharts' cross-Niagara compatibility floor.
  description.set("baskStream external API service")
}

val niagaraHome = providers.gradleProperty("niagara_home").get()

tasks.matching { it.name == "writeModuleXml" }.configureEach {
  doLast {
    val moduleXml = layout.buildDirectory.file("manifest/writeModuleXml/module.xml").get().asFile
    if (!moduleXml.isFile) return@doLast

    val original = moduleXml.readText()
    val updated = Regex("(<dependency\\b[^>]*?)\\s+vendorVersion=\"[^\"]*\"")
      .replace(original, "$1")

    if (updated != original) {
      moduleXml.writeText(updated)
    }
  }
}

// See documentation at module://docDeveloper/doc/build.html#dependencies for the supported
// dependency types
dependencies {
  // NRE dependencies
  nre(":nre")

  // Niagara module dependencies
  api(":baja")
  api(":web-rt")
  api(":jetty-rt")
  api(":control-rt")
  api(":driver-rt")
  api(":history-rt")
  api(":alarm-rt")
  api(":schedule-rt")
  api(":bql-rt")

  // The servlet and websocket APIs are provided by the target Niagara install's !bin/ext.
  // Keep them off the module payload and use them only for compilation.
  compileOnly(fileTree("$niagaraHome/bin/ext") {
    include("javax.servlet-api-*.jar")
    include("jetty-all-compact3-*.jar")
  })

  // Test Niagara module dependencies
  moduleTestImplementation(":test-wb")
}

tasks.named<Bajadoc>("bajadoc") {
  // Each of the packages you wish to include in your module's API documentation must be
  // enumerated below
  includePackage("com.basidekick.baskstream")
}
