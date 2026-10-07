// One request at a time. New edits during a save remain pending; failures pause
// remote saves until the editor explicitly reconnects or retries.
export class DraftAutosave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: string | undefined;
  private saving = false;
  private stopped = false;
  private failed = false;
  constructor(private save: (value: string) => Promise<void>, private result: (value: string, error?: unknown) => void, private delay = 2500) {}
  update(value: string) {
    if (this.stopped || this.failed) return;
    this.pending = value;
    clearTimeout(this.timer);
    if (!this.saving) this.timer = setTimeout(() => void this.flush(), this.delay);
  }
  private async flush() {
    if (this.stopped || this.saving || this.failed || this.pending === undefined) return;
    const value = this.pending;
    this.pending = undefined;
    this.saving = true;
    try { await this.save(value); if (!this.stopped) this.result(value); }
    catch (error) { this.failed = true; if (!this.stopped) this.result(value, error); }
    finally {
      this.saving = false;
      if (this.pending !== undefined && !this.failed && !this.stopped) this.timer = setTimeout(() => void this.flush(), this.delay);
    }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.pending = undefined; }
}
