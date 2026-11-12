// Moments in art, design and photography for the Century page's rail: movements,
// inventions and institutions rather than single works, a few to each stretch of rows
// so the rail keeps pace with the quilt. Each is filed under the medium it belongs to
// (aotd/media.py keys), so it wears that medium's shape. Years are when the moment is
// usually said to begin; "c." marks the approximate.
//
// Each moment names the archive's works that bear it out, and only those (momentWorks):
// works by artists checked by hand as part of it, from the years they were (an artist's
// own span where it's narrower than the moment's), or from theme posts about it. Where a
// moment is about a medium (the printing press, lithography, the poster) only works in
// that medium count (`only`). A work needs a stated date or a close estimate: a rough
// one could fall either side of an artist's years in a movement. Moments the archive
// has nothing from yet say so rather than borrow works that aren't of them.

import { CLOSE, DATED, isCopy, kindOf, yearOf } from "./century";
import { MOMENT_EXCLUSIONS } from "./moment-exclusions";
import type { ArtworkRow, Post } from "./types";

export interface Milestone {
  year: number;
  label: string; // the moment
  note: string; // a line of context
  about: string; // a few sentences on what happened and why it mattered
  medium: string;
  circa?: boolean;
  from: number; // the moment's years, for works by its artists
  to: number;
  // Artist slugs, checked by hand: "slug@1907-1921" for an artist's own years in it, "slug@any"
  // for one whose every work belongs to it (whatever its date), and a trailing "!" for one
  // whose estimated dates can't be trusted (their works need a stated date).
  artists?: string[];
  posts?: string[]; // theme posts about it (Blogger ids)
  only?: string[]; // media a work must be in (a moment about a medium)
}

