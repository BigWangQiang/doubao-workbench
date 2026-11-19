import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workspace full-page layering', () => {
  const stylesSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'styles', 'global.css'), 'utf8');

  it('uses an opaque route layer while keeping the background webview mounted', () => {
    expect(stylesSource).toMatch(
      /\.studio-ui \.workspace-page-layer\s*\{[^}]*background:\s*var\(--studio-bg\)/s,
    );
    expect(stylesSource).toMatch(
      /\.studio-ui \.persistent-browser-layer\.is-hidden\s*\{[^}]*opacity:\s*1/s,
    );
    expect(stylesSource).not.toMatch(
      /\.studio-ui \.persistent-browser-layer\.is-hidden\s*\{[^}]*display:\s*none/s,
    );
  });
});
