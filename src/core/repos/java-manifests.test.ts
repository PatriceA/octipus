import { describe, expect, test } from 'vitest';
import { parseGradleBuild, parseGradleSettingsProjectName, parseMavenPom } from './java-manifests';

describe('parseMavenPom', () => {
  test('uses the parent group and resolves project and custom property aliases', () => {
    const parsed = parseMavenPom(`
      <project xmlns="http://maven.apache.org/POM/4.0.0">
        <modelVersion>4.0.0</modelVersion>
        <parent>
          <groupId>com.acme</groupId>
          <artifactId>parent</artifactId>
          <version>2.4.0</version>
        </parent>
        <artifactId>orders</artifactId>
        <properties>
          <internal.group>com.acme.libs</internal.group>
          <shared.name>shared-core</shared.name>
        </properties>
        <dependencies>
          <dependency>
            <groupId>${'${'}internal.group}</groupId>
            <artifactId>${'${'}shared.name}</artifactId>
            <version>${'${'}project.version}</version>
          </dependency>
          <dependency>
            <groupId>org.slf4j</groupId>
            <artifactId>slf4j-api</artifactId>
          </dependency>
        </dependencies>
      </project>
    `);

    expect(parsed).toMatchObject({
      manifest: 'pom.xml',
      packageName: 'com.acme:orders',
      language: 'java',
      dependencies: [
        { name: 'com.acme.libs:shared-core', version: '2.4.0', manifest: 'pom.xml' },
        { name: 'org.slf4j:slf4j-api', version: '*', manifest: 'pom.xml' },
      ],
    });
    expect(parsed?.warnings).toContain(
      'Static Maven scan does not load the parent POM; inherited dependencies may be omitted.',
    );
  });

  test('only reads direct project dependencies and reports omitted profile dependencies', () => {
    const parsed = parseMavenPom(`
      <project>
        <modelVersion>4.0.0</modelVersion>
        <groupId>com.acme</groupId><artifactId>service</artifactId><version>1</version>
        <dependencies>
          <dependency><groupId>com.acme</groupId><artifactId>direct</artifactId><version>1</version></dependency>
          <dependency><groupId>com.acme</groupId><artifactId>direct</artifactId><version>2</version></dependency>
        </dependencies>
        <dependencyManagement><dependencies>
          <dependency><groupId>com.acme</groupId><artifactId>managed</artifactId><version>1</version></dependency>
        </dependencies></dependencyManagement>
        <build><plugins><plugin>
          <groupId>com.acme</groupId><artifactId>build-plugin</artifactId>
          <dependencies><dependency><groupId>com.acme</groupId><artifactId>plugin-dep</artifactId></dependency></dependencies>
        </plugin></plugins></build>
        <profiles><profile><dependencies>
          <dependency><groupId>com.acme</groupId><artifactId>profile-dep</artifactId></dependency>
        </dependencies></profile></profiles>
      </project>
    `);

    expect(parsed?.dependencies).toEqual([
      { name: 'com.acme:direct', version: '1', manifest: 'pom.xml' },
    ]);
    expect(parsed?.warnings).toContain(
      'Maven profile dependencies are omitted because profile activation is not evaluated.',
    );
  });

  test('bounds cyclic properties without creating false package edges', () => {
    const parsed = parseMavenPom(`
      <project>
        <modelVersion>4.0.0</modelVersion>
        <groupId>com.acme</groupId><artifactId>service</artifactId>
        <properties><a>${'${'}b}</a><b>${'${'}a}</b></properties>
        <dependencies><dependency>
          <groupId>${'${'}a}</groupId><artifactId>unknown</artifactId><version>${'${'}missing}</version>
        </dependency></dependencies>
      </project>
    `);
    expect(parsed?.dependencies).toEqual([]);
    expect(parsed?.warnings).toContain('Some Maven properties could not be resolved statically.');
  });

  test('bounds branching property expansion work and output', () => {
    const properties = ['<p0>x</p0>'];
    for (let index = 1; index <= 6; index++) {
      properties.push(`<p${index}>${`${'${'}p${index - 1}}`.repeat(20)}</p${index}>`);
    }
    const parsed = parseMavenPom(`
      <project><modelVersion>4.0.0</modelVersion>
        <groupId>com.acme</groupId><artifactId>service</artifactId>
        <properties>${properties.join('')}</properties>
        <dependencies><dependency><groupId>${'${'}p6}</groupId><artifactId>unsafe</artifactId></dependency></dependencies>
      </project>
    `);
    expect(parsed?.dependencies).toEqual([]);
    expect(parsed?.warnings).toContain('Some Maven properties could not be resolved statically.');
  });

  test('rejects malformed XML, non-project roots, doctypes, entities, and oversized input', () => {
    expect(parseMavenPom('<project><artifactId>broken</project>')).toBeNull();
    expect(parseMavenPom('<settings/>')).toBeNull();
    expect(parseMavenPom('<!DOCTYPE project SYSTEM "https://example.invalid/pom.dtd"><project/>')).toBeNull();
    expect(parseMavenPom('<!DOCTYPE project [<!ENTITY x "expanded">]><project><artifactId>&x;</artifactId></project>')).toBeNull();
    expect(parseMavenPom(`<project>${' '.repeat(1_000_001)}</project>`)).toBeNull();
  });
});

