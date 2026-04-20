// Tests for /upload mimetype + extension rejection.

import { describe, expect, it } from 'vitest';
import { uploadRejectionReason } from '../../src/routes/upload.routes.js';

describe('uploadRejectionReason', () => {
  it('accepts legitimate image upload', () => {
    expect(uploadRejectionReason({ mimetype: 'image/png', originalname: 'a.png' })).toBeNull();
  });

  it('accepts audio upload', () => {
    expect(uploadRejectionReason({ mimetype: 'audio/wav', originalname: 'a.wav' })).toBeNull();
  });

  it('accepts video upload', () => {
    expect(uploadRejectionReason({ mimetype: 'video/mp4', originalname: 'a.mp4' })).toBeNull();
  });

  it('rejects non-media mimetype', () => {
    expect(
      uploadRejectionReason({ mimetype: 'application/x-msdownload', originalname: 'a.exe' }),
    ).toBe('mimetype not allowed');
  });

  it('rejects .exe even with image mimetype', () => {
    expect(
      uploadRejectionReason({ mimetype: 'image/png', originalname: 'malware.exe' }),
    ).toBe('extension on deny-list');
  });

  it('rejects .svg (script-carrying) even with image mimetype', () => {
    expect(
      uploadRejectionReason({ mimetype: 'image/svg+xml', originalname: 'x.svg' }),
    ).toBe('extension on deny-list');
  });

  it('rejects .html', () => {
    expect(
      uploadRejectionReason({ mimetype: 'image/png', originalname: 'page.html' }),
    ).toBe('extension on deny-list');
  });

  it('rejects .js', () => {
    expect(
      uploadRejectionReason({ mimetype: 'image/png', originalname: 'script.js' }),
    ).toBe('extension on deny-list');
  });

  it('rejects .sh', () => {
    expect(
      uploadRejectionReason({ mimetype: 'image/png', originalname: 'a.sh' }),
    ).toBe('extension on deny-list');
  });

  it('rejects .bat', () => {
    expect(
      uploadRejectionReason({ mimetype: 'image/png', originalname: 'a.bat' }),
    ).toBe('extension on deny-list');
  });

  it('is case-insensitive on extension', () => {
    expect(
      uploadRejectionReason({ mimetype: 'image/png', originalname: 'MAL.EXE' }),
    ).toBe('extension on deny-list');
  });
});
