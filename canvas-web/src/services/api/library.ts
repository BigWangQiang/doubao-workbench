import { apiClient as api, request, compactApiParams } from "./request";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import type { InsertAssetPayload } from "@/types/asset-insertion";

export type LibraryKind = "template" | "character" | "image" | "video" | "audio" | "text";
export type LibraryPayload = { nodes?: CanvasNodeData[]; connections?: CanvasConnection[]; asset?: InsertAssetPayload };
export type LibraryItem = { id: string; teamId?: string; kind: LibraryKind; name: string; category: string; tags: string; coverResourceId: string; payloadJson: string; published: boolean; sortOrder: number; sourceKey?: string; updatedAt: string };
export type LibraryPage = { items: LibraryItem[]; total: number; page: number; limit: number };
export type LibraryInput = Omit<LibraryItem, "id" | "payloadJson" | "updatedAt" | "sourceKey"> & { payload: LibraryPayload };
export type LibraryImport = { id: string; source: string; total: number; succeeded: number; failed: number; duplicates: number; reportJson: string; createdAt: string };
export const listLibrary = (params: { kind?: string; teamId?: string; keyword?: string; category?: string; recent?: boolean; page?: number; limit?: number }, admin = false) => request<LibraryPage>(api.get(admin ? "/admin/library" : "/library", { params: compactApiParams({ ...params, recent: params.recent ? "true" : undefined }) }));
export const getLibraryItem = (id: string, admin = false) => request<LibraryItem>(api.get(`${admin ? "/admin/library" : "/library"}/${id}`));
export const listLibraryCategories = (teamId: string | undefined, kind: string) => request<string[]>(api.get("/library/categories", { params: compactApiParams({ teamId, kind }) }));
export const useLibraryItem = (id: string) => request<LibraryItem>(api.post(`/library/${id}/use`));
export const saveLibraryItem = (id: string | undefined, input: LibraryInput) => request<LibraryItem>(id ? api.put(`/library/${id}`, input) : api.post("/library", input));
export const listLibraryImports = () => request<LibraryImport[]>(api.get("/admin/library-imports"));
export const importLibrary = (input: { source: string; items: unknown[]; localOnly?: boolean }) => request<LibraryImport>(api.post("/admin/library-imports", input, { timeout: 600000 }));
