/**
 * wallpaper-palette.js
 * 96-slot temporal color palette — one slot per 15-min frame of GOOD DESKTOP JAN 2026.heic
 *
 * bg colors: sampled directly from HEIC frames via heic-sampler (CGImageSource, no averaging)
 * detail colors: most chromatic color extracted per frame via ImageMagick quantize (no dithering)
 * All other roles: derived from bg luminance with hard dark/light switch at L=0.35
 *
 * Columns: [bg, white, eggshell, ink, stone, muted, dim, rule, rule2, detail]
 * Roles:
 *   bg       — page background (direct from HEIC frame sky)
 *   white    — card / input surface
 *   eggshell — secondary surface
 *   ink      — primary text (always high contrast)
 *   stone    — secondary text / default borders
 *   muted    — tertiary text
 *   dim      — faint / barely-visible text
 *   rule     — border line
 *   rule2    — secondary border
 *   detail   — the characteristic accent of this time of day:
 *              00:00–01:00  near-black (deep night)
 *              01:15–05:00  cool indigo-purple (pre-dawn)
 *              05:15–06:45  warm terracotta (sunrise)
 *              07:30–09:00  warm olive-sage (morning landscape)
 *              09:15–12:00  golden amber (noon light)
 *              12:15–14:15  amber-terracotta (afternoon)
 *              14:30–16:45  warm brown-rose (late afternoon)
 *              17:00–19:15  dusty mauve (dusk)
 *              19:30–22:45  cool purple-plum (twilight into night)
 *              23:00–23:45  near-black (deep night)
 *
 * Dark mode  (lum < 0.35): slots 00–27 (00:00–06:45) and 69–95 (17:15–23:45)
 * Light mode (lum ≥ 0.35): slots 28–68 (07:00–17:00)
 *
 * Usage:
 *   import { applyWallpaperTheme, scheduleThemeUpdates } from './wallpaper-palette.js';
 *   applyWallpaperTheme();    // apply immediately on load
 *   scheduleThemeUpdates();   // auto-update at each 15-min boundary
 */

const KEYS = ['bg','white','eggshell','ink','stone','muted','dim','rule','rule2','detail'];

