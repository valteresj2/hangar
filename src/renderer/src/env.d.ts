/// <reference types="vite/client" />
/// <reference path="../../preload/index.d.ts" />

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
