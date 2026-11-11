// Moments in art, design and photography for the Century page's rail: movements,
// inventions and institutions rather than single works, a few to each stretch of rows
// so the rail keeps pace with the quilt. Each is filed under the medium it belongs to
// (aotd/media.py keys), so it wears that medium's shape. Years are when the moment is
// usually said to begin; "c." marks the approximate.
//
// Each moment also says which of the archive's works bear it out (momentWorks), and is
// strict about it: works made within its years by artists Wikidata files under that
// very movement, by its hand-picked key artists (as the archive names them), in its
// theme posts, or by artists whose roles name it. Where the moment is about a medium
// (the printing press, the daguerreotype), only works in that medium count (`only`).
// What the archive can't tie to a moment is offered separately and labelled as such:
// its medium from those years, and failing that its medium nearest in time.

import { isCopy, yearOf } from "./century";
import type { ArtworkRow, Post } from "./types";

export interface Milestone {
  year: number;
  label: string; // the moment
  note: string; // a line of context
  medium: string;
  circa?: boolean;
  from: number; // the years its works are drawn from
  to: number;
  movements?: string[]; // Wikidata movements of its artists (lower case)
  artists?: string[]; // post subjects (lower case)
  subjects?: string[]; // words in theme posts' subjects
  roles?: string[]; // whole words in an artist's roles or descriptor
  only?: string[]; // media a linked work must be in (a moment about a medium)
}

