// Works the Century page's moments leave out although their artist or theme post is
// tied to the moment: checked by eye (2026-11-11) and found not to be of it. Portraits
// and photographs of the artist, later or modern pieces given early dates, tributes
// and reproductions, and works by someone else. Keyed by momentSlug, then file name.

export const MOMENT_EXCLUSIONS: Record<string, string[]> = {
  "romanticism": [
    "000_c349c1e8aa.jpg", "001_717caa2b8d.jpg", "002_7bacdb16c2.jpg",
  ],
  "impressionism": [
    "002_3f06543014.jpg",
  ],
  "the-art-poster": [
    "058_7f7b7a9744.jpg", "036_dc983e0c83.jpg", "037_efa5c94f33.jpg", "028_f1c520c63c.jpg",
    "017_910b35ee9f.jpg", "022_dcfb25a121.jpg", "023_e8e469c915.jpg", "010_35d1978b43.jpg",
    "013_398110fc2d.jpg", "016_6a614085c0.jpg", "017_29bf09b22b.jpg", "018_ef3750f11f.jpg",
    "047_0f91cb6788.jpg", "009_9f68f795ce.jpg",
  ],
  "cinema": [
    "002_e3f1720e6a.jpg", "008_2014b6cc5e.jpg", "012_8e6319d81e.jpg", "014_be349f9f9a.jpg",
    "017_5ba9928cfa.jpg", "019_b3971c9b16.jpg", "020_c403acb7a5.jpg", "021_1d028b4ecb.jpg",
    "022_1d12b7c1cd.jpg", "023_7d8a058f7c.jpg", "024_993333e498.jpg",
    "002_2d23853c33.jpg", "012_f4a573420f.jpg", "015_4400f78c04.jpg", "025_abbfc24a0f.jpg",
    "031_54e887ab2a.jpg", "002_c630ffb765.jpg", "003_ea2f706186.jpg", "011_cc2eea2e8b.jpg",
    "012_da59a6f750.jpg",
  ],
  "cubism": [
    "040_d1514e2d64.jpg", "017_527cdaa3e3.jpg",
  ],
  "dada": [
    "010_767d4891b5.jpg", "011_cc90c635ff.jpg", "012_3ca7ab66c7.jpg", "013_a5fdabb46c.jpg",
    "014_60d5612dc2.jpg", "015_21aa1e2082.jpg", "017_6c63b29cd3.jpg", "018_411fbdb064.jpg",
    "020_fd69c06194.jpg", "021_969206b3da.jpg", "023_8327a3c169.jpg", "024_1ca7a76f80.jpg",
    "027_23c05e2561.jpg", "030_1d169875a7.jpg", "031_47a44d6b51.jpg", "032_82c5921279.jpg",
    "033_4799c34c5b.jpg", "034_e159acd697.jpg", "035_ecb175b4a9.jpg", "036_a23eb33ab9.jpg",
    "037_07b5af8435.jpg", "039_d78d5b0003.jpg", "044_e22138f90e.jpg", "046_8c8dc9abe7.jpg",
    "047_649e37cfb0.jpg", "002_5051c4720a.jpg", "053_f7a6370dde.jpg", "054_bec6d0f2ed.jpg",
    "055_950a0d98be.jpg", "056_f4f4bf08ed.jpg", "057_e3bc2b6475.jpg", "059_f41e9411ce.jpg",
    "006_2f36b08c18.jpg",
  ],
  "the-bauhaus": [
    "007_7984d4960d.jpg", "010_de7eebb876.jpg", "012_5c803f172a.jpg", "013_eb4ca9acbb.jpg",
    "014_2b82a63bab.jpg", "003_5def869577.jpg", "028_781c81a785.jpg", "031_8325393486.jpg",
    "032_afaea18930.jpg", "002_7bebe8aaab.jpg",
  ],
  "surrealism": [
    "002_241399646f.jpg", "002_943221b72a.jpg", "003_8ef8ef543a.jpg", "004_bae5968f1b.jpg",
    "003_9d552658e5.jpg", "002_4ce3603601.jpg", "002_f000ecdd29.jpg", "048_e805a0e033.jpg",
  ],
  "art-deco": [
    "024_ae4c8beea1.jpg", "005_3cd4cb3afe.jpg", "007_26f41a8c56.jpg", "008_47869f8c2e.jpg",
    "020_a00cc4951c.jpg", "021_ceca512f4e.jpg", "003_ed804ab0e6.jpg", "011_63205a00db.jpg",
    "002_bba6f8f95a.jpg", "030_223e3e6690.jpg", "031_8dbf170932.jpg", "017_b073da2f2b.jpg",
  ],
  "abstract-expressionism": [
    "002_5ba3864657.jpg", "003_68fabcdfbb.jpg", "017_8989edc214.jpg", "018_ad4db4de41.jpg",
    "010_c211bd942e.jpg", "000_7a03bb95a3.jpg",
  ],
  "the-swiss-style": [
    "002_15225f2e55.jpg", "004_38b4f08137.jpg", "005_157fd66e8f.jpg", "015_4d8cae1713.jpg",
    "021_26bae8e1ba.jpg", "003_44b5b2ff24.jpg", "022_4705870e63.jpg", "023_ba8424596d.jpg",
    "026_160a43e3bf.jpg", "027_1f8729da88.jpg", "030_755a44dca2.jpg", "036_d13bb24101.jpg",
    "037_27b202555c.jpg", "039_100ae0e3e7.jpg", "040_4593450e51.jpg", "042_976dac53bd.jpg",
    "043_07fe3cab32.jpg", "044_89e85fca25.jpg", "003_674d9ca0c0.jpg", "004_16381a51fa.jpg",
    "005_ba46b9c02e.jpg", "011_e740d21d0a.jpg", "019_8cb2fbdf18.jpg", "020_28df19c9a6.jpg",
    "021_9a774cb0a1.jpg", "022_ae13a908c6.jpg", "032_15313432ce.jpg", "038_036bcf5e29.jpg",
    "018_7bd79c5130.jpg", "042_b8cd538581.jpg", "004_4273b54185.jpg", "006_1572f9dfce.jpg",
    "016_a9c9bf679e.jpg", "017_f432c701c5.jpg", "000_7bada72b27.jpg",
  ],
  "pop-art": [
    "033_91f881436f.jpg", "034_202fcf611d.jpg", "035_ad164a1c26.jpg", "038_b4343856c4.jpg",
    "044_f29ff18f9f.jpg", "045_718b7fdd8e.jpg", "046_293c6a666d.jpg", "047_cb19c3c79f.jpg",
    "050_6ec3e4057a.jpg", "053_c585ab9e33.jpg", "054_ef0b04083a.jpg", "059_0e89f661f3.jpg",
    "061_09adc96391.jpg", "042_0e564e2642.jpg", "019_df75073880.jpg", "020_6560b4494d.jpg",
    "022_6617b8f896.jpg", "024_aa39fa5d84.jpg", "017_5dbd4acd68.jpg", "018_2a05cdba12.jpg",
    "023_ddebf99bcb.jpg", "002_133679ef4e.jpg", "000_f3190e9b39.jpg",
  ],
  "video-and-installation": [
    "002_ff82098449.jpg", "026_246576790b.jpg", "027_dc5bc2bdf6.jpg", "009_49e5a411f7.jpg",
    "006_90288d9f4e.jpg", "008_10fe39256e.jpg", "007_d85fb14f6b.jpg", "002_6abd0792a5.jpg",
    "018_7c431bccb8.jpg", "030_afcade555c.jpg", "000_97f0499540.jpg",
  ],
  "desktop-publishing": [
    "002_60bfaed57b.jpg", "003_163248fec2.jpg", "030_b2152fdf13.jpg", "016_05343fc4c5.jpg",
    "017_47bc22a5d0.jpg", "018_665cb10b6b.jpg", "020_edfd3d7b9a.jpg", "007_7ba459d558.jpg",
    "009_0f98431695.jpg", "012_5375c36e39.jpg", "013_b904c048b9.jpg", "017_871de4a746.jpg",
    "018_52ce6bf696.jpg", "019_997cb45022.jpg", "020_65c8390ccc.jpg", "021_1945e0c9b2.jpg",
    "023_aa5174b318.jpg", "024_9eb2f87b2d.jpg", "029_400464a66d.jpg",
  ],
  "the-photo-essay": [
    "003_7017e386f9.jpg", "002_15220f4efa.jpg", "000_a66ebfefa5.jpg", "001_7651889049.jpg",
    "002_603e96c1b3.jpg", "002_d983ac379e.png",
  ],
};
