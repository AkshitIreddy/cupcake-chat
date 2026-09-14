import { describe, expect, it } from 'vitest';
import { distanceKm, forage, granary, journey } from './history-math';
describe('historical scenario calculations', () => {
  it('measures spherical distance without pretending it is a navigable road', () => {
    expect(distanceKm([0, 0], [0, 0])).toBe(0);
    expect(distanceKm([0, 0], [1, 0])).toBeCloseTo(111.195, 2);
    expect(distanceKm([0, 0], [180, 0])).toBeCloseTo(Math.PI * 6371.0088);
  });
  it('keeps delay separate from travel and detours', () => {
    expect(journey(100, 1.5, 25, 2)).toEqual({ distance: 150, movingDays: 6, totalDays: 8 });
  });
  it('accounts for the arrival only after ten full days of original consumption', () => {
    const result = granary(18000, 10, 600, 0.75, 120, 10);
    expect(result.usable).toBe(16200);
    expect(result.initialDays).toBe(36);
    expect(result.remaining).toBe(11700);
    expect(result.totalDays).toBeCloseTo(31.6666667);
  });
  it('does not invent stock when arrivals occur after exhaustion', () => {
    expect(granary(18000, 10, 600, 0.75, 120, 40).totalDays).toBe(36);
    expect(granary(0, 0, 600, 1, 0, 0).totalDays).toBe(0);
  });
  it('separates grazing from carried forage and scales remounts', () => {
    expect(forage(100, 3, 10, 80, 5).carried).toBeCloseTo(3000);
    expect(forage(100, 6, 10, 80, 5).carried).toBeCloseTo(6000);
    expect(forage(100, 3, 10, 100, 5).carried).toBe(0);
  });
  it('rejects impossible and non-finite assumptions', () => {
    expect(() => journey(100, 1, 0, 0)).toThrow();
    expect(() => forage(100, 3, 10, 101, 5)).toThrow();
    expect(() => granary(100, 0, 0, 1, 0, 0)).toThrow();
    expect(() => granary(NaN, 0, 1, 1, 0, 0)).toThrow();
  });
});
