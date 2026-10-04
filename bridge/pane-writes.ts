/** Only one Nenu input operation may own a terminal while its draft is being verified. */
export class PaneWrites {
  private active = new Set<string>();
  async run<T>(
    session: string,
    paneId: string,
    operation: () => Promise<T>,
  ): Promise<{ busy: true } | { busy: false; value: T }> {
    const key = JSON.stringify([session, paneId]);
    if (this.active.has(key)) return { busy: true };
    this.active.add(key);
    try {
      return { busy: false, value: await operation() };
    } finally {
      this.active.delete(key);
    }
  }
}