export const MILESTONES: Milestone[] = [
  // 1400–1799: a row is a century
  { year: 1415, circa: true, label: "Linear perspective", note: "Brunelleschi gives painting depth", medium: "drawing",
    about: "In Florence around 1415, Filippo Brunelleschi showed how lines running to a single vanishing point could make a flat panel read as deep space; Leon Battista Alberti set the method down in 1435. Within a generation painters across Italy were building their pictures on it, setting figures in measured, believable rooms and streets.",
    from: 1415, to: 1510, only: ["painting", "drawing"],
    artists: ["piero-della-francesca", "carlo-crivelli", "giovanni-bellini", "vittore-carpaccio", "sandro-botticelli", "filippino-lippi"] },
  { year: 1450, circa: true, label: "The printing press", note: "Images and type multiply", medium: "print",
    about: "Johannes Gutenberg's movable type, in Mainz around 1450, made the printed page cheap and repeatable, and pictures travelled with it. Woodcuts and engravings carried images across Europe for the first time, and artists such as Albrecht Dürer and Lucas Cranach made the print an art in its own right.",
    from: 1450, to: 1600, only: ["print"], artists: ["lucas-cranach-the-elder"] },
  { year: 1500, circa: true, label: "The High Renaissance", note: "Leonardo, Michelangelo, Raphael", medium: "painting",
    about: "For about three decades either side of 1500, Leonardo, Michelangelo and Raphael brought the century's discoveries in perspective, anatomy and light to a balanced, monumental peak in Florence and Rome. Venice answered with Giorgione and Titian, who built pictures from colour rather than line.",
    from: 1490, to: 1560,
    artists: ["leonardo-da-vinci", "michelangelo", "raphael", "titian", "andrea-del-sarto", "lorenzo-lotto"] },
  { year: 1600, circa: true, label: "The Baroque", note: "Drama, light and movement", medium: "painting",
    about: "Around 1600 Caravaggio's raking light and unidealised, everyday figures broke with the poise of the Renaissance. The Baroque that followed traded calm for drama, with movement, deep shadow and feeling meant to overwhelm, from Rubens in Antwerp and Velázquez in Madrid to the quieter rooms of Rembrandt and Vermeer.",
    from: 1590, to: 1720,
    artists: ["caravaggio", "artemisia-gentileschi", "peter-paul-rubens", "diego-velazquez", "rembrandt", "vermeer",
              "elisabetta-sirani", "jacob-van-ruisdael"] },
  { year: 1648, label: "The academies", note: "Art taught, ranked and exhibited", medium: "sculpture",
    about: "The Académie royale de peinture et de sculpture was founded in Paris in 1648, and the model spread across Europe; London's Royal Academy followed in 1768. Academies taught drawing from antique casts and the life model, ranked history painting above every other subject, and ran the exhibitions where reputations were made.",
    from: 1648, to: 1800, only: ["painting", "sculpture", "drawing"],
    artists: ["jacques-louis-david", "angelica-kauffmann", "elisabeth-vigee-lebrun", "antonio-canova", "marie-guillemine-benoist"] },
  { year: 1710, label: "European porcelain", note: "Meissen cracks China’s secret", medium: "ceramics",
    about: "Hard-paste porcelain had been made in China for centuries and shipped to Europe at great cost. In 1710 the Meissen manufactory near Dresden, built on Johann Friedrich Böttger's experiments, became the first in Europe to make it, and royal factories at Vienna, Sèvres and elsewhere soon followed.",
    from: 1700, to: 1800, only: ["ceramics"] },
  { year: 1730, circa: true, label: "Rococo", note: "Ornament for salons and interiors", medium: "design",
    about: "In early eighteenth-century France ornament grew light and playful: pastel colour, asymmetric shell-like curves, and scenes of leisure and courtship made for salons and private rooms rather than churches and palaces. Watteau, Boucher and Fragonard are its painters; from the 1760s it gave way to the sterner lines of Neoclassicism.",
    from: 1715, to: 1790, artists: ["francois-boucher"] },
  { year: 1796, label: "Lithography", note: "Printing from stone", medium: "print",
    about: "In Munich in 1796 Alois Senefelder found that a drawing made in greasy crayon on limestone could be inked and printed. Lithography let artists draw straight for the press, cheaply and in long runs; Goya, Daumier and Manet took it up, and in colour it would later fill the streets with posters.",
    from: 1796, to: 1880, only: ["print"], artists: ["edouard-manet"] },

  // 1800–1899
  { year: 1820, circa: true, label: "Romanticism", note: "Feeling over reason", medium: "painting",
    about: "Against the Enlightenment's reason, Romantic artists put feeling, imagination and the sublime first: storms, ruins, revolt, the individual against nature and history. Delacroix's colour, Goya's dark visions and Turner's light set its tone in the decades after 1800.",
    from: 1790, to: 1860,
    artists: ["eugene-delacroix", "francisco-goya@1793-1828", "sir-thomas-lawrence", "francesco-hayez", "antoine-joseph-wiertz"] },
  { year: 1826, circa: true, label: "Photography is born", note: "Niépce fixes a view from his window", medium: "photography",
    about: "Around 1826 Nicéphore Niépce fixed the view from an upstairs window of his house in Burgundy onto a pewter plate coated with bitumen, after an exposure of hours or even days. It is the oldest surviving photograph taken with a camera.",
    from: 1826, to: 1860, only: ["photography"] },
  { year: 1839, label: "The daguerreotype", note: "Photography goes public", medium: "photography",
    about: "In 1839 the French state bought Louis Daguerre's process and gave it to the world. Each daguerreotype was a single, unrepeatable image on silvered copper, astonishingly sharp, and within a decade portrait studios were open across Europe and America. That same year William Henry Fox Talbot announced his paper process, which led to the reproducible print.",
    from: 1839, to: 1880, only: ["photography"] },
  { year: 1851, label: "Design for industry", note: "The Great Exhibition, London", medium: "design",
    about: "The Great Exhibition of 1851, in London's Crystal Palace, set the products of industry from around the world side by side. It showed what machines could make, and how badly much of it was designed, and it led to new schools and museums of design and a long argument about art and manufacture.",
    from: 1840, to: 1910, only: ["design"] },
  { year: 1861, label: "Arts and Crafts", note: "William Morris against the machine", medium: "design",
    about: "In 1861 William Morris and his friends founded the firm that became Morris & Co., making wallpapers, textiles, furniture and stained glass by hand. Following John Ruskin, the Arts and Crafts movement held that honest materials and skilled handwork could restore the dignity the factory had taken from labour, and it spread from Britain to Europe and America.",
    from: 1848, to: 1925, artists: ["william-morris@any"] },
  { year: 1874, label: "Impressionism", note: "Painting light, out of doors", medium: "painting",
    about: "In 1874 a group of painters shut out of the official Salon held their own exhibition in Paris; a critic took their name from Monet's Impression, Sunrise. Painting out of doors in quick, broken strokes, they caught modern life and the passing effects of light, and showed together eight times until 1886.",
    from: 1860, to: 1915, only: ["painting", "drawing", "print"],
    artists: ["claude-monet@1867-1915", "pierre-auguste-renoir@1869-1900", "camille-pissarro@1869-1903", "mary-cassatt@1877-1914",
              "gustave-caillebotte", "edouard-manet@1870-1883", "paul-gauguin@1879-1886", "frits-thaulow@1883-1905"] },
  { year: 1888, label: "The snapshot", note: "Kodak puts a camera in every hand", medium: "photography",
    about: "Kodak's first camera, in 1888, came loaded with film for a hundred pictures, and owners sent the whole camera back to be developed: “You press the button, we do the rest.” Photography stopped being a craft for professionals, and the casual, candid snapshot was born.",
    from: 1888, to: 1930, only: ["photography"] },
  { year: 1891, label: "The art poster", note: "Colour lithography fills the streets", medium: "graphic",
    about: "When Toulouse-Lautrec's Moulin Rouge poster went up in Paris in 1891, colour lithography had made the advertising poster an art form. Chéret, Mucha and Cappiello filled the city's walls, and the poster spread to Germany, Britain and America as a new kind of public art.",
    from: 1880, to: 1920, only: ["graphic", "print"],
    artists: ["henri-de-toulouse-lautrec", "alphonse-mucha", "leonetto-cappiello", "edward-penfield", "ludwig-hohlwein",
              "lucian-bernhard", "sven-brasch", "mcknight-kauffer"] },
  { year: 1895, label: "Cinema", note: "The Lumières’ first screening", medium: "media",
    about: "On 28 December 1895 the Lumière brothers projected their films to a paying audience in a Paris café. Within a few decades cinema was the century's great popular art, and it brought a graphic culture with it: posters, title cards and, later, title sequences.",
    from: 1895, to: 1960, only: ["graphic", "print"],
    posts: ["2111931777761209638"], artists: ["sven-brasch", "saul-bass", "jan-lenica", "waldemar-swierzy"] },

  // 1900–1999
  { year: 1907, label: "Cubism", note: "Picasso and Braque break the picture plane", medium: "painting",
    about: "In 1907 Picasso painted Les Demoiselles d'Avignon; with Braque he went on to break objects into facets seen from several sides at once, and then to build pictures from pasted paper. Cubism gave the century a new grammar of form, taken up by Gris, Léger, the Delaunays and painters across Europe.",
    from: 1906, to: 1935, only: ["painting", "drawing", "print", "sculpture"],
    artists: ["pablo-picasso@1907-1921", "georges-braque@1907-1925", "juan-gris", "fernand-leger@1909-1925",
              "robert-delaunay@1910-1930", "sonia-delaunay@1911-1916", "lyubov-popova@1912-1917", "alexander-archipenko@1909-1925",
              "francis-picabia@1909-1914", "amedee-ozenfant@1918-1925", "le-corbusier@1918-1925", "andre-lhote@1911-1930"] },
  { year: 1916, label: "Dada", note: "Anti-art, and the readymade", medium: "sculpture",
    about: "Dada began at the Cabaret Voltaire in Zurich in 1916, in the middle of the First World War, and answered a senseless war with nonsense, chance and provocation. It spread to Berlin, Paris and New York, and gave art the photomontage, the sound poem and Duchamp's readymade.",
    from: 1914, to: 1935,
    artists: ["marcel-duchamp@1913-1923", "man-ray@1915-1925", "hannah-hoch@1918-1933", "max-ernst@1919-1923",
              "sophie-taeuber-arp@1916-1926", "francis-picabia@1915-1924", "kurt-schwitters", "jean-arp@1915-1925"] },
  { year: 1919, label: "The Bauhaus", note: "Art, craft and industry as one school", medium: "design",
    about: "Walter Gropius opened the Bauhaus in Weimar in 1919 to bring art, craft and industry together in one school. Through its moves to Dessau and Berlin, until the Nazis forced it shut in 1933, its teachers and students shaped modern furniture, typography, architecture and the teaching of art, and many carried it abroad.",
    from: 1919, to: 1946, posts: ["7010714170628241877"],
    artists: ["paul-klee@1921-1931", "wassily-kandinsky@1922-1933", "lyonel-feininger@1919-1933", "johannes-itten@1919-1923",
              "laszlo-moholy-nagy@1923-1930", "oskar-schlemmer@1920-1929", "marianne-brandt@1923-1929",
              "herbert-bayer@1921-1928", "marcel-breuer@1920-1931", "josef-albers@1920-1933"] },
  { year: 1924, label: "Surrealism", note: "The unconscious takes the brush", medium: "painting",
    about: "André Breton's Surrealist Manifesto of 1924 called for art driven by dreams and the unconscious, beyond reason's control. Its painters went two ways: the automatic, improvised drawing of Miró and Ernst, and the uncanny, precisely painted dream images of Dalí, Magritte and Delvaux.",
    from: 1922, to: 1970,
    artists: ["salvador-dali@1927-1970", "rene-magritte", "joan-miro@1924-1970", "max-ernst", "man-ray@1922-1940",
              "jean-arp@1925-1945", "paul-delvaux@1934-1970", "eileen-agar", "frida-kahlo@1932-1954", "wifredo-lam@1938-1970",
              "alberto-giacometti@1929-1935"] },
  { year: 1925, label: "Art Deco", note: "The Paris exposition sets a style", medium: "design",
    about: "The 1925 Exposition internationale des arts décoratifs in Paris gave the style its later name. Art Deco borrowed geometry from Cubism, speed from the machine and motifs from ancient Egypt, and set them in skyscrapers, ocean liners, posters and jewellery through the 1930s.",
    from: 1920, to: 1942, posts: ["5859441914669266340", "6154494804924500813"], artists: ["tamara-de-lempicka"] },
  { year: 1936, label: "The photo essay", note: "Life magazine and photojournalism", medium: "photography",
    about: "Life magazine's first issue, in November 1936, opened with Margaret Bourke-White's photographs of the Fort Peck Dam. Picture magazines made the photo essay, a story told through a sequence of photographs, the main way people saw the wider world until television took over.",
    from: 1930, to: 1975, only: ["photography"],
    artists: ["margaret-bourke-white", "alfred-eisenstaedt", "william-eugene-smith", "henri-cartier-bresson", "walker-evans",
              "ralph-crane", "ernest-c-withers", "sir-donald-mccullin", "raghu-rai"] },
  { year: 1947, label: "Abstract Expressionism", note: "New York becomes the centre", medium: "painting",
    about: "In the late 1940s New York painters including Jackson Pollock, Willem de Kooning and Mark Rothko turned to large abstract canvases made of gesture or fields of colour. Pollock's poured paintings of 1947 to 1950 became its emblem, and the movement moved the centre of the art world from Paris to New York.",
    from: 1943, to: 1975,
    artists: ["jackson-pollock", "mark-rothko@1946-1970", "elaine-de-kooning", "barnett-newman", "helen-frankenthaler",
              "robert-motherwell", "morris-louis", "philip-guston@1950-1967", "richard-diebenkorn@1948-1955", "paul-jenkins",
              "david-smith@1945-1965", "peter-voulkos@1954-1975"] },
  { year: 1957, label: "The Swiss Style", note: "Grids, sans serifs and Helvetica", medium: "graphic",
    about: "In 1957 both Helvetica and Univers were released, and the Swiss Style took hold: a strict grid, sans-serif type set flush left, and objective photography in place of illustration. Spread by the schools at Basel and Zurich and the journal Neue Grafik, it became the house style of international modernism.",
    from: 1950, to: 1980, only: ["graphic", "print"],
    artists: ["emil-ruder", "armin-hofmann", "richard-paul-lohse", "max-huber", "max-bill", "adrian-frutiger",
              "otto-otl-aicher", "wim-crouwel", "massimo-vignelli"] },
  { year: 1962, label: "Pop Art", note: "Screenprints of the supermarket", medium: "print",
    about: "Pop Art began in Britain in the mid-1950s with Richard Hamilton and the Independent Group, and broke through in New York in 1962 with Warhol's soup cans and Lichtenstein's comic-strip paintings. It took its subjects and methods from advertising, comics and mass production, screenprinting above all.",
    from: 1955, to: 1985,
    artists: ["roy-lichtenstein!", "tom-wesselmann", "peter-blake@1955-1975!", "robert-indiana", "marisol-escobar",
              "james-rosenquist", "george-segal@1961-1975", "richard-hamilton@1956-1975", "claes-oldenburg", "allen-jones", "ed-ruscha@1960-1975",
              "david-hockney@1960-1970", "sister-corita-kent@1962-1975", "peter-max", "wayne-thiebaud@1961-1975", "richard-lindner",
              "gerhard-richter@1962-1966", "marta-minujin"] },
  { year: 1965, label: "Video and installation", note: "Art leaves the frame", medium: "media",
    about: "In 1965 Nam June Paik turned one of the first portable video cameras on the streets of New York. Through the 1960s artists left the framed picture behind for environments to walk through, light, land, actions and video, made for a particular place or moment.",
    from: 1960, to: 1995,
    artists: ["christo-and-jeanne-claude", "yayoi-kusama", "robert-smithson", "daniel-flavin", "sol-lewitt", "edward-kienholz",
              "yoko-ono", "rebecca-horn", "alice-aycock", "richard-serra", "helio-oiticica", "kishio-suga", "eleanor-antin",
              "nancy-rubins", "isa-genzken", "lee-bul"] },
  { year: 1984, label: "Desktop publishing", note: "The Macintosh redraws graphic design", medium: "graphic",
    about: "The Apple Macintosh arrived in 1984, followed by PostScript and PageMaker. Designers could now set type and lay out pages on screen; Emigre magazine, April Greiman and later David Carson used the new tools to break the modernist grid, and designing typefaces opened to anyone with a computer.",
    from: 1984, to: 2005, only: ["graphic", "print"],
    artists: ["rudy-vanderlans", "zuzana-licko-rudy-vanderlans", "april-greiman", "neville-brody!", "david-carson",
              "jonathan-barnbrook"] },
  { year: 1990, label: "Digital imaging", note: "Photoshop, then the digital camera", medium: "photography",
    about: "Photoshop 1.0 shipped in 1990, and consumer digital cameras followed within a few years. The photograph became editable pixels, open to compositing, retouching and invention, which changed what it meant to believe an image.",
    from: 1990, to: 2010, only: ["photography", "media", "graphic"],
    artists: ["christophe-gilbert", "greg-noblin", "ted-chin", "ed-freeman", "moteh-aka-morten-lasskogen", "alexey-kondakov",
              "wu-tien-chang", "anthony-thiebaux", "catrin-welz-stein", "richard-tuschman", "jing-zhang"] },

  // 2000 onwards
  { year: 2007, label: "The camera phone", note: "Everyone is a photographer", medium: "photography",
    about: "Phones had carried cameras since around 2000, but the iPhone in 2007 put a good camera, a screen to see the picture on and the internet in the same pocket. Within a few years more photographs were being taken each year than in the whole history of film.",
    from: 2007, to: 2016, only: ["photography"] },
  { year: 2010, label: "The feed", note: "Instagram makes images social", medium: "photography",
    about: "Instagram launched in October 2010 and had a million users within weeks. Square crops and filters, then the endless scroll: images were made to be shared and seen at once, and artists began to find audiences, and buyers, there directly.",
    from: 2010, to: 2026, only: ["photography"] },
  { year: 2021, label: "NFTs", note: "Digital works bought and sold", medium: "media",
    about: "In March 2021 Beeple's Everydays: The First 5000 Days sold at Christie's for $69 million as an NFT, a token on a blockchain that records who owns a digital file. A boom in crypto art followed, and then a steep fall from 2022.",
    from: 2020, to: 2026, artists: ["vratislav-pecka"] },
  { year: 2022, label: "Generative images", note: "Pictures made from words", medium: "media",
    about: "In 2022 DALL·E 2, Midjourney and Stable Diffusion put image-making from typed descriptions in anyone's hands. They opened an argument that is still going on, about authorship, artists' work used for training, and what an image made this way is.",
    from: 2021, to: 2026 },
];

