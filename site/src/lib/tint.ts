// Zoom tint, shared by the Explore renderers: when tiles are tiny, blend each one
// towards a smooth target colour so a shape reads as a clean gradient from afar;
// the blend fades out as you zoom in, until each tile is purely its artwork.

/** Blend amount for tiles drawn `px` CSS pixels wide: 65% at ~4px, gone by 24px. */
export const tintAmount = (px: number) => 0.65 * Math.min(1, Math.max(0, (24 - px) / 20));
