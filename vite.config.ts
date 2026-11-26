import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * モダンブラウザはすべて woff2 に対応しているため、@fontsource / KaTeX の CSS から
 * レガシーな .woff / .ttf フォールバック宣言を取り除いて dist/assets のファイル数と容量を削減する。
 */
function woff2OnlyFonts(): Plugin {
  return {
    name: 'documi-woff2-only-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.css')) return null
      if (!id.includes('@fontsource') && !id.includes('katex')) return null
      const next = code
        .replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, '')
        .replace(/,\s*url\([^)]+\.ttf\)\s*format\(['"]truetype['"]\)/g, '')
      return next === code ? null : { code: next, map: null }
    },
  }
}

export default defineConfig({
  plugins: [woff2OnlyFonts(), tailwindcss(), react({ compiler: true })],
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/mcp': 'http://localhost:3000',
    },
  },
})
