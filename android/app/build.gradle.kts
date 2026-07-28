import java.io.FileInputStream
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
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
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

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