describe('parseGradleBuild', () => {
  test('parses top-level Groovy string, platform, and map dependency declarations', () => {
    const parsed = parseGradleBuild('build.gradle', `
      buildscript {
        dependencies { classpath 'com.acme:build-only:1' }
      }
      /* project coordinates */ group = 'com.acme'
      dependencies {
        implementation 'com.acme:shared-core:1.2.0' // shared library
        implementation('com.acme:shared-core:2.0.0')
        implementation platform('org.springframework.boot:spring-boot-dependencies:3.4.0')
        testImplementation group: 'org.junit.jupiter', name: 'junit-jupiter', version: '5.11.0'
        constraints {
          implementation 'com.acme:not-an-edge:1'
        }
      }
      // dependencies { implementation 'com.acme:commented:1' }
    `, {
      settingsContent: "rootProject.name = 'orders' // literal project name",
      defaultProjectName: 'wrong-fallback',
    });

    expect(parsed).toMatchObject({
      manifest: 'build.gradle',
      packageName: 'com.acme:orders',
      language: 'java',
      dependencies: [
        { name: 'com.acme:shared-core', version: '1.2.0', manifest: 'build.gradle' },
        { name: 'org.springframework.boot:spring-boot-dependencies', version: '3.4.0', manifest: 'build.gradle' },
        { name: 'org.junit.jupiter:junit-jupiter', version: '5.11.0', manifest: 'build.gradle' },
      ],
    });
    expect(parsed.warnings).toContainEqual(expect.stringContaining('literal module dependencies only'));
  });

  test('parses Kotlin calls and named arguments with bounded gradle.properties interpolation', () => {
    const parsed = parseGradleBuild('build.gradle.kts', `
      group = "\${company}.services"
      dependencies {
        implementation("com.acme:shared:\${sharedVersion}")
        api(group = "com.fasterxml.jackson.core", name = "jackson-databind", version = "2.18.0")
        runtimeOnly(enforcedPlatform("com.acme:runtime-bom:3"))
        implementation(libs.guava)
        implementation(project(":local"))
      }
    `, {
      settingsContent: 'rootProject.name = "billing"',
      gradleProperties: 'company=com.acme\nsharedVersion=1.7.0',
    });

    expect(parsed.packageName).toBe('com.acme.services:billing');
    expect(parsed.dependencies).toEqual([
      { name: 'com.acme:shared', version: '1.7.0', manifest: 'build.gradle.kts' },
      { name: 'com.fasterxml.jackson.core:jackson-databind', version: '2.18.0', manifest: 'build.gradle.kts' },
      { name: 'com.acme:runtime-bom', version: '3', manifest: 'build.gradle.kts' },
    ]);
  });

  test('uses literal gradle.properties group and the supplied directory fallback name', () => {
    const parsed = parseGradleBuild('build.gradle', `
      dependencies {
        implementation "org.example:library"
      }
    `, {
      defaultProjectName: 'fallback-project',
      gradleProperties: 'group=org.example',
    });
    expect(parsed.packageName).toBe('org.example:fallback-project');
    expect(parsed.dependencies).toEqual([
      { name: 'org.example:library', version: '*', manifest: 'build.gradle' },
    ]);
  });

  test('does not infer identity or dependencies from dynamic or nested declarations', () => {
    const parsed = parseGradleBuild('build.gradle.kts', `
      allprojects {
        group = providers.gradleProperty("company").get()
        dependencies { implementation("com.acme:nested:1") }
      }
      dependencies {
        implementation(libs.shared.core)
        implementation("\${dynamicCoordinate}")
      }
    `, {
      settingsContent: 'rootProject.name = "\${dynamicName}"',
      defaultProjectName: 'safe-name',
    });
    expect(parsed.packageName).toBeUndefined();
    expect(parsed.dependencies).toEqual([]);
  });

  test('rejects arbitrary calls, literal prefixes, and qualified dependency blocks', () => {
    const parsed = parseGradleBuild('build.gradle.kts', `
      dependencies {
        println("com.acme:fake:1")
        implementation("com.acme:prefix:1" + suffix)
      }
      project(":other").dependencies {
        implementation("com.acme:other:1")
      }
      project(":continued").
        dependencies {
          implementation("com.acme:continued:1")
        }
    `);
    expect(parsed.dependencies).toEqual([]);
  });

  test('does not split statements at newlines inside triple-quoted strings', () => {
    const parsed = parseGradleBuild('build.gradle.kts', `
      description = """
        group = "com.fake"
      """
      dependencies {
        val sample = """
          implementation("com.acme:fake:1")
        """
        implementation("com.acme:real:1")
      }
    `, { defaultProjectName: 'service' });
    expect(parsed.packageName).toBeUndefined();
    expect(parsed.dependencies).toEqual([
      { name: 'com.acme:real', version: '1', manifest: 'build.gradle.kts' },
    ]);
  });

  test('skips a dependencies block used as an unresolved control-flow body', () => {
    const parsed = parseGradleBuild('build.gradle', `
      if (false)
        dependencies {
          implementation 'com.acme:conditional:1'
        }
      dependencies {
        implementation 'com.acme:root:1'
      }
    `);
    expect(parsed.dependencies).toEqual([
      { name: 'com.acme:root', version: '1', manifest: 'build.gradle' },
    ]);
  });

  test('does not fall back from explicit dynamic identity and uses the last static assignment', () => {
    const dynamic = parseGradleBuild('build.gradle', `
      group = 'com.old'
      group = computeGroup()
    `, {
      settingsContent: 'rootProject.name = computeName()',
      defaultProjectName: 'fallback',
      gradleProperties: 'group=com.properties',
    });
    expect(dynamic.packageName).toBeUndefined();

    const staticIdentity = parseGradleBuild('build.gradle', `
      group = 'com.old'
      group = 'com.new'
    `, { defaultProjectName: 'service' });
    expect(staticIdentity.packageName).toBe('com.new:service');
  });

  test('bounds branching Gradle property interpolation', () => {
    const properties = ['p0=x'];
    for (let index = 1; index <= 6; index++) {
      properties.push(`p${index}=${`$p${index - 1}`.repeat(20)}`);
    }
    const parsed = parseGradleBuild('build.gradle.kts', `
      dependencies { implementation("\${p6}:unsafe:1") }
    `, { gradleProperties: properties.join('\n') });
    expect(parsed.dependencies).toEqual([]);
  });

  test('keeps offsets correct when non-BMP text precedes the dependency block', () => {
    const parsed = parseGradleBuild('build.gradle', `
      description = 'mobile 🚀'
      dependencies { implementation 'com.acme:core:1' }
    `);
    expect(parsed.dependencies).toEqual([
      { name: 'com.acme:core', version: '1', manifest: 'build.gradle' },
    ]);
  });
});

describe('parseGradleSettingsProjectName', () => {
  test('accepts top-level literal names and rejects comments, nesting, and interpolation', () => {
    expect(parseGradleSettingsProjectName('// rootProject.name = "wrong"\nrootProject.name = "right"')).toBe('right');
    expect(parseGradleSettingsProjectName('pluginManagement { rootProject.name = "nested" }')).toBeUndefined();
    expect(parseGradleSettingsProjectName('rootProject.name = "\${dynamic}"')).toBeUndefined();
  });
});
