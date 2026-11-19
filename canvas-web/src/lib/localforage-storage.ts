import localforage from "localforage";
import { isDesktop } from "@desktop/bridge";
import { readLocal, writeLocal, removeLocal } from "@desktop/storage";
import type { StateStorage } from "zustand/middleware";

import { scopedStorageKey } from "@/lib/user-scope";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        if (isDesktop) return readLocal<string>("state:" + name);
        const key = scopedStorageKey(name);
        try {
            return (await localforage.getItem<string>(key)) || null;
        } catch {
            return window.localStorage.getItem(key);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        if (isDesktop) {
            try { await writeLocal("state:" + name, value); }
            catch (error) { window.dispatchEvent(new CustomEvent("desktop:save-error", { detail: error instanceof Error ? error.message : "保存失败" })); throw error; }
            return;
        }
        const key = scopedStorageKey(name);
        try {
            await localforage.setItem(key, value);
        } catch {
            window.localStorage.setItem(key, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        if (isDesktop) return removeLocal("state:" + name);
        const key = scopedStorageKey(name);
        try {
            await localforage.removeItem(key);
        } catch {
            window.localStorage.removeItem(key);
        }
    },
};

export function localForageStorageForScope(scope: string): StateStorage {
    const normalizedScope = scope.trim();
    if (!normalizedScope) throw new Error("缺少本地存储 scope");

    const keyFor = (name: string) => scopedStorageKey(`${name}:scope:${normalizedScope}`);
    return {
        getItem: async (name) => {
            if (typeof window === "undefined") return null;
            if (isDesktop) return readLocal<string>("state:" + keyFor(name));
            return (await localforage.getItem<string>(keyFor(name))) || null;
        },
        setItem: async (name, value) => {
            if (typeof window === "undefined") return;
            if (isDesktop) return writeLocal("state:" + keyFor(name), value);
            await localforage.setItem(keyFor(name), value);
        },
        removeItem: async (name) => {
            if (typeof window === "undefined") return;
            if (isDesktop) return removeLocal("state:" + keyFor(name));
            await localforage.removeItem(keyFor(name));
        },
    };
}