export const MILESTONES: Milestone[] = [
  // 1400–1799: a row is a century
  { year: 1415, circa: true, label: "Linear perspective", note: "Brunelleschi gives painting depth", medium: "drawing",
    from: 1415, to: 1510, movements: ["early renaissance", "italian renaissance"],
    artists: ["piero della francesca", "paolo uccello", "andrea mantegna", "masaccio", "fra angelico", "filippo lippi",
              "filippino lippi", "sandro botticelli", "carlo crivelli", "giovanni bellini", "vittore carpaccio"] },
  { year: 1450, circa: true, label: "The printing press", note: "Images and type multiply", medium: "print",
    from: 1450, to: 1600, only: ["print"], artists: ["albrecht dürer", "martin schongauer", "lucas cranach the elder"],
    roles: ["printmaker", "engraver"] },
  { year: 1500, circa: true, label: "The High Renaissance", note: "Leonardo, Michelangelo, Raphael", medium: "painting",
    from: 1490, to: 1560, movements: ["high renaissance"],
    artists: ["leonardo da vinci", "michelangelo", "raphael", "titian", "giorgione"] },
  { year: 1600, circa: true, label: "The Baroque", note: "Drama, light and movement", medium: "painting",
    from: 1590, to: 1720, movements: ["baroque", "baroque painting", "dutch golden age painting"],
    artists: ["caravaggio", "rembrandt", "peter paul rubens", "diego velázquez", "vermeer", "artemisia gentileschi"] },
  { year: 1648, label: "The academies", note: "Art taught, ranked and exhibited", medium: "sculpture",
    from: 1648, to: 1800, movements: ["academic art", "neoclassicism"] },
  { year: 1710, label: "European porcelain", note: "Meissen cracks China’s secret", medium: "ceramics",
    from: 1700, to: 1800, only: ["ceramics"], roles: ["porcelain"] },
  { year: 1730, circa: true, label: "Rococo", note: "Ornament for salons and interiors", medium: "design",
    from: 1715, to: 1790, movements: ["rococo"], artists: ["françois boucher"] },
  { year: 1796, label: "Lithography", note: "Printing from stone", medium: "print",
    from: 1796, to: 1880, only: ["print", "graphic"], artists: ["honoré daumier", "francisco goya"], roles: ["lithographer"] },

  // 1800–1899
  { year: 1820, circa: true, label: "Romanticism", note: "Feeling over reason", medium: "painting",
    from: 1790, to: 1860, movements: ["romanticism"], artists: ["francisco goya", "eugène delacroix"] },
  { year: 1826, circa: true, label: "Photography is born", note: "Niépce fixes a view from his window", medium: "photography",
    from: 1826, to: 1860, only: ["photography"] },
  { year: 1839, label: "The daguerreotype", note: "Photography goes public", medium: "photography",
    from: 1839, to: 1880, only: ["photography"] },
  { year: 1851, label: "Design for industry", note: "The Great Exhibition, London", medium: "design",
    from: 1840, to: 1910, only: ["design"] },
  { year: 1861, label: "Arts and Crafts", note: "William Morris against the machine", medium: "design",
    from: 1848, to: 1925, movements: ["arts and crafts movement"], artists: ["william morris"] },
  { year: 1874, label: "Impressionism", note: "Painting light, out of doors", medium: "painting",
    from: 1860, to: 1915, movements: ["impressionism"],
    artists: ["claude monet", "pierre-auguste renoir", "camille pissarro", "mary cassatt", "gustave caillebotte", "édouard manet"] },
  { year: 1888, label: "The snapshot", note: "Kodak puts a camera in every hand", medium: "photography",
    from: 1888, to: 1930, only: ["photography"] },
  { year: 1891, label: "The art poster", note: "Colour lithography fills the streets", medium: "graphic",
    from: 1880, to: 1920, only: ["graphic", "print"], movements: ["art nouveau"],
    artists: ["henri de toulouse-lautrec", "alphonse mucha", "leonetto cappiello"] },
  { year: 1895, label: "Cinema", note: "The Lumières’ first screening", medium: "media",
    from: 1895, to: 1960, only: ["media", "graphic", "photography"], subjects: ["film posters"], roles: ["filmmaker", "animator"] },

  // 1900–1999
  { year: 1907, label: "Cubism", note: "Picasso and Braque break the picture plane", medium: "painting",
    from: 1906, to: 1935, movements: ["cubism", "orphism", "purism"] },
  { year: 1916, label: "Dada", note: "Anti-art, and the readymade", medium: "sculpture",
    from: 1914, to: 1935, movements: ["dada"],
    artists: ["marcel duchamp", "man ray", "hannah höch", "kurt schwitters", "jean arp"] },
  { year: 1919, label: "The Bauhaus", note: "Art, craft and industry as one school", medium: "design",
    from: 1917, to: 1945, movements: ["bauhaus"], subjects: ["bauhaus"],
    artists: ["paul klee", "wassily kandinsky", "lászló moholy-nagy", "josef albers", "oskar schlemmer", "marcel breuer",
              "herbert bayer", "lyonel feininger", "lyonel charles feininger", "marianne brandt", "johannes itten"] },
  { year: 1924, label: "Surrealism", note: "The unconscious takes the brush", medium: "painting",
    from: 1922, to: 1970, movements: ["surrealism", "metaphysical painting"] },
  { year: 1925, label: "Art Deco", note: "The Paris exposition sets a style", medium: "design",
    from: 1920, to: 1942, movements: ["art deco"], subjects: ["art deco"] },
  { year: 1936, label: "The photo essay", note: "Life magazine and photojournalism", medium: "photography",
    from: 1930, to: 1975, only: ["photography"], movements: ["humanistic photography", "straight photography"],
    roles: ["photojournalist", "documentary photographer"] },
  { year: 1947, label: "Abstract Expressionism", note: "New York becomes the centre", medium: "painting",
    from: 1943, to: 1975, movements: ["abstract expressionism", "action painting", "color field"] },
  { year: 1957, label: "The Swiss Style", note: "Grids, sans serifs and Helvetica", medium: "graphic",
    from: 1950, to: 1980, only: ["graphic", "print"],
    artists: ["armin hofmann", "max bill", "richard paul lohse", "massimo vignelli", "emil ruder", "max huber",
              "otto \"otl\" aicher", "wim crouwel"] },
  { year: 1962, label: "Pop Art", note: "Screenprints of the supermarket", medium: "print",
    from: 1955, to: 1985, movements: ["pop art", "neo-pop", "capitalist realism"] },
  { year: 1965, label: "Video and installation", note: "Art leaves the frame", medium: "media",
    from: 1960, to: 1995, only: ["media", "sculpture"],
    movements: ["new media art", "fluxus", "conceptual art", "land art", "light art", "environmental art", "process art"],
    artists: ["yayoi kusama", "james turrell"], roles: ["installation artist", "video artist"] },
  { year: 1984, label: "Desktop publishing", note: "The Macintosh redraws graphic design", medium: "graphic",
    from: 1984, to: 2005, only: ["graphic", "print"],
    artists: ["april greiman", "zuzana licko & rudy vanderlans", "rudy vanderlans", "david carson", "neville brody"] },
  { year: 1990, label: "Digital imaging", note: "Photoshop, then the digital camera", medium: "photography",
    from: 1990, to: 2010, only: ["photography", "media", "graphic"],
    roles: ["photoshop", "photoshop artist", "photo manipulation", "retoucher", "digital photographer", "digital artist"] },

  // 2000 onwards
  { year: 2007, label: "The camera phone", note: "Everyone is a photographer", medium: "photography",
    from: 2007, to: 2016, only: ["photography"], roles: ["iphone", "iphoneographer", "mobile photographer"] },
  { year: 2010, label: "The feed", note: "Instagram makes images social", medium: "photography",
    from: 2010, to: 2026, only: ["photography"], roles: ["instagram", "influencer"] },
  { year: 2021, label: "NFTs", note: "Digital works bought and sold", medium: "media",
    from: 2020, to: 2026, roles: ["nft", "nft artist", "cryptoartist", "crypto artist"] },
  { year: 2022, label: "Generative images", note: "Pictures made from words", medium: "media",
    from: 2021, to: 2026, roles: ["ai artist", "ai art", "artificial intelligence", "generative artist", "generative art"] },
];

