// Era buckets for an artwork's year, used by the Wall filters.
export const ERAS = [
  { key: "early", label: "Before 1800", from: -100000, to: 1799 }, // BC years are negative
  { key: "1800s", label: "1800s", from: 1800, to: 1899 },
  { key: "1900", label: "1900–1945", from: 1900, to: 1945 },
  { key: "1946", label: "1946–1979", from: 1946, to: 1979 },
  { key: "1980", label: "1980–1999", from: 1980, to: 1999 },
  { key: "2000", label: "2000s", from: 2000, to: 2009 },
  { key: "2010", label: "2010s", from: 2010, to: 2019 },
  { key: "2020", label: "2020s", from: 2020, to: 2099 },
];

export function eraOf(year: number | null): string | null {
  if (!year) return null;
  return ERAS.find((e) => year >= e.from && year <= e.to)?.key ?? null;
}
