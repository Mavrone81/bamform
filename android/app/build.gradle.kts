import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.BuiltArtifactsLoader
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing material lives in android/keystore/ (gitignored).
// keystore.properties keys: storeFile, storePassword, keyAlias, keyPassword.
val keystoreProps =
    Properties().apply {
        val f = rootProject.file("keystore/keystore.properties")
        if (f.exists()) FileInputStream(f).use { load(it) }
    }

android {
    namespace = "com.bamform.shell"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.bamform.shell"
        minSdk = 26
        targetSdk = 34
        // BOTH are read out of the BUILT APK by :app:generateReleaseUpdateManifest
        // and written into version.json — never typed into the manifest or the
        // download page by hand. Bumping versionCode is what makes an installed
        // device offer the update; devices compare against BuildConfig.VERSION_CODE.
        //
        // History: versionCode 1 / "1.0.0" is the binary currently published at
        // form.bevorasg.com/app as `bamform-1.1.apk`, on a page whose footer reads
        // "v1.1". That label was never in the binary — exactly the hand-edited
        // drift this slice removes.
        versionCode = 2
        versionName = "1.2.0"
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
            // minSdk 26 only needs v2, but v3 is what makes signing-key
            // ROTATION possible later (review A-9 — the first report claimed
            // v3 and AGP had in fact left it off). Given how loudly the
            // README warns that losing this key strands every installed
            // device, having no rotation path at all is not a default worth
            // inheriting. v1 stays off: it is the vulnerable JAR scheme and
            // is not needed above API 24.
            enableV1Signing = false
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        release {
            // A thin WebView shell gains almost nothing from R8 and shrinking
            // risks stripping WebView client callbacks — keep it unshrunk.
            isMinifyEnabled = false
            signingConfig =
                if (keystoreProps.isNotEmpty()) signingConfigs.getByName("release") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        textReport = true
        // Dependencies are pinned deliberately (reproducible sideload
        // builds); version bumps are a conscious decision, not lint noise.
        disable += "GradleDependency"
        // The density PNGs exist as a raster fallback for surfaces that do
        // not read the adaptive icon; API 26+ launchers use the adaptive
        // (round-masked) XML, so the square PNG shape warning is moot.
        disable += "IconLauncherShape"
    }
}

// ---------------------------------------------------------------------------
// Release manifest generation (slice 21-SHELL)
//
// `version.json` is READ OUT OF THE BUILT APK and written next to a copy of
// it, together with the download page. It is never hand-edited.
//
// Why that matters more than it sounds: the page currently published at
// form.bevorasg.com/app links to `bamform-1.1.apk`, and its footer says
// "v1.1" — while the binary it links to carries versionName `1.0.0` and
// versionCode `1`. Two hand-maintained descriptions of one artefact had
// already drifted, and nothing in the system could notice. Once an installed
// app decides whether to download new code based on that description, drift
// stops being cosmetic: a manifest that overstates the version offers an
// update that does not exist, and one that understates it hides an update
// that does.
//
// So the versionCode, versionName and SHA-256 below all come from the APK
// AGP just produced — via the variant artifact API, not a hard-coded output
// path — and the only human-written field is the release note, which lives
// in `android/release-note.txt` and goes through review like any other file.
// ---------------------------------------------------------------------------

/**
 * The origin the published APK will be served from. Must stay identical to
 * `UpdateManifest.UPDATE_ORIGIN` in the Kotlin sources — the app refuses any
 * `apkUrl` that is not on it, so a mismatch here produces a manifest every
 * installed device rejects. `scripts/ci/assert-shell-update-contract.mjs`
 * asserts the two agree.
 */
val updateOriginUrl = "https://form.bevorasg.com"

abstract class GenerateUpdateManifest : DefaultTask() {

    /** The APK directory produced by the release variant. */
    @get:InputFiles
    abstract val apkDir: DirectoryProperty

    /** Reads AGP's own metadata for the artefacts in [apkDir]. */
    @get:Internal
    abstract val builtArtifactsLoader: Property<BuiltArtifactsLoader>

    /** The one human-authored field in the manifest. */
    @get:InputFile
    abstract val releaseNoteFile: RegularFileProperty

    /** Repo copy of the download page, published beside the manifest. */
    @get:InputFile
    abstract val downloadPage: RegularFileProperty

    @get:Input
    abstract val updateOrigin: Property<String>

