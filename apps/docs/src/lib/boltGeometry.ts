/**
 * The Volt bolt, traced from brand/volt-icon.png with potrace so every surface
 * (particle field, outlines, construction overlays) uses the exact brand silhouette.
 * Coordinates are y-down in a 704×1350 box; fill with the even-odd rule to keep the hole.
 */
export const BOLT_W = 704;
export const BOLT_H = 1350;
export const BOLT_PATH =
  "M505.8 7C499.4 11.3 500.4 10 421 110.5C382.3 159.4 278.4 290.8 190.1 402.5C101.8 514.1 27.1 608.9 24.1 613C-9.1 659 0.9 708.8 49 737.4C53.1 739.8 92.3 759.2 136 780.5C185.5 804.6 217.5 820.7 220.8 823.2C234.8 834 243.9 852.5 244 869.9C244 873.5 230.2 977 213.4 1099.9C180.7 1339.2 181 1336.5 185.6 1342.7C186.8 1344.2 188.9 1345.6 190.3 1345.8C197.1 1346.6 203.2 1340.4 236 1299C250.5 1280.6 355.1 1148.3 468.4 1005C581.7 861.7 676.9 741.1 679.8 737C711.7 692.7 703.9 644.9 660 615.8C654.9 612.4 619.2 594.4 570.1 570.5C525.3 548.7 486.5 529.3 483.8 527.4C469.5 516.8 460 498.1 460 480.1C460 476.5 473.6 374.6 490.2 253.6C522.8 15.6 523 13.6 518.4 7.3C515.4 3.3 511.6 3.2 505.8 7ZM376 553.5C465.6 572.9 505.3 676.2 451.1 748.7C403.6 812.3 311.2 815.8 258.7 756C197.9 686.8 233.5 576.2 323.5 554.6C339.3 550.8 361.4 550.4 376 553.5Z";

/**
 * Circle cut through the middle of the bolt, measured from the traced bitmap (centroid and
 * equal-area radius). It sits at the exact centre of the box: the bolt is point-symmetric about it.
 */
export const BOLT_HOLE = { cx: 352, cy: 675, r: 123.8 } as const;

/** Extreme points of the silhouette; the line between them is the bolt's axis (13.18° off vertical). */
export const BOLT_TIP_TOP = { x: 511.6, y: 3.2 } as const;
export const BOLT_TIP_BOTTOM = { x: 197.1, y: 1346.6 } as const;
