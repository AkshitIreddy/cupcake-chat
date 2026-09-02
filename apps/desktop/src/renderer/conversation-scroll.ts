export interface ConversationScrollSurface {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  scrollTo(options: ScrollToOptions): void;
}

type ScheduleFrame = (callback: () => void) => number;

const DEFAULT_BOTTOM_THRESHOLD = 72;

export class ConversationScrollController {
  private following = true;
  private framePending = false;

  constructor(
    private readonly schedule: ScheduleFrame = (callback) =>
      window.requestAnimationFrame(() => callback()),
    private readonly bottomThreshold = DEFAULT_BOTTOM_THRESHOLD,
  ) {}

  observe(surface: ConversationScrollSurface): boolean {
    const distanceFromBottom = Math.max(
      0,
      surface.scrollHeight - surface.clientHeight - surface.scrollTop,
    );
    this.following = distanceFromBottom <= this.bottomThreshold;
    return this.following;
  }

  follow(
    surface: ConversationScrollSurface,
    options: { force?: boolean; smooth?: boolean } = {},
  ): boolean {
    if (options.force) this.following = true;
    if (!this.following) return false;
    if (this.framePending) return true;
    this.framePending = true;
    this.schedule(() => {
      this.framePending = false;
      surface.scrollTo({
        behavior: options.smooth ? 'smooth' : 'auto',
        top: surface.scrollHeight,
      });
    });
    return true;
  }

  isFollowing(): boolean {
    return this.following;
  }
}
