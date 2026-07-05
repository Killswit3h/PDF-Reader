'use strict';

/*
 * Force the generated Android debug build to sign with the committed keystore
 * (build/debug.keystore) instead of a per-runner auto-generated one, so every
 * released APK shares ONE signature and installs as an in-place update.
 *
 * The android/ project is generated fresh in CI (git-ignored), and simply
 * dropping the keystore at ~/.android/debug.keystore does NOT work on the GitHub
 * runner (setup-android points AGP's default debug keystore elsewhere via
 * ANDROID_USER_HOME, so Gradle regenerates a random key). So instead we inject
 * an explicit `signingConfigs.debug` into android/app/build.gradle that points
 * at the keystore — deterministic and env-independent.
 *
 *   node build/inject-signing.js [android/app]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appDir = path.resolve(process.argv[2] || path.join(ROOT, 'android', 'app'));
const gradlePath = path.join(appDir, 'build.gradle');
const srcKeystore = path.join(ROOT, 'build', 'debug.keystore');
const MARKER = 'PDF Signer stable debug signing';

if (!fs.existsSync(gradlePath)) {
  console.error('[inject-signing] not found:', gradlePath);
  process.exit(1);
}
if (!fs.existsSync(srcKeystore)) {
  console.error('[inject-signing] missing keystore:', srcKeystore);
  process.exit(1);
}

// Copy the keystore into the app module so build.gradle can reference it by a
// stable relative path.
fs.copyFileSync(srcKeystore, path.join(appDir, 'debug.keystore'));

let gradle = fs.readFileSync(gradlePath, 'utf8');
if (gradle.includes(MARKER)) {
  console.log('[inject-signing] already injected.');
  process.exit(0);
}

// 1) Add a debug signingConfig at the top of the android {} block.
const signingBlock =
  `\n    // ${MARKER}\n` +
  `    signingConfigs {\n` +
  `        debug {\n` +
  `            storeFile file('debug.keystore')\n` +
  `            storePassword 'android'\n` +
  `            keyAlias 'androiddebugkey'\n` +
  `            keyPassword 'android'\n` +
  `        }\n` +
  `    }\n`;
if (!/\bandroid\s*\{/.test(gradle)) {
  console.error('[inject-signing] no android { } block found');
  process.exit(1);
}
gradle = gradle.replace(/\bandroid\s*\{/, (m) => m + signingBlock);

// 2) Point the debug build type at it (add a debug {} inside buildTypes {}).
if (/buildTypes\s*\{/.test(gradle)) {
  gradle = gradle.replace(/buildTypes\s*\{/, (m) =>
    m + `\n        debug { signingConfig signingConfigs.debug }`);
} else {
  // No buildTypes block — add a minimal one inside android {} (after our signingConfigs).
  gradle = gradle.replace(signingBlock, signingBlock +
    `    buildTypes {\n        debug { signingConfig signingConfigs.debug }\n    }\n`);
}

fs.writeFileSync(gradlePath, gradle, 'utf8');
console.log('[inject-signing] debug signingConfig -> build/debug.keystore injected into', gradlePath);
