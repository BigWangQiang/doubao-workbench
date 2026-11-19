import type { AccountPlatform, GenerationMode } from '@doubao-studio/contracts';

const DOUBAO_MODES: readonly GenerationMode[] = ['chat', 'image', 'video', 'music'];
// Dola 页面原生能力由平台决定，本地管理器不再额外屏蔽任何生成模式。
const DOLA_MODES: readonly GenerationMode[] = DOUBAO_MODES;

export function getAllowedGenerationModes(platform: AccountPlatform): readonly GenerationMode[] {
  return platform === 'dola' ? DOLA_MODES : DOUBAO_MODES;
}

export function isGenerationModeAllowed(platform: AccountPlatform, mode: GenerationMode): boolean {
  return getAllowedGenerationModes(platform).includes(mode);
}

export function rejectDolaUnsupportedMode(platform: AccountPlatform, mode: GenerationMode): string | null {
  void platform;
  void mode;
  return null;
}
