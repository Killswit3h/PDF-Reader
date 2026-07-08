'use strict';

/*
 * Ad-hoc sign the packaged macOS app when no real Apple signing identity is
 * configured.
 *
 * Without ANY signature, Apple Silicon reports the app as "damaged and can't be
 * opened", and macOS then refuses to launch it as a document handler — which is
 * exactly why it can't be set as the default PDF opener. An ad-hoc signature
 * (`codesign -s -`) makes it a launchable, associable app. Gatekeeper still
 * shows the milder "unidentified developer" for freshly-downloaded copies
 * (right-click → Open once, or `xattr -cr "/Applications/PDF Signer.app"`) —
 * that quarantine can only be removed entirely by notarization, which needs a
 * paid Apple Developer account.
 *
 * Wired as electron-builder's `afterPack` hook (which always runs, unlike
 * `afterSign` when signing is skipped). No-op off macOS and when a real
 * certificate is present (CSC_LINK / CSC_NAME → real signing handles it).
 * Fully defensive — it never throws, so it can never fail the release build.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function adhocSign(context) {
  try {
    if (context.electronPlatformName !== 'darwin') return;
    if (process.env.CSC_LINK || process.env.CSC_NAME) return; // real signing configured
    // A universal build packs each arch into a "*-temp" dir, then merges them.
    // Signing those per-arch temps makes their _CodeSignature differ and breaks
    // the merge ("Expected all non-binary files to have identical SHAs"). Sign
    // ONLY the final app — the merged universal (or a single-arch) output — which
    // afterPack also fires for, after the merge, and whose signature the merge
    // invalidates anyway.
    if (context.appOutDir.includes('-temp')) return;
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    if (!fs.existsSync(appPath)) {
      console.warn('[afterPack] app not found, skipping ad-hoc sign:', appPath);
      return;
    }
    // --deep signs the nested Electron frameworks/helpers too (required on ARM);
    // merging a universal binary invalidates prior signatures, so --force re-signs.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc signed macOS app:', appPath);
  } catch (e) {
    console.warn('[afterPack] ad-hoc signing skipped:', e && e.message);
  }
};
