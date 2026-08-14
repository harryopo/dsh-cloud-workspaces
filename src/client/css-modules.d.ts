/** CSS module type shim (tsdown handles the actual bundling). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
