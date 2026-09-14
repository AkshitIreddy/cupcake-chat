export type Coordinate = readonly [number, number];
export function distanceKm(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
}
function positive(...values: number[]) {
  if (values.some((n) => !Number.isFinite(n) || n <= 0))
    throw new Error('Use positive, finite values.');
}
export function journey(km: number, detour: number, pace: number, delay: number) {
  positive(detour, pace);
  if (!Number.isFinite(km) || km < 0 || !Number.isFinite(delay) || delay < 0 || detour < 1)
    throw new Error('Invalid journey assumptions.');
  const distance = km * detour;
  return { distance, movingDays: distance / pace, totalDays: distance / pace + delay };
}
export function granary(
  stock: number,
  spoilage: number,
  people: number,
  ration: number,
  arrivals: number,
  day: number,
) {
  positive(people, ration);
  if (
    ![stock, spoilage, arrivals, day].every(Number.isFinite) ||
    stock < 0 ||
    spoilage < 0 ||
    spoilage > 100 ||
    arrivals < 0 ||
    day < 0
  )
    throw new Error('Invalid supply assumptions.');
  const usable = stock * (1 - spoilage / 100);
  const initialDays = usable / (people * ration);
  const remaining = Math.max(0, usable - people * ration * day);
  const furtherDays = remaining / ((people + arrivals) * ration);
  return {
    usable,
    initialDays,
    remaining,
    furtherDays,
    totalDays: day >= initialDays ? initialDays : day + furtherDays,
  };
}
export function forage(
  riders: number,
  mounts: number,
  kgPerHorse: number,
  grazing: number,
  days: number,
) {
  positive(riders, mounts, kgPerHorse, days);
  if (!Number.isFinite(grazing) || grazing < 0 || grazing > 100)
    throw new Error('Grazing share must be 0–100%.');
  const horses = riders * mounts;
  const dailyNeed = horses * kgPerHorse;
  return {
    horses,
    dailyNeed,
    grazed: (dailyNeed * grazing) / 100,
    carried: dailyNeed * (1 - grazing / 100) * days,
  };
}
