import {defineConfig} from "vite";
import path from "path";
import {viteStaticCopy} from "vite-plugin-static-copy";

export default defineConfig({
    plugins: [
        viteStaticCopy({
            targets: [
                {src: "./README.md", dest: "./"},
                {src: "./plugin.json", dest: "./"},
                {src: "./icon.png", dest: "./"},
            ],
        }),
    ],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
    },
    build: {
        outDir: "./dist",
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
        lib: {
            entry: path.resolve(__dirname, "src/index.ts"),
            name: "ExpenseRecorder",
            formats: ["cjs"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            external: ["siyuan"],
        },
    },
});