    /** Staging directory — the exact contents of `/var/www/…/app/`. */
    @get:OutputDirectory
    abstract val distDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val built =
            builtArtifactsLoader.get().load(apkDir.get())
                ?: error("No built artefacts found for the release variant.")
        val element =
            built.elements.singleOrNull()
                ?: error(
                    "Expected exactly one release APK, found ${built.elements.size}. " +
                        "Splits/ABI variants would need a manifest per artefact.",
                )
        val apk = File(element.outputFile)
        require(apk.isFile) { "Release APK not found at ${apk.absolutePath}" }

        val versionCode =
            element.versionCode ?: error("The built APK reports no versionCode.")
        val versionName =
            element.versionName ?: error("The built APK reports no versionName.")
        // The device-side parser applies exactly this rule; a name it rejects
        // would produce a manifest no installed app can read.
        require(Regex("^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$").matches(versionName)) {
            "versionName '$versionName' is not acceptable to UpdateManifest.parse()."
        }

        val origin = updateOrigin.get()
        require(origin.startsWith("https://")) { "The update origin must be https." }

        val publishedName = "bamform-$versionName.apk"
        val dist = distDir.get().asFile
        dist.mkdirs()
        // Wipe first: a previous release's APK left here would be published
        // alongside the new one and could be linked to by an old bookmark.
        dist.listFiles()?.forEach { it.deleteRecursively() }

        val publishedApk = File(dist, publishedName)
        apk.copyTo(publishedApk, overwrite = true)

        // Hash the PUBLISHED copy, not the source: the bytes the device will
        // download are the bytes that get measured.
        val sha256 = sha256Of(publishedApk)

        val note =
            releaseNoteFile.get().asFile.readText()
                .replace(Regex("\\s+"), " ")
                .trim()
                .take(240)

        val manifest =
            buildString {
                append("{\n")
                append("  \"versionCode\": ").append(versionCode).append(",\n")
                append("  \"versionName\": ").append(jsonString(versionName)).append(",\n")
                append("  \"apkUrl\": ")
                    .append(jsonString("$origin/app/$publishedName"))
                    .append(",\n")
                append("  \"sha256\": ").append(jsonString(sha256)).append(",\n")
                append("  \"sizeBytes\": ").append(publishedApk.length()).append(",\n")
                append("  \"releaseNote\": ").append(jsonString(note)).append(",\n")
                append("  \"releasedAt\": ")
                    .append(jsonString(Instant.now().truncatedTo(ChronoUnit.SECONDS).toString()))
                    .append("\n")
                append("}\n")
            }
        File(dist, "version.json").writeText(manifest)
        File(dist, "index.html").writeText(downloadPage.get().asFile.readText())

        // Self-check. Cheap, and it is the whole claim of this task: what the
        // manifest says is what is sitting next to it.
        val republished = sha256Of(File(dist, publishedName))
        check(republished == sha256) {
            "The staged APK does not hash to the value written into version.json."
        }

        logger.lifecycle(
            "Release manifest staged in ${dist.absolutePath}\n" +
                "  versionCode $versionCode  versionName $versionName\n" +
                "  $publishedName  ${publishedApk.length()} bytes\n" +
                "  sha256 $sha256",
        )
    }

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val r = input.read(buf)
                if (r < 0) break
                digest.update(buf, 0, r)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun jsonString(raw: String): String {
        val out = StringBuilder("\"")
        for (c in raw) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c < ' ' -> out.append("\\u%04x".format(c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }
}

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        val capitalised = variant.name.replaceFirstChar { it.uppercase() }
        val manifestTask =
            tasks.register<GenerateUpdateManifest>("generate${capitalised}UpdateManifest") {
                group = "distribution"
                description =
                    "Reads the built release APK and stages app/build/dist/ " +
                        "(APK + version.json + index.html) for form.bevorasg.com/app."
                apkDir.set(variant.artifacts.get(SingleArtifact.APK))
                builtArtifactsLoader.set(variant.artifacts.getBuiltArtifactsLoader())
                releaseNoteFile.set(rootProject.file("release-note.txt"))
                downloadPage.set(rootProject.file("download-page/index.html"))
                updateOrigin.set(updateOriginUrl)
                distDir.set(layout.buildDirectory.dir("dist"))
            }
        // `assembleRelease` PRODUCES the manifest. Generating it is part of
        // producing a release, not a separate step someone can forget.
        tasks.matching { it.name == "assemble$capitalised" }.configureEach {
            finalizedBy(manifestTask)
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Origin-scoped JS channel (WebViewCompat.addWebMessageListener). This is
    // the whole fix for review A-1/A-2 — addJavascriptInterface cannot
    // express an origin rule. 1.11.0 is the last line that targets
    // compileSdk 34.
    implementation("androidx.webkit:webkit:1.11.0")
}
