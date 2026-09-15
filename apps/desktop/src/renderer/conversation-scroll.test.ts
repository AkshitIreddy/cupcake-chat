import { describe, expect, it, vi } from 'vitest';

import {
  ConversationScrollController,
  type ConversationScrollSurface,
} from './conversation-scroll';

type TestSurface = ConversationScrollSurface & { scrollToMock: ReturnType<typeof vi.fn> };

function createSurface(): TestSurface {
  const scrollToMock = vi.fn<(options: ScrollToOptions) => void>();
  const surface: TestSurface = {
    clientHeight: 300,
    scrollHeight: 600,
    scrollTop: 300,
    scrollTo: scrollToMock,
    scrollToMock,
  };

  scrollToMock.mockImplementation(({ top }: ScrollToOptions) => {
    surface.scrollTop = Number(top ?? surface.scrollTop);
  });
  return surface;
}

describe('ConversationScrollController', () => {
  it('keeps following output while the reader is at the bottom', () => {
    const scheduled: Array<() => void> = [];
    const controller = new ConversationScrollController((callback) => {
      scheduled.push(callback);
      return 1;
    });
    const surface = createSurface();

    controller.observe(surface);
    surface.scrollHeight = 900;

    expect(controller.follow(surface)).toBe(true);
    scheduled.shift()?.();
    expect(surface.scrollToMock).toHaveBeenCalledWith({ behavior: 'auto', top: 900 });
  });

  it('does not pull the reader away from older messages', () => {
    const scheduled: Array<() => void> = [];
    const controller = new ConversationScrollController((callback) => {
      scheduled.push(callback);
      return 1;
    });
    const surface = createSurface();
    surface.scrollTop = 80;

    expect(controller.observe(surface)).toBe(false);
    surface.scrollHeight = 900;

    expect(controller.follow(surface)).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(surface.scrollToMock).not.toHaveBeenCalled();
  });

  it('resumes following when the reader jumps to the latest message', () => {
    const scheduled: Array<() => void> = [];
    const controller = new ConversationScrollController((callback) => {
      scheduled.push(callback);
      return 1;
    });
    const surface = createSurface();
    surface.scrollTop = 40;
    controller.observe(surface);
    surface.scrollHeight = 950;

    expect(controller.follow(surface, { force: true })).toBe(true);
    scheduled.shift()?.();
    expect(surface.scrollToMock).toHaveBeenCalledWith({ behavior: 'auto', top: 950 });
    expect(controller.isFollowing()).toBe(true);
  });

  it('keeps following when layout grows before its scroll event', () => {
    const scheduled: Array<() => void> = [];
    const controller = new ConversationScrollController((callback) => {
      scheduled.push(callback);
      return 1;
    });
    const surface = createSurface();
    controller.observe(surface);
    surface.scrollHeight = 900;
    expect(controller.observe(surface)).toBe(true);
    controller.follow(surface);
    scheduled.shift()?.();
    expect(surface.scrollToMock).toHaveBeenCalledWith({ behavior: 'auto', top: 900 });
  });

  it('cancels a queued follow when the reader scrolls up before the frame', () => {
    const scheduled: Array<() => void> = [];
    const controller = new ConversationScrollController((callback) => {
      scheduled.push(callback);
      return 1;
    });
    const surface = createSurface();
    controller.observe(surface);
    controller.follow(surface);
    surface.scrollTop = 40;
    expect(controller.observe(surface)).toBe(false);
    scheduled.shift()?.();
    expect(surface.scrollToMock).not.toHaveBeenCalled();
  });
});
