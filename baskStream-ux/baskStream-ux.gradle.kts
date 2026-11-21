/*
 * Copyright 2026 Robert Hansen. Licensed under the Apache License, Version 2.0.
 */

import com.tridium.gradle.plugins.bajadoc.task.Bajadoc
import com.tridium.gradle.plugins.module.util.ModulePart.RuntimeProfile.*
import org.gradle.jvm.tasks.Jar

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
  runtimeProfile.set(ux)
  preferredSymbol.set("bsStream")
  vendor.set("BASidekick")
  vendorVersion.set("1.0")
  bajaVersion.set("4.10") // Same floor as baskStream-rt.
  description.set("baskStream settings view")
}

// See documentation at module://docDeveloper/doc/build.html#dependencies for the supported
// dependency types
dependencies {
  // NRE dependencies
  nre(":nre")

  // Niagara module dependencies
  api(":baja")
  api(":bajaScript-ux")
  api(":bajaux-ux")
  api(":js-ux")
  api(":web-rt")
  api(project(":baskStream-rt"))

  // Test Niagara module dependencies
  moduleTestImplementation(":test-wb")
}

tasks.named<Bajadoc>("bajadoc") {
  // Each of the packages you wish to include in your module's API documentation must be
  // enumerated below
  includePackage("com.basidekick.baskstream.ux")
}

// The view's JavaScript is served from module://baskStream/rc/...
tasks.named<Jar>("jar") {
  from("src/rc") {
    into("rc")
    exclude("**/._*")
    exclude("**/.DS_Store")
  }
}
