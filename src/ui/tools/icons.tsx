/**
 * GEODESIA — instrument icon set.
 *
 * A deliberately small, hand-drawn geometric set: 24×24 grid, 1.5px strokes,
 * `currentColor` only, no icon font or dependency. Icons are decorative by
 * default (aria-hidden); pass `title` only when an icon is the sole label.
 */
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Square size in px (default 16). */
  size?: number;
  /** Accessible title; omit for decorative icons. */
  title?: string;
}

function Icon({ size = 16, title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function IconRoute(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="5.5" r="2.5" />
      <path d="M8 18.5h5.5a3 3 0 0 0 3-3v-3" />
      <path d="M13 8.5h-3a2.5 2.5 0 0 0-2.5 2.5v5" />
    </Icon>
  );
}

export function IconPolygon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 20 8.5l-2 10-12 1L4 9.5Z" />
      <circle cx="12" cy="3.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="20" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="6" cy="19.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4" cy="9.5" r="1.4" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconTerrain(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 19.5h19" />
      <path d="m4 19.5 6.2-12 4.1 7.6 1.9-3.2 5.8 7.6" />
      <path d="M10.2 7.5v-.01" />
    </Icon>
  );
}

export function IconRuler(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 14.5 14.5 3.5l6 6-11 11Z" />
      <path d="m7 11 2 2M10 8l2 2M13 5l2 2" />
    </Icon>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 16V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M4.5 15.5v3a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-3" />
    </Icon>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5V16" />
      <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 16.5v2a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-2" />
    </Icon>
  );
}

export function IconFile(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.5h7l5 5v12H6Z" />
      <path d="M13 3.5v5h5" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="m6 7 1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </Icon>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
    </Icon>
  );
}

export function IconArrowDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M6.5 13.5 12 19l5.5-5.5" />
    </Icon>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5" />
    </Icon>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.2" />
      <path d="M15.5 5.5h-10a1 1 0 0 0-1 1v10" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Icon>
  );
}

export function IconCrosshair(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconTarget(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" />
    </Icon>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 3.5V8h-4.5" />
    </Icon>
  );
}

export function IconLayers(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 3.5 8.5 4.5L12 12.5 3.5 8Z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
    </Icon>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1" />
      <path d="M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17" />
    </Icon>
  );
}

export function IconFlow(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="6" height="4.5" rx="0.8" />
      <rect x="14.5" y="9.5" width="6" height="4.5" rx="0.8" />
      <rect x="3.5" y="15.5" width="6" height="4.5" rx="0.8" />
      <path d="M9.5 5.75h2.5v6h2.5M9.5 17.75h2.5v-6" />
    </Icon>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 21 20H3Z" />
      <path d="M12 9.5v4" />
      <path d="M12 16.75v.01" />
    </Icon>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
    </Icon>
  );
}

export function IconMap(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 5.5 9 3.5l6 2 5.5-2v15l-5.5 2-6-2-5.5 2Z" />
      <path d="M9 3.5v15M15 5.5v15" />
    </Icon>
  );
}
