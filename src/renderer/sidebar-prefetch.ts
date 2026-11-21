/**
 * Read a sidebar conversation ahead while the pointer rests on it: the few
 * hundred milliseconds before a click are enough to fetch its first page, so
 * opening it shows at once. A quick sweep across the list reads nothing.
 */
export class HoverPrefetch {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly recent = new Map<string, number>();
  constructor(private readonly prefetch: (workspaceId: string, sessionId: string) => void,
    private readonly dwellMs = 120, private readonly repeatAfterMs = 60_000,
    private readonly now: () => number = Date.now) {}

  point(workspaceId: string, sessionId: string): void {
    this.leave();
    const key = JSON.stringify([workspaceId, sessionId]);
    const last = this.recent.get(key);
    if (last !== undefined && this.now() - last < this.repeatAfterMs) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.recent.set(key, this.now());
      if (this.recent.size > 200) this.recent.delete(this.recent.keys().next().value!);
      this.prefetch(workspaceId, sessionId);
    }, this.dwellMs);
  }
  leave(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
