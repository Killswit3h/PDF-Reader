import { describe, it, expect } from 'vitest';
import { repoSlug, semverCmp, fileFromArgv, filesFromArgv, canInstallInApp } from '../../src/shared/update-utils.js';

describe('canInstallInApp', () => {
  it('allows in-app install on packaged Windows', () => {
    expect(canInstallInApp('win32', true)).toBe(true);
  });
  it('blocks it on unpackaged (dev) builds', () => {
    expect(canInstallInApp('win32', false)).toBe(false);
  });
  it('blocks it on macOS (unsigned artifacts cannot self-install)', () => {
    expect(canInstallInApp('darwin', true)).toBe(false);
  });
  it('blocks it on Linux', () => {
    expect(canInstallInApp('linux', true)).toBe(false);
  });
  it('treats a non-boolean isPackaged as not installable', () => {
    expect(canInstallInApp('win32', undefined)).toBe(false);
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
