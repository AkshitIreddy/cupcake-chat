export const HISTORY_ERAS = [
  {
    id: 'egyptian',
    label: 'Egypt',
    dates: 'New Kingdom · c. 1550–1070 BCE',
    names: ['Khepi', 'Loti', 'Reed', 'Dune'],
  },
  {
    id: 'greek',
    label: 'Greece',
    dates: 'Classical & Hellenistic · c. 500–30 BCE',
    names: ['Thyme', 'Olea', 'Niko', 'Clio'],
  },
  {
    id: 'roman',
    label: 'Rome',
    dates: 'Republic & Empire · c. 300 BCE–400 CE',
    names: ['Milo', 'Flavia', 'Tessera', 'Farro'],
  },
  {
    id: 'viking',
    label: 'Viking Age',
    dates: 'Scandinavia · c. 750–1100 CE',
    names: ['Birch', 'Skerry', 'Ember', 'Freya'],
  },
  {
    id: 'mongol',
    label: 'Mongol Empire',
    dates: '13th–14th centuries',
    names: ['Saran', 'Tula', 'Altan', 'Nomi'],
  },
  {
    id: 'medieval',
    label: 'Medieval Europe',
    dates: 'c. 1000–1400 CE',
    names: ['Bram', 'Rose', 'Alder', 'Wren'],
  },
] as const;
export type HistoryEra = (typeof HISTORY_ERAS)[number]['id'];
export const HISTORY_PORTRAITS = HISTORY_ERAS.flatMap((era) =>
  era.names.map((name, index) => ({
    value: `product:art/history/${era.id}-${index}.webp`,
    label: `${name} · ${era.label}`,
  })),
);
export function historyPortraitSource(value?: string): string | null {
  return HISTORY_PORTRAITS.some((portrait) => portrait.value === value)
    ? `/${value!.slice('product:'.length)}`
    : null;
}
export function personaEra(avatar: string): string {
  return (
    HISTORY_ERAS.find((era) => avatar.startsWith(`product:art/history/${era.id}-`))?.id ?? 'general'
  );
}
