import { describe, it, expect } from 'vitest';
import { repoSlug, semverCmp, fileFromArgv, filesFromArgv, canInstallInApp, isDeveloperIdSigned } from '../../src/shared/update-utils.js';

describe('canInstallInApp', () => {
  it('allows in-app install on packaged Windows', () => {
    expect(canInstallInApp('win32', true)).toBe(true);
  });
  it('blocks it on unpackaged (dev) builds', () => {
    expect(canInstallInApp('win32', false)).toBe(false);
  });
  it('allows it on packaged macOS once the app is Developer ID signed', () => {
    expect(canInstallInApp('darwin', true, true)).toBe(true);
  });
  it('blocks it on an ad-hoc signed macOS build (Squirrel.Mac cannot match it)', () => {
    expect(canInstallInApp('darwin', true, false)).toBe(false);
  });
  it('blocks it on macOS when signedness is unknown', () => {
    expect(canInstallInApp('darwin', true)).toBe(false);
  });
  it('does not let a macSigned flag unlock Linux', () => {
    expect(canInstallInApp('linux', true, true)).toBe(false);
  });
  it('does not let a macSigned flag unlock a dev build', () => {
    expect(canInstallInApp('darwin', false, true)).toBe(false);
  });
  it('blocks it on Linux', () => {
    expect(canInstallInApp('linux', true)).toBe(false);
  });
  it('treats a non-boolean isPackaged as not installable', () => {
    expect(canInstallInApp('win32', undefined)).toBe(false);
  });
});

// Real `codesign -dv --verbose=2` output, trimmed to the lines that matter.
const DEV_ID_OUTPUT = [
  'Executable=/Applications/FieldMark.app/Contents/MacOS/FieldMark',
  'Identifier=com.pdfsigner.app',
  'Format=app bundle with Mach-O universal (x86_64 arm64)',
  'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7',
  'Signature size=8973',
  'Authority=Developer ID Application: Guaranteed Fence Corp (A1B2C3D4E5)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=17 Sep 2026 at 10:04:11',
  'TeamIdentifier=A1B2C3D4E5'
].join('\n');

const ADHOC_OUTPUT = [
  'Executable=/Applications/FieldMark.app/Contents/MacOS/FieldMark',
  'Identifier=com.pdfsigner.app',
  'Format=app bundle with Mach-O universal (x86_64 arm64)',
  'CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7',
  'Signature=adhoc',
  'Info.plist entries=28',
  'TeamIdentifier=not set'
].join('\n');

describe('isDeveloperIdSigned', () => {
  it('recognises a Developer ID signature', () => {
    expect(isDeveloperIdSigned(DEV_ID_OUTPUT)).toBe(true);
  });
  it('rejects the ad-hoc signature our unsigned builds carry', () => {
    expect(isDeveloperIdSigned(ADHOC_OUTPUT)).toBe(false);
  });
  it('rejects a Mac App Store "Apple Distribution" signature', () => {
    expect(isDeveloperIdSigned('Authority=Apple Distribution: Someone (A1B2C3D4E5)')).toBe(false);
  });
  it('does not match the phrase inside another line', () => {
    expect(isDeveloperIdSigned('note: Authority=Developer ID Application appears here')).toBe(false);
  });
  it('tolerates spaces around the equals sign', () => {
    expect(isDeveloperIdSigned('Authority = Developer ID Application: X (A1B2C3D4E5)')).toBe(true);
  });
  it('treats empty or missing output as unsigned', () => {
    expect(isDeveloperIdSigned('')).toBe(false);
    expect(isDeveloperIdSigned(null)).toBe(false);
    expect(isDeveloperIdSigned(undefined)).toBe(false);
  });
});

describe('semverCmp', () => {
  it('treats equal versions as 0', () => expect(semverCmp('1.4.3', '1.4.3')).toBe(0));
  it('knows a newer patch', () => expect(semverCmp('1.4.4', '1.4.3')).toBe(1));
  it('knows an older patch', () => expect(semverCmp('1.4.2', '1.4.3')).toBe(-1));
  it('compares numerically, not lexically (1.4.10 > 1.4.3)', () => {
    expect(semverCmp('1.4.10', '1.4.3')).toBe(1);
  });
  it('tolerates a leading v', () => expect(semverCmp('v1.5.0', '1.4.9')).toBe(1));
  it('treats a missing minor/patch as 0', () => expect(semverCmp('2', '1.9.9')).toBe(1));
  it('does not crash on garbage', () => expect(semverCmp('abc', '1.0.0')).toBe(-1));
});

describe('repoSlug', () => {
  it('parses an https .git url', () => {
    expect(repoSlug('https://github.com/Killswit3h/PDF-Reader.git'))
      .toEqual({ owner: 'Killswit3h', repo: 'PDF-Reader' });
  });
  it('parses a git+ssh url', () => {
    expect(repoSlug('git@github.com:Owner/Repo.git')).toEqual({ owner: 'Owner', repo: 'Repo' });
  });
  it('returns null for a non-github url', () => {
    expect(repoSlug('https://example.com/x/y')).toBeNull();
  });
  it('returns null for empty/undefined input', () => {
    expect(repoSlug('')).toBeNull();
    expect(repoSlug(undefined)).toBeNull();
  });
});

describe('fileFromArgv', () => {
  const existsAll = () => true;
  const existsNone = () => false;
  it('picks the first existing .pdf argument', () => {
    expect(fileFromArgv(['electron', '.', '/docs/a.pdf'], existsAll)).toBe('/docs/a.pdf');
  });
  it('is case-insensitive on the extension', () => {
    expect(fileFromArgv(['x', '/docs/A.PDF'], existsAll)).toBe('/docs/A.PDF');
  });
  it('skips a .pdf that does not exist', () => {
    expect(fileFromArgv(['x', '/docs/ghost.pdf'], existsNone)).toBeNull();
  });
  it('ignores non-pdf arguments', () => {
    expect(fileFromArgv(['x', '--flag', 'file.txt'], existsAll)).toBeNull();
  });
  it('handles an empty argv', () => {
    expect(fileFromArgv([], existsAll)).toBeNull();
    expect(fileFromArgv(undefined, existsAll)).toBeNull();
  });
});

describe('filesFromArgv', () => {
  const existsAll = () => true;
  const existsNone = () => false;
  it('returns every existing .pdf argument in order', () => {
    expect(filesFromArgv(['electron', '.', '/docs/a.pdf', '/docs/b.pdf'], existsAll))
      .toEqual(['/docs/a.pdf', '/docs/b.pdf']);
  });
  it('is case-insensitive on the extension', () => {
    expect(filesFromArgv(['x', '/docs/A.PDF', '/docs/c.pdf'], existsAll))
      .toEqual(['/docs/A.PDF', '/docs/c.pdf']);
  });
  it('skips .pdf paths that do not exist', () => {
    expect(filesFromArgv(['x', '/docs/ghost.pdf'], existsNone)).toEqual([]);
  });
  it('ignores non-pdf arguments', () => {
    expect(filesFromArgv(['x', '--flag', 'file.txt', '/docs/a.pdf'], existsAll))
      .toEqual(['/docs/a.pdf']);
  });
  it('handles an empty argv', () => {
    expect(filesFromArgv([], existsAll)).toEqual([]);
    expect(filesFromArgv(undefined, existsAll)).toEqual([]);
  });
});