export const momentSlug = (ms: Milestone) => ms.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export interface ArtistFacts { roles: string[]; wikidata: { movements: string[] } | null }

/** The archive's works for a moment: those tied to it (nearest its year first), then,
 *  kept apart, its medium around it. At least `atLeast` works in all whenever its
 *  medium has any. `media` is SiteData.media's keys, in order. */
export function momentWorks(ms: Milestone, rows: ArtworkRow[], posts: Post[], artistOf: (slug: string) => ArtistFacts | undefined,
                            media: string[], atLeast = 24) {
  const mediumIndex = media.indexOf(ms.medium);
  const only = ms.only ? new Set(ms.only.map((k) => media.indexOf(k))) : null;
  const movements = new Set(ms.movements ?? []);
  const artists = new Set(ms.artists ?? []);
  const roles = ms.roles?.length
    ? new RegExp(`(?<![\\w-])(?:${ms.roles.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-])`, "i")
    : null;
  const near = (a: ArtworkRow, b: ArtworkRow) => Math.abs(yearOf(a)! - ms.year) - Math.abs(yearOf(b)! - ms.year);
  const linked: ArtworkRow[] = [], around: ArtworkRow[] = [], rest: ArtworkRow[] = [];
  for (const r of rows) {
    const y = yearOf(r);
    if (y == null || r[7] == null || isCopy(r)) continue;
    const inside = y >= ms.from && y <= ms.to;
    if (inside && (!only || only.has(r[7]))) {
      const post = posts[r[0]];
      const a = post.artist ? artistOf(post.artist) : undefined;
      const subject = (post.subject ?? "").toLowerCase();
      const hit = artists.has(subject)
        || (a?.wikidata?.movements ?? []).some((m) => movements.has(m.toLowerCase()))
        || (post.kind === "theme" && (ms.subjects ?? []).some((s) => subject.includes(s)))
        || (roles != null && roles.test(`${post.descriptor ?? ""} ${(a?.roles ?? []).join(" ")}`));
      if (hit) { linked.push(r); continue; }
    }
    if (r[7] === mediumIndex) (inside ? around : rest).push(r);
  }
  linked.sort(near);
  around.sort(near);
  // Too few even then (porcelain before 1800, say): the medium nearest in time.
  const nearest = linked.length + around.length < atLeast ? rest.sort(near).slice(0, atLeast - linked.length - around.length) : [];
  return { linked, around: [...around, ...nearest], widened: nearest.length > 0 };
}
