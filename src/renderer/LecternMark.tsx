const full = new URL("../../build/icons/256x256.png", import.meta.url).href;
// The simplified artwork drawn for 32 px and below (64 px, for 2x screens).
const simplified = new URL("../../build/lectern-mark-small.png", import.meta.url).href;

/** The app icon; `small` for places that show it at 32 px or less, such as the sidebar. */
export function LecternMark({ className, small = false }: { className: string; small?: boolean }) {
  return <img className={className} src={small ? simplified : full} alt="" draggable={false} />;
}
