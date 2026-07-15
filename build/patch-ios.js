// Patch the generated iOS Info.plist with a few keys Capacitor doesn't set.
//
// The ios/ project is git-ignored and recreated by `cap add ios`, so — exactly
// like build/make-ios-icons.js and the Android inject-signing step — this runs
// after `cap sync ios` (see the ios:* npm scripts and CI) to stamp our keys onto
// the freshly generated plist. Pure Node, cross-platform, and idempotent: it
// removes any prior copy of each managed key before re-inserting it, so running
// it repeatedly is a no-op.
//
//   node build/patch-ios.js [<Info.plist path>]
//   (defaults to ios/App/App/Info.plist)

'use strict';
const fs = require('fs');
const path = require('path');

const PLIST = process.argv[2] ||
  path.join(__dirname, '..', 'ios', 'App', 'App', 'Info.plist');

// Managed keys (all booleans here). Value is the literal plist element.
//  - ITSAppUsesNonExemptEncryption=false: the app does no non-exempt
//    cryptography (it's offline; node-forge only signs documents locally), so
//    this declares export-compliance up front and every TestFlight/App Store
//    upload skips the "does your app use encryption?" prompt.
//  - UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace: expose the app's
//    Documents dir (where saved/exported PDFs land) in the iOS Files app and let
//    the user open documents in place — the mobile parallel to the desktop file
//    dialog.
const KEYS = [
  ['ITSAppUsesNonExemptEncryption', '<false/>'],
  ['UIFileSharingEnabled', '<true/>'],
  ['LSSupportsOpeningDocumentsInPlace', '<true/>']
];

if (!fs.existsSync(PLIST)) {
  console.error('[patch-ios] Info.plist not found:', PLIST, '\n  run `npx cap add ios` first.');
  process.exit(1);
}

let plist = fs.readFileSync(PLIST, 'utf8');

for (const [key, value] of KEYS) {
  // Drop any existing entry for this key (boolean value), so we can re-insert a
  // known-good one — makes the patch idempotent across repeated cap syncs.
  const existing = new RegExp('\\n?\\s*<key>' + key + '</key>\\s*<(?:true|false)\\/>', 'g');
  plist = plist.replace(existing, '');
}

// Insert all managed keys right after the root <dict> opening tag.
const insertion = KEYS
  .map(([key, value]) => `\t<key>${key}</key>\n\t${value}`)
  .join('\n');
plist = plist.replace(/(<plist[^>]*>\s*<dict>)/, `$1\n${insertion}`);

fs.writeFileSync(PLIST, plist, 'utf8');
console.log('[patch-ios] applied', KEYS.map(([k]) => k).join(', '), 'to', PLIST);