export const momentSlug = (ms: Milestone) => ms.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export interface MomentArtist { from: number; to: number; any: boolean; stated: boolean }

/** A moment's artists, each with the years their works count from. */
export function momentArtists(ms: Milestone): Map<string, MomentArtist> {
  return new Map((ms.artists ?? []).map((a) => {
    const stated = a.endsWith("!");
    const [slug, span] = a.replace(/!$/, "").split("@");
    const any = span === "any";
    const [from, to] = span && !any ? span.split("-").map(Number) : [ms.from, ms.to];
    return [slug, { from, to, any, stated }];
  }));
}

/** The archive's works that bear a moment out, nearest its year first: by its artists
 *  within their years, or from its theme posts within its own, in its media, dated
 *  closely enough to be sure of, and not among the works checked and left out. */
export function momentWorks(ms: Milestone, rows: ArtworkRow[], posts: Post[], media: string[]): ArtworkRow[] {
  const only = ms.only ? new Set(ms.only.map((k) => media.indexOf(k))) : null;
  const artists = momentArtists(ms);
  const themes = new Set(ms.posts ?? []);
  const left = new Set(MOMENT_EXCLUSIONS[momentSlug(ms)] ?? []);
  const out: ArtworkRow[] = [];
  for (const r of rows) {
    const y = yearOf(r);
    if (y == null || r[7] == null || isCopy(r) || (only && !only.has(r[7])) || left.has(r[1])) continue;
    const post = posts[r[0]];
    const a = post.artist ? artists.get(post.artist) : undefined;
    if (a?.any) { out.push(r); continue; }
    const kind = kindOf(r);
    if (kind !== DATED && (kind !== CLOSE || a?.stated)) continue;
    const [from, to] = a ? [a.from, a.to] : themes.has(post.id) ? [ms.from, ms.to] : [NaN, NaN];
    if (y >= from && y <= to) out.push(r);
  }
  return out.sort((a, b) => Math.abs(yearOf(a)! - ms.year) - Math.abs(yearOf(b)! - ms.year));
}
