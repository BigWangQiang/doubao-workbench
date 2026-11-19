import axios from "axios";
import { desktopAdapter } from "@desktop/local-api";
import { localizeErrorMessage } from "@/lib/generation-error";

export type ApiParams = Record<string, string | string[] | number | number[] | undefined>;

export type BackendEnvelope<T> = {
    code: number;
    data: T;
    msg: string;
};

// 所有后端 JSON 请求共用同一实例，避免认证、Base URL 和错误语义在模块间漂移。
export const apiBaseURL = "/api";
export const apiClient = axios.create({ baseURL: apiBaseURL, adapter: desktopAdapter });

export async function request<T>(promise: Promise<{ data: BackendEnvelope<T> }>) {
    try {
        const response = await promise;
        if (response.data.code !== 0) throw new Error(localizeErrorMessage(response.data.msg, "请求失败，请稍后重试。"));
        return response.data.data;
    } catch (error) {
        if (axios.isAxiosError<BackendEnvelope<unknown>>(error)) {
            throw new Error(localizeErrorMessage(error.response?.data?.msg || error.message, "请求失败，请稍后重试。"));
        }
        throw new Error(localizeErrorMessage(error, "请求失败，请稍后重试。"));
    }
}

export function compactApiParams(params: ApiParams) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0))) as ApiParams;
}

export function serializeApiParams(params?: ApiParams) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => queryParams.append(key, String(item)));
        else queryParams.set(key, String(value));
    }
    return queryParams;
}