// 96 entries × 10 semantic colors, midnight → 23:45
const P = [
  ['#161519','#262529','#1e1d21','#dedad7','#9b9896','#6e6b69','#504e4c','#1e1d21','#232226','#1e1d21'], // 00  00:00  dark  deep night
  ['#161519','#262529','#1e1d21','#dedad7','#9b9896','#6e6b69','#504e4c','#1e1d21','#232226','#1e1d22'], // 01  00:15  dark  deep night
  ['#161519','#262529','#1e1d21','#dedad7','#9b9896','#6e6b69','#504e4c','#1e1d21','#232226','#1d1d22'], // 02  00:30  dark  deep night
  ['#18171b','#28272b','#201f23','#dedad7','#9b9896','#6e6b69','#504e4c','#201f23','#252428','#1e1d22'], // 03  00:45  dark  deep night
  ['#19181c','#29282c','#212024','#dedad7','#9b9896','#6e6b69','#504e4c','#212024','#262529','#1d1d21'], // 04  01:00  dark  deep night
  ['#1c1c1e','#2c2c2e','#242426','#dedad7','#9b9896','#6e6b69','#504e4c','#242426','#29292b','#4c4a55'], // 05  01:15  dark  pre-dawn indigo
  ['#1e1d21','#2e2d31','#262529','#dedad7','#9b9896','#6e6b69','#504e4c','#262529','#2b2a2e','#4c4a56'], // 06  01:30  dark  pre-dawn indigo
  ['#222224','#323234','#2a2a2c','#dedad7','#9b9896','#6e6b69','#504e4c','#2a2a2c','#2f2f31','#4f4b58'], // 07  01:45  dark  pre-dawn indigo
  ['#252527','#353537','#2d2d2f','#dedad7','#9b9896','#6e6b69','#504e4c','#2d2d2f','#323234','#504c5a'], // 08  02:00  dark  pre-dawn indigo
  ['#29292b','#39393b','#313133','#dedad7','#9b9896','#6e6b69','#504e4c','#313133','#363638','#534c5c'], // 09  02:15  dark  pre-dawn indigo
  ['#2e2e30','#3e3e40','#363638','#dedad7','#9b9896','#6e6b69','#504e4c','#363638','#3b3b3d','#554f5c'], // 10  02:30  dark  pre-dawn indigo
  ['#323234','#424244','#3a3a3c','#dedad7','#9b9896','#6e6b69','#504e4c','#3a3a3c','#3f3f41','#595360'], // 11  02:45  dark  pre-dawn indigo
  ['#38383a','#48484a','#404042','#dedad7','#9b9896','#6e6b69','#504e4c','#404042','#454547','#5a5260'], // 12  03:00  dark  pre-dawn indigo
  ['#3d3d3f','#4d4d4f','#454547','#dedad7','#9b9896','#6e6b69','#504e4c','#454547','#4a4a4c','#5b5361'], // 13  03:15  dark  pre-dawn indigo
  ['#434345','#535355','#4b4b4d','#dedad7','#9b9896','#6e6b69','#504e4c','#4b4b4d','#505052','#5c5462'], // 14  03:30  dark  pre-dawn indigo
  ['#49494b','#59595b','#515153','#dedad7','#9b9896','#6e6b69','#504e4c','#515153','#565658','#615766'], // 15  03:45  dark  pre-dawn indigo
  ['#4f4f4f','#5f5f5f','#575757','#dedad7','#9b9896','#6e6b69','#504e4c','#575757','#5c5c5c','#625867'], // 16  04:00  dark  pre-dawn indigo
  ['#565658','#666668','#5e5e60','#dedad7','#9b9896','#6e6b69','#504e4c','#5e5e60','#636365','#655c69'], // 17  04:15  dark  pre-dawn indigo
  ['#5c5c5c','#6c6c6c','#646464','#dedad7','#9b9896','#6e6b69','#504e4c','#646464','#696969','#665d6a'], // 18  04:30  dark  pre-dawn indigo
  ['#656364','#757374','#6d6b6c','#dedad7','#9b9896','#6e6b69','#504e4c','#6d6b6c','#727071','#675e6b'], // 19  04:45  dark  pre-dawn indigo
  ['#6c6a6b','#7c7a7b','#747273','#dedad7','#9b9896','#6e6b69','#504e4c','#747273','#797778','#685f6c'], // 20  05:00  dark  pre-dawn indigo
  ['#737172','#838182','#7b797a','#dedad7','#9b9896','#6e6b69','#504e4c','#7b797a','#807e7f','#c9998f'], // 21  05:15  dark  sunrise terracotta
  ['#7b797a','#8b898a','#838182','#dedad7','#9b9896','#6e6b69','#504e4c','#838182','#888687','#c9998f'], // 22  05:30  dark  sunrise terracotta
  ['#828081','#929091','#8a8889','#dedad7','#9b9896','#6e6b69','#504e4c','#8a8889','#8f8d8e','#e8dfdb'], // 23  05:45  dark  sunrise warm
  ['#8a8987','#9a9997','#92918f','#dedad7','#9b9896','#6e6b69','#504e4c','#92918f','#979694','#c9998f'], // 24  06:00  dark  sunrise terracotta
  ['#91908e','#a1a09e','#999896','#dedad7','#9b9896','#6e6b69','#504e4c','#999896','#9e9d9b','#c9998f'], // 25  06:15  dark  sunrise terracotta
  ['#999896','#a9a8a6','#a1a09e','#dedad7','#9b9896','#6e6b69','#504e4c','#a1a09e','#a6a5a3','#c9998f'], // 26  06:30  dark  sunrise terracotta
  ['#a09f9d','#b0afad','#a8a7a5','#dedad7','#9b9896','#6e6b69','#504e4c','#a8a7a5','#adacaa','#c9998f'], // 27  06:45  dark  sunrise terracotta
  ['#a7a6a4','#afaeac','#a79f9d','#1f0812','#545e56','#917c78','#c0b8b5','#9b9a98','#a09f9d','#c9998f'], // 28  07:00  light ← mode switch
  ['#aeadab','#b6b5b3','#a6a5a3','#1f0812','#545e56','#917c78','#c0b8b5','#a2a19f','#a7a6a4','#c9998f'], // 29  07:15  light morning warm
  ['#b6b5b3','#bebdbb','#aeadab','#1f0812','#545e56','#917c78','#c0b8b5','#aaa9a7','#afaeac','#a1a18f'], // 30  07:30  light morning olive
  ['#bfbbba','#c7c3c2','#b7b5b3','#1f0812','#545e56','#917c78','#c0b8b5','#b3afae','#b8b4b3','#a4a390'], // 31  07:45  light morning olive
  ['#c3c2c0','#cbcac8','#bbbab8','#1f0812','#545e56','#917c78','#c0b8b5','#b7b6b4','#bcbbb9','#aaa68e'], // 32  08:00  light morning olive
  ['#ccc8c7','#d4d0cf','#c4c0bf','#1f0812','#545e56','#917c78','#c0b8b5','#c0bcbb','#c5c1c0','#aca88c'], // 33  08:15  light morning olive
  ['#d0cfcb','#d8d7d3','#c8c7c3','#1f0812','#545e56','#917c78','#c0b8b5','#c4c3bf','#c9c8c4','#b0aa8b'], // 34  08:30  light morning olive
  ['#d8d4d3','#e0dcdb','#d0cecd','#1f0812','#545e56','#917c78','#c0b8b5','#ccc8c7','#d1cdcc','#b4ad87'], // 35  08:45  light morning olive
  ['#dbdad6','#e3e2de','#d3d2ce','#1f0812','#545e56','#917c78','#c0b8b5','#cfceca','#d4d3cf','#b5b087'], // 36  09:00  light morning olive
  ['#e3dfdc','#ebe7e4','#dbd9d6','#1f0812','#545e56','#917c78','#c0b8b5','#d7d3d0','#dcd8d5','#c1b88c'], // 37  09:15  light golden
  ['#e5e4e0','#edece8','#dddcd8','#1f0812','#545e56','#917c78','#c0b8b5','#d9d8d4','#deddd9','#bdb37d'], // 38  09:30  light golden
  ['#ece8e5','#f4f0ed','#e4e2df','#1f0812','#545e56','#917c78','#c0b8b5','#e0dcd9','#e5e1de','#a7a17e'], // 39  09:45  light golden
  ['#f0ece9','#f8f4f1','#e8e6e3','#1f0812','#545e56','#917c78','#c0b8b5','#e4e0dd','#e9e5e2','#ccbd78'], // 40  10:00  light golden noon
  ['#f1f0ec','#f9f8f4','#e9e8e4','#1f0812','#545e56','#917c78','#c0b8b5','#e5e4e0','#eae9e5','#cfbf7c'], // 41  10:15  light golden noon
  ['#f6f2ef','#fefaf7','#eeecea','#1f0812','#545e56','#917c78','#c0b8b5','#eae6e3','#efebe8','#c6b77f'], // 42  10:30  light golden noon
  ['#f9f5f2','#fffdfa','#f1efed','#1f0812','#545e56','#917c78','#c0b8b5','#ede9e6','#f2eeeb','#c1b27f'], // 43  10:45  light golden noon
  ['#fbf7f4','#fffffc','#f3f1ef','#1f0812','#545e56','#917c78','#c0b8b5','#efebe8','#f4f0ed','#c0b27f'], // 44  11:00  light golden noon
  ['#fcf8f5','#fffffd','#f4f2f0','#1f0812','#545e56','#917c78','#c0b8b5','#f0ece9','#f5f1ee','#c5b37f'], // 45  11:15  light golden noon
  ['#fefaf7','#ffffff','#f6f4f2','#1f0812','#545e56','#917c78','#c0b8b5','#f2eeeb','#f7f3f0','#d5b87c'], // 46  11:30  light golden noon
  ['#fefaf7','#ffffff','#f6f4f2','#1f0812','#545e56','#917c78','#c0b8b5','#f2eeeb','#f7f3f0','#d3b177'], // 47  11:45  light golden noon
  ['#fffbf8','#ffffff','#f7f5f3','#1f0812','#545e56','#917c78','#c0b8b5','#f3efec','#f8f4f1','#d1ac72'], // 48  12:00  light ← noon peak golden
  ['#fefaf7','#ffffff','#f6f4f2','#1f0812','#545e56','#917c78','#c0b8b5','#f2eeeb','#f7f3f0','#cea56d'], // 49  12:15  light amber
  ['#fefaf7','#ffffff','#f6f4f2','#1f0812','#545e56','#917c78','#c0b8b5','#f2eeeb','#f7f3f0','#cb9f69'], // 50  12:30  light amber
  ['#fcf8f5','#fffffd','#f4f2f0','#1f0812','#545e56','#917c78','#c0b8b5','#f0ece9','#f5f1ee','#c79864'], // 51  12:45  light amber
  ['#fbf7f4','#fffffc','#f3f1ef','#1f0812','#545e56','#917c78','#c0b8b5','#efebe8','#f4f0ed','#c5915f'], // 52  13:00  light amber
  ['#f9f5f2','#fffdfa','#f1efed','#1f0812','#545e56','#917c78','#c0b8b5','#ede9e6','#f2eeeb','#c28b5c'], // 53  13:15  light amber-terracotta
  ['#f6f2ef','#fefaf7','#eeecea','#1f0812','#545e56','#917c78','#c0b8b5','#eae6e3','#efebe8','#be865b'], // 54  13:30  light amber-terracotta
  ['#f1f0ec','#f9f8f4','#e9e8e4','#1f0812','#545e56','#917c78','#c0b8b5','#e5e4e0','#eae9e5','#bb7f59'], // 55  13:45  light amber-terracotta
  ['#f0ece9','#f8f4f1','#e8e6e3','#1f0812','#545e56','#917c78','#c0b8b5','#e4e0dd','#e9e5e2','#b87956'], // 56  14:00  light amber-terracotta
  ['#ece8e5','#f4f0ed','#e4e2df','#1f0812','#545e56','#917c78','#c0b8b5','#e0dcd9','#e5e1de','#b47555'], // 57  14:15  light terracotta-rose
  ['#e5e4e0','#edece8','#dddcd8','#1f0812','#545e56','#917c78','#c0b8b5','#d9d8d4','#deddd9','#ac755a'], // 58  14:30  light terracotta-rose
  ['#e3dfdc','#ebe7e4','#dbd9d6','#1f0812','#545e56','#917c78','#c0b8b5','#d7d3d0','#dcd8d5','#a8725a'], // 59  14:45  light terracotta-rose
  ['#dbdad6','#e3e2de','#d3d2ce','#1f0812','#545e56','#917c78','#c0b8b5','#cfceca','#d4d3cf','#ab6953'], // 60  15:00  light terracotta-rose
  ['#d8d4d3','#e0dcdb','#d0cecd','#1f0812','#545e56','#917c78','#c0b8b5','#ccc8c7','#d1cdcc','#a76553'], // 61  15:15  light terracotta-rose
  ['#d0cfcb','#d8d7d3','#c8c7c3','#1f0812','#545e56','#917c78','#c0b8b5','#c4c3bf','#c9c8c4','#a17161'], // 62  15:30  light terracotta-rose
  ['#ccc8c7','#d4d0cf','#c4c0bf','#1f0812','#545e56','#917c78','#c0b8b5','#c0bcbb','#c5c1c0','#9f6457'], // 63  15:45  light warm rose
  ['#c3c2c0','#cbcac8','#bbbab8','#1f0812','#545e56','#917c78','#c0b8b5','#b7b6b4','#bcbbb9','#9b5e55'], // 64  16:00  light warm rose
  ['#bfbbba','#c7c3c2','#b7b5b3','#1f0812','#545e56','#917c78','#c0b8b5','#b3afae','#b8b4b3','#975a54'], // 65  16:15  light warm rose
  ['#b6b5b3','#bebdbb','#aeadab','#1f0812','#545e56','#917c78','#c0b8b5','#aaa9a7','#afaeac','#925756'], // 66  16:30  light warm rose
  ['#aeadab','#b6b5b3','#a6a5a3','#1f0812','#545e56','#917c78','#c0b8b5','#a2a19f','#a7a6a4','#8e5356'], // 67  16:45  light dusty mauve
  ['#a7a6a4','#afaeac','#a79f9d','#1f0812','#545e56','#917c78','#c0b8b5','#9b9a98','#a09f9d','#895157'], // 68  17:00  light dusty mauve
  ['#a09f9d','#b0afad','#a8a7a5','#dedad7','#9b9896','#6e6b69','#504e4c','#a8a7a5','#adacaa','#834c58'], // 69  17:15  dark  ← mode switch dusty mauve
  ['#999896','#a9a8a6','#a1a09e','#dedad7','#9b9896','#6e6b69','#504e4c','#a1a09e','#a6a5a3','#84585f'], // 70  17:30  dark  dusty mauve
  ['#91908e','#a1a09e','#999896','#dedad7','#9b9896','#6e6b69','#504e4c','#999896','#9e9d9b','#835c62'], // 71  17:45  dark  dusty mauve
  ['#8a8987','#9a9997','#92918f','#dedad7','#9b9896','#6e6b69','#504e4c','#92918f','#979694','#825f64'], // 72  18:00  dark  dusty mauve
  ['#828081','#929091','#8a8889','#dedad7','#9b9896','#6e6b69','#504e4c','#8a8889','#8f8d8e','#805f66'], // 73  18:15  dark  dusty mauve
  ['#7b797a','#8b898a','#838182','#dedad7','#9b9896','#6e6b69','#504e4c','#838182','#888687','#7e5d68'], // 74  18:30  dark  dusty mauve
  ['#737172','#838182','#7b797a','#dedad7','#9b9896','#6e6b69','#504e4c','#7b797a','#807e7f','#795c68'], // 75  18:45  dark  dusty mauve
  ['#6c6a6b','#7c7a7b','#747273','#dedad7','#9b9896','#6e6b69','#504e4c','#747273','#797778','#775b6a'], // 76  19:00  dark  dusty mauve
  ['#656364','#757374','#6d6b6c','#dedad7','#9b9896','#6e6b69','#504e4c','#6d6b6c','#727071','#715969'], // 77  19:15  dark  purple twilight
  ['#5c5c5c','#6c6c6c','#646464','#dedad7','#9b9896','#6e6b69','#504e4c','#646464','#696969','#6e5769'], // 78  19:30  dark  purple twilight
  ['#565658','#666668','#5e5e60','#dedad7','#9b9896','#6e6b69','#504e4c','#5e5e60','#636365','#6a556a'], // 79  19:45  dark  purple twilight
  ['#4f4f4f','#5f5f5f','#575757','#dedad7','#9b9896','#6e6b69','#504e4c','#575757','#5c5c5c','#67546a'], // 80  20:00  dark  purple twilight
  ['#49494b','#59595b','#515153','#dedad7','#9b9896','#6e6b69','#504e4c','#515153','#565658','#645268'], // 81  20:15  dark  purple twilight
  ['#434345','#535355','#4b4b4d','#dedad7','#9b9896','#6e6b69','#504e4c','#4b4b4d','#505052','#5e4f66'], // 82  20:30  dark  purple twilight
  ['#3d3d3f','#4d4d4f','#454547','#dedad7','#9b9896','#6e6b69','#504e4c','#454547','#4a4a4c','#5d4f66'], // 83  20:45  dark  purple twilight
  ['#38383a','#48484a','#404042','#dedad7','#9b9896','#6e6b69','#504e4c','#404042','#454547','#5a4f65'], // 84  21:00  dark  purple twilight
  ['#323234','#424244','#3a3a3c','#dedad7','#9b9896','#6e6b69','#504e4c','#3a3a3c','#3f3f41','#584d63'], // 85  21:15  dark  purple twilight
  ['#2e2e30','#3e3e40','#363638','#dedad7','#9b9896','#6e6b69','#504e4c','#363638','#3b3b3d','#564d60'], // 86  21:30  dark  purple twilight
  ['#29292b','#39393b','#313133','#dedad7','#9b9896','#6e6b69','#504e4c','#313133','#363638','#534a5d'], // 87  21:45  dark  purple twilight
  ['#252527','#353537','#2d2d2f','#dedad7','#9b9896','#6e6b69','#504e4c','#2d2d2f','#323234','#504959'], // 88  22:00  dark  purple twilight
  ['#222224','#323234','#2a2a2c','#dedad7','#9b9896','#6e6b69','#504e4c','#2a2a2c','#2f2f31','#4f4858'], // 89  22:15  dark  purple twilight
  ['#1e1d21','#2e2d31','#262529','#dedad7','#9b9896','#6e6b69','#504e4c','#262529','#2b2a2e','#4c4855'], // 90  22:30  dark  purple twilight
  ['#1c1c1e','#2c2c2e','#242426','#dedad7','#9b9896','#6e6b69','#504e4c','#242426','#29292b','#4b4853'], // 91  22:45  dark  purple twilight
  ['#19181c','#29282c','#212024','#dedad7','#9b9896','#6e6b69','#504e4c','#212024','#262529','#1e1d21'], // 92  23:00  dark  deep night
  ['#18171b','#28272b','#201f23','#dedad7','#9b9896','#6e6b69','#504e4c','#201f23','#252428','#1e1d22'], // 93  23:15  dark  deep night
  ['#161519','#262529','#1e1d21','#dedad7','#9b9896','#6e6b69','#504e4c','#1e1d21','#232226','#1e1d21'], // 94  23:30  dark  deep night
  ['#161519','#262529','#1e1d21','#dedad7','#9b9896','#6e6b69','#504e4c','#1e1d21','#232226','#1d1d22'], // 95  23:45  dark  deep night
];

