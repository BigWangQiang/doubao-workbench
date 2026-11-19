import { apiClient, request } from "@/services/api/request";

export type SuperResolutionSourceMetadata = { durationMs: number; frameRate: number; width: number; height: number };

export function inspectSuperResolutionResource(resourceId: string) {
    return request<SuperResolutionSourceMetadata>(apiClient.post("/video-transforms/super-resolution/inspect", { resourceId }, { timeout: 125_000 }));
}
