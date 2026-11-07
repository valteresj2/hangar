// `?asset` imports (electron-vite copies the file next to the bundle and imports its absolute path).
/// <reference types="electron-vite/node" />

// `?raw` imports: the file's text, bundled (the Windows helper's C# source).
declare module '*?raw' {
  const text: string
  export default text
}