/** Returns the current 15-min slot index (0–95). */
export function currentSlot() {
  const now = new Date();
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / 15) % 96;
}

/** Apply the current time slot's palette to :root as CSS custom properties. */
export function applyWallpaperTheme() {
  const slot  = currentSlot();
  const p     = P[slot];
  const root  = document.documentElement;

  // Short names: --bg, --white, --eggshell, --ink, --stone, --muted, --dim, --rule, --rule2, --detail
  KEYS.forEach((k, i) => root.style.setProperty(`--${k}`, p[i]));

  // Design-system canonical names
  root.style.setProperty('--color-canvas',     p[0]); // bg
  root.style.setProperty('--color-white',      p[1]); // white
  root.style.setProperty('--color-eggshell',   p[2]); // eggshell
  root.style.setProperty('--color-ink',        p[3]); // ink
  root.style.setProperty('--color-stone',      p[4]); // stone
  root.style.setProperty('--color-slate',      p[5]); // muted (acts as slate)
  root.style.setProperty('--color-taupe',      p[6]); // dim (acts as taupe)
  root.style.setProperty('--color-terracotta', p[9]); // detail (the time-of-day accent)
  root.style.setProperty('--color-rose',       p[9]); // also detail (rose role)

  // Browser theme-color meta tag
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', p[0]);
}

/**
 * Apply immediately, then re-apply at each 15-min clock boundary.
 * Call once on app load — do not call scheduleThemeUpdates() more than once.
 */
export function scheduleThemeUpdates() {
  applyWallpaperTheme();
  (function next() {
    const now = new Date();
    const msToNext = (15 - now.getMinutes() % 15) * 60_000
                   - now.getSeconds() * 1000
                   - now.getMilliseconds();
    setTimeout(() => { applyWallpaperTheme(); next(); }, msToNext);
  })();
}
