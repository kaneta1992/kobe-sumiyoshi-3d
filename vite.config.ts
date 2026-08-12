import { defineConfig } from 'vite';

export default defineConfig({
    // GitHub Pages でリポジトリ配下に置かれても白画面にならないよう相対パスにする（E5-d）
    base: './',
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 2500,
    },
});
