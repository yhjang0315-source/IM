import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 기본 CSS 압축기(lightningcss)는 플랫폼별 네이티브 바이너리를 요구하고,
  // Windows에서 그게 빠지면 빌드가 통째로 죽는다. Vite 8은 esbuild도 번들하지 않는다.
  // CSS가 8KB뿐이라 압축을 꺼도 손해가 없다 — 어느 PC에서든 빌드되는 쪽을 택한다.
  build: { cssMinify: false },
})
