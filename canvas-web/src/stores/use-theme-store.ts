import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeName = "light" | "dark";

type ThemeStore = {
    theme: ThemeName;
    setTheme: (theme: ThemeName) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            // 画布统一使用深色主题，保留原 setter 合同以兼容已有设置面板。
            setTheme: () => set({ theme: "dark" }),
        }),
        {
            name: "infinite-canvas:theme_store",
            // 旧版本可能持久化了 light；画布外观已锁定，恢复时直接收敛到 dark。
            merge: (_persisted, current) => ({ ...current, theme: "dark" }),
        },
    ),
);
