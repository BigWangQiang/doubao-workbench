/** 豆包与 Dola 共用的参考素材上限。 */
export const REFERENCE_IMAGE_LIMIT = 30;
export const REFERENCE_VIDEO_LIMIT = 10;
export const REFERENCE_AUDIO_LIMIT = 10;

export interface ReferenceMaterialCounts {
  images: number;
  videos: number;
  audios: number;
}

export function validateReferenceMaterialCounts(counts: ReferenceMaterialCounts): string | undefined {
  if (counts.images > REFERENCE_IMAGE_LIMIT) return `参考图片最多 ${REFERENCE_IMAGE_LIMIT} 张`;
  if (counts.videos > REFERENCE_VIDEO_LIMIT) return `参考视频最多 ${REFERENCE_VIDEO_LIMIT} 个`;
  if (counts.audios > REFERENCE_AUDIO_LIMIT) return `参考音频最多 ${REFERENCE_AUDIO_LIMIT} 个`;
  return undefined;
}
