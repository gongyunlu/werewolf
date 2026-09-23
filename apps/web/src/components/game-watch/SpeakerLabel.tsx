export function SpeakerLabel({
  seatNo,
  name,
  action,
}: {
  seatNo: number;
  name?: string;
  action: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-xs font-semibold text-foreground"
      >
        {seatNo}
      </span>
      <span className="truncate font-semibold text-foreground">
        {name ? `${name} · ` : ''}
        {seatNo} 号 · {action}
      </span>
    </span>
  );
}
