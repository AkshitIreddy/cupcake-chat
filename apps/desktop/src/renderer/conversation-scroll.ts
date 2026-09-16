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
  private lastScrollTop = 0;
  private lastScrollHeight = 0;
  private lastClientHeight = 0;
  private measured = false;

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
    const layoutChanged =
      surface.scrollHeight !== this.lastScrollHeight ||
      surface.clientHeight !== this.lastClientHeight;
    const movedUp = surface.scrollTop < this.lastScrollTop - 1;
    // Content growth can produce a scroll event before the next follow frame.
    // Only an actual move away from the end should disable automatic following.
    if (!this.measured || !this.following || movedUp || !layoutChanged)
      this.following = distanceFromBottom <= this.bottomThreshold;
    this.measured = true;
    this.lastScrollTop = surface.scrollTop;
    this.lastScrollHeight = surface.scrollHeight;
    this.lastClientHeight = surface.clientHeight;
    return this.following;
  }

  follow(
    surface: ConversationScrollSurface,
    options: { force?: boolean; smooth?: boolean } = {},
  ): boolean {
    if (options.force) {
      this.following = true;
      // A send is an explicit request to leave history. Apply it before queued
      // scroll events can mistake the old position for a new reader gesture.
      if (!options.smooth) {
        surface.scrollTo({ behavior: 'auto', top: surface.scrollHeight });
        this.lastScrollTop = surface.scrollTop;
        this.lastScrollHeight = surface.scrollHeight;
        this.lastClientHeight = surface.clientHeight;
        this.measured = true;
      }
    }
    if (!this.following) return false;
    if (this.framePending) return true;
    this.framePending = true;
    this.schedule(() => {
      this.framePending = false;
      if (!this.following) return;
      surface.scrollTo({
        behavior: options.smooth ? 'smooth' : 'auto',
        top: surface.scrollHeight,
      });
      this.lastScrollTop = surface.scrollTop;
      this.lastScrollHeight = surface.scrollHeight;
      this.lastClientHeight = surface.clientHeight;
      this.measured = true;
    });
    return true;
  }

  isFollowing(): boolean {
    return this.following;
  }
}
