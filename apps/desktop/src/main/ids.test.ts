import { describe, expect, it } from 'vitest';
import { uuidV7 } from './ids';

describe('uuidV7', () => {
  it('creates lowercase RFC 9562 UUIDv7 identifiers', () => {
    expect(uuidV7(1_725_000_000_000)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encodes the unix millisecond timestamp in sortable order', () => {
    const earlier = uuidV7(1_700_000_000_000);
    const later = uuidV7(1_700_000_000_001);
    expect(earlier < later).toBe(true);
  });
});
