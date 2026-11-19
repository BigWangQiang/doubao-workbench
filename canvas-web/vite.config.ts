import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    base: './',
    define: { __APP_VERSION__: JSON.stringify('工作台本地画布'), __APP_CHANGELOG__: JSON.stringify('') },
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), '@desktop': fileURLToPath(new URL('./desktop', import.meta.url)) } },
    server: { host: '127.0.0.1', port: 5174, strictPort: true },
    build: { outDir: '../dist/renderer/canvas', emptyOutDir: true, target: 'esnext' },
});
