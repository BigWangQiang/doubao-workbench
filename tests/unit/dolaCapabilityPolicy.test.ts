import { describe, expect, it } from 'vitest';
import {
  getAllowedGenerationModes,
  isGenerationModeAllowed,
  rejectDolaUnsupportedMode,
} from '../../src/utils/dolaCapabilityPolicy';

describe('Dola capability policy', () => {
  it('keeps all existing modes for Doubao', () => {
    expect(getAllowedGenerationModes('doubao')).toEqual(['chat', 'image', 'video', 'music']);
  });

  it('does not add a local mode restriction for Dola', () => {
    expect(getAllowedGenerationModes('dola')).toEqual(['chat', 'image', 'video', 'music']);
    expect(isGenerationModeAllowed('dola', 'video')).toBe(true);
    expect(isGenerationModeAllowed('dola', 'chat')).toBe(true);
    expect(rejectDolaUnsupportedMode('dola', 'image')).toBeNull();
  });
});
