/**
 * Inline SVG icon set (Lucide-style: 16px, 1.5 stroke, round caps, current
 * color) matching the visual language of the VSCode-like workbench plugins
 * (dsh-better-sidebar et al.) — no emoji, no raster assets.
 */

interface IconProps {
  size?: number
  className?: string
}

function icon(size: number | undefined, path: string): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size ?? 14}
      height={size ?? 14}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

/** Server / SSH host glyph. */
export function ServerIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6.5h12"/><circle cx="4.5" cy="9.3" r="0.7" fill="currentColor"/><circle cx="7" cy="9.3" r="0.7" fill="currentColor"/><circle cx="9.5" cy="9.3" r="0.7" fill="currentColor"/>')
}

/** Folder glyph. */
export function FolderIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>')
}

/** File glyph. */
export function FileIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M4 1.5h5l3 3V14a.5.5 0 0 1-.5.5h-7.5A.5.5 0 0 1 4 14z"/><path d="M9 1.5v3h3"/>')
}

/** Text file glyph (code file). */
export function FileCodeIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M4 1.5h5l3 3V14a.5.5 0 0 1-.5.5h-7.5A.5.5 0 0 1 4 14z"/><path d="M9 1.5v3h3"/><path d="M6.5 7.5 5 9l1.5 1.5M9.5 7.5 11 9l-1.5 1.5"/>')
}

/** Trash glyph. */
export function TrashIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4"/><path d="M6.5 7v4M9.5 7v4"/>')
}

/** Pencil (rename) glyph. */
export function PencilIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M11.5 1.9a1.3 1.3 0 0 1 1.9 1.9L5.2 12 2.5 12.8 3.3 10z"/><path d="M10.5 3l2.5 2.5"/>')
}

/** Refresh glyph. */
export function RefreshIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 1.5v3.5H9.5"/>')
}

/** Plus glyph. */
export function PlusIcon(props: IconProps): React.ReactElement {
  return icon(props.size, '<path d="M8 3v10M3 8h10"/>')
}

/** Search glyph. */
export function SearchIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<circle cx="6.8" cy="6.8" r="4.3"/><path d="M10 10l3.5 3.5"/>')
}

/** Key glyph (key auth). */
export function KeyIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<circle cx="6" cy="10" r="3"/><path d="M8.2 7.8 13.5 2.5M10.5 5 12.5 7M8.8 6.3 9.8 7.3"/>')
}

/** Lock glyph (password auth). */
export function LockIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/><circle cx="8" cy="10" r="0.8" fill="currentColor"/>')
}

/** Desktop / monitor glyph (welcome page). */
export function MonitorIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<rect x="2" y="3" width="12" height="8.5" rx="1"/><path d="M8 11.5V13M5.5 13.5h5"/>')
}

/** Save glyph. */
export function SaveIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M3 2.5h9L13.5 4v9.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M5 2.5v4h6v-4M5 13.5v-4h6v4"/>')
}

/** Terminal glyph. */
export function TerminalIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10h3"/>')
}

/** Close (×) glyph. */
export function CloseIcon(props: IconProps): React.ReactElement {
  return icon(props.size, '<path d="M4 4l8 8M12 4l-8 8"/>')
}

/** Chevron right (collapsed folder). */
export function ChevronRightIcon(props: IconProps): React.ReactElement {
  return icon(props.size, '<path d="M6 3.5 10.5 8 6 12.5"/>')
}

/** Chevron down (expanded folder). */
export function ChevronDownIcon(props: IconProps): React.ReactElement {
  return icon(props.size, '<path d="M3.5 6 8 10.5 12.5 6"/>')
}

/** Plug / connect glyph. */
export function PlugIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M6 1.5v3M10 1.5v3"/><path d="M4.5 4.5h7V7a3.5 3.5 0 0 1-7 0z"/><path d="M8 10.5V14.5"/>')
}

/** Unplug / disconnect glyph. */
export function UnplugIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M6 1.5v3M10 1.5v3"/><path d="M4.5 4.5h7V7a3.5 3.5 0 0 1-1.2 2.6"/><path d="M6.3 9.9A3.5 3.5 0 0 1 4.5 7V4.5M8 10.5v4M3 3l10 10"/>')
}

/** Spinner glyph (connecting). */
export function SpinnerIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M8 2a6 6 0 1 0 6 6" opacity="0.35"/><path d="M14 8a6 6 0 0 0-6-6"/>')
}

/** Import glyph (download into list). */
export function ImportIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M8 2.5v7M5.5 7 8 9.5 10.5 7"/><path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11"/>')
}

/** Check glyph (test ok). */
export function CheckIcon(props: IconProps): React.ReactElement {
  return icon(props.size, '<path d="M3 8.5 6.5 12 13 4.5"/>')
}

/** Alert glyph (test failed / error). */
export function AlertIcon(props: IconProps): React.ReactElement {
  return icon(props.size,
    '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5V9.5M8 11.2v.1"/>')
}
