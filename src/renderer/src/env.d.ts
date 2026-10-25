/// <reference types="vite/client" />
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient declarations (window.hangar) cannot be imported
/// <reference path="../../preload/index.d.ts" />

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
