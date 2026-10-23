import {defineConfig} from 'vite';
export default defineConfig({base:'./',build:{outDir:'dist',emptyOutDir:true,chunkSizeWarningLimit:1800},worker:{format:'es'}});
