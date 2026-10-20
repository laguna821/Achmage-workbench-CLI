import type { Script } from './model'

/**
 * Scripts that once failed, shrunk to the steps that matter (fuzz.test.ts replays every one of them). A script stays here
 * after its bug is fixed: it is the proof that the bug does not come back.
 */
export const UNDO_AFTER_REMOVAL: Script = {
  doc: 7119,
  peers: 3,
  steps: [
    { p: 1, k: 'join', a: 0, b: 2, c: 289385, d: 28205, n: 5, dt: 29 },
    { p: 1, k: 'op', op: 'move', a: 0, b: 2, c: 953498, d: 429679, n: 14, dt: 28 },
    { p: 2, k: 'join', a: 6914, b: 892141, c: 415348, d: 712534, n: 22, dt: 39 },
    { p: 2, k: 'op', op: 'pageRemove', a: 2, b: 2, c: 259345, d: 447019, n: 48, dt: 3 },
    { p: 1, k: 'op', op: 'pageRemove', a: 363298, b: 366644, c: 810189, d: 46320, n: 75, dt: 18 },
    { p: 2, k: 'undo', a: 2, b: 0, c: 935181, d: 111371, n: 76, dt: 9 },
    { p: 1, k: 'undo', a: 652893, b: 880632, c: 451724, d: 469576, n: 77, dt: 49 },
    { p: 1, k: 'op', op: 'opacity', a: 0, b: 1, c: 646198, d: 690824, n: 78, dt: 23 },
    { p: 1, k: 'undo', a: 0, b: 1, c: 604993, d: 625950, n: 81, dt: 16 },
    { p: 2, k: 'send', a: 287851, b: 942761, c: 993295, d: 346465, n: 82, dt: 26 },
    { p: 1, k: 'op', op: 'duplicate', a: 507469, b: 723914, c: 123884, d: 623139, n: 84, dt: 15 },
    { p: 1, k: 'undo', a: 297516, b: 573628, c: 691105, d: 392547, n: 89, dt: 5 },
    { p: 1, k: 'recv', a: 2, b: 0, c: 717355, d: 340552, n: 114, dt: 42 },
    { p: 1, k: 'undo', a: 2, b: 1, c: 374927, d: 816118, n: 115, dt: 2 },
  ],
}

export const REGRESSIONS: readonly { name: string; script: Script }[] = [
  {
    // One person undoes adding a page while another removes the first: no page was left, the editors kept showing a design
    // that no longer existed, and the server could not save it.
    name: 'every page removed at once',
    script: {
      doc: 7002,
      peers: 3,
      steps: [
        { p: 0, k: 'join', a: 1, b: 2, c: 694217, d: 467606, n: 1, dt: 2082 },
        { p: 1, k: 'join', a: 402991, b: 66062, c: 821212, d: 62895, n: 7, dt: 54 },
        { p: 0, k: 'op', op: 'pageAdd', a: 611056, b: 499445, c: 251533, d: 772799, n: 35, dt: 22 },
        { p: 0, k: 'send', a: 129552, b: 809636, c: 836458, d: 781117, n: 58, dt: 1 },
        { p: 1, k: 'recv', a: 100905, b: 431712, c: 800574, d: 845712, n: 60, dt: 14 },
        { p: 1, k: 'undo', a: 1, b: 0, c: 647348, d: 429344, n: 61, dt: 40 },
        { p: 0, k: 'undo', a: 748293, b: 919256, c: 509401, d: 745837, n: 62, dt: 36 },
        { p: 1, k: 'op', op: 'pageRemove', a: 2, b: 0, c: 645751, d: 17551, n: 79, dt: 33 },
      ],
    },
  },
  {
    // Somebody deletes a shape and brings it back with undo while another locks it: the restored shape is a new entry, and
    // the editor that had locked it kept showing its own old copy.
    name: 'a shape restored by undo replaces the editor\'s stale copy',
    script: {
      doc: 2,
      peers: 4,
      steps: [
        { p: 0, k: 'join', a: 521471, b: 260040, c: 328623, d: 452099, n: 1, dt: 23 },
        { p: 0, k: 'op', op: 'delete', a: 361031, b: 433610, c: 168164, d: 514349, n: 8, dt: 45 },
        { p: 0, k: 'undo', a: 10957, b: 92425, c: 490723, d: 843127, n: 52, dt: 47 },
        { p: 1, k: 'op', op: 'lock', a: 379937, b: 442472, c: 556922, d: 883114, n: 59, dt: 56 },
      ],
    },
  },
  {
    // Pages removed and brought back by undo, then removed again by the other side: Yjs' undo manager threw in the middle of
    // an undo once the restored page had been garbage collected (the shared document therefore keeps deleted content).
    name: 'undo after a restored page was removed by somebody else',
    script: UNDO_AFTER_REMOVAL,
  },
  {
    // Two people resize the first page at once and the one whose size won undoes it: Yjs would not bring the old size back over
    // the other person's write and removed the winning one, so the design had no width and height for anybody.
    name: 'undo of a property both people set at once',
    script: {
      doc: 8269,
      peers: 3,
      steps: [
        { p: 0, k: 'join', a: 519202, b: 653604, c: 532057, d: 642950, n: 1, dt: 40 },
        { p: 0, k: 'op', op: 'pageRemove', a: 0, b: 1, c: 860489, d: 475070, n: 9, dt: 5 },
        { p: 2, k: 'op', op: 'pageRemove', a: 2, b: 0, c: 874203, d: 73775, n: 17, dt: 38 },
        { p: 2, k: 'join', a: 1, b: 1, c: 63028, d: 917568, n: 41, dt: 2179 },
        { p: 0, k: 'send', a: 2, b: 0, c: 99157, d: 829193, n: 96, dt: 16 },
        { p: 2, k: 'op', op: 'pageRemove', a: 292688, b: 839428, c: 539035, d: 570387, n: 104, dt: 5 },
        { p: 2, k: 'recv', a: 1, b: 0, c: 842427, d: 262949, n: 107, dt: 1705 },
        { p: 2, k: 'undo', a: 1, b: 2, c: 704409, d: 453108, n: 109, dt: 40 },
      ],
    },
  },
  {
    // Undoing the removal of a page rebuilt its objects in an order that only the editor that undid it agreed with: one entry was
    // put after the same item on both sides, and every other replica placed it before.
    name: 'undo of a removed page after the objects on it were moved and duplicated',
    script: {
      doc: 14109,
      peers: 3,
      steps: [
        { p: 2, k: 'op', op: 'delete', a: 671782, b: 202018, c: 739585, d: 254001, n: 32, dt: 22 },
        { p: 2, k: 'join', a: 1, b: 0, c: 258369, d: 391067, n: 34, dt: 52 },
        { p: 2, k: 'undo', a: 1, b: 1, c: 173115, d: 787261, n: 53, dt: 23 },
        { p: 2, k: 'op', op: 'zorder', a: 629948, b: 327020, c: 743977, d: 763923, n: 59, dt: 20 },
        { p: 2, k: 'undo', a: 0, b: 0, c: 626555, d: 783480, n: 67, dt: 1338 },
        { p: 2, k: 'op', op: 'duplicate', a: 504912, b: 356281, c: 390846, d: 814272, n: 68, dt: 13 },
        { p: 2, k: 'op', op: 'pageRemove', a: 0, b: 0, c: 779086, d: 649563, n: 73, dt: 48 },
        { p: 2, k: 'undo', a: 56664, b: 858952, c: 198186, d: 689030, n: 81, dt: 58 },
      ],
    },
  },
  {
    // An update that arrives before the one it builds on leaves the shared state, for a moment, without a usable design. The editor
    // read nothing then and forgot what had changed, so a property that arrived in that update never showed.
    name: 'a change that arrived while the shared state was not a design yet',
    script: {
      doc: 10160,
      peers: 4,
      steps: [
        { p: 2, k: 'join', a: 2, b: 2, c: 233594, d: 664109, n: 2, dt: 52 },
        { p: 1, k: 'op', op: 'textStyle', a: 2, b: 1, c: 714222, d: 769793, n: 6, dt: 30 },
        { p: 1, k: 'join', a: 2, b: 2, c: 665269, d: 324351, n: 7, dt: 43 },
        { p: 1, k: 'op', op: 'effects', a: 0, b: 0, c: 447767, d: 274279, n: 60, dt: 4 },
        { p: 1, k: 'op', op: 'insertImage', a: 2, b: 1, c: 885456, d: 217138, n: 65, dt: 27 },
        { p: 1, k: 'op', op: 'duplicate', a: 1, b: 0, c: 976898, d: 281858, n: 87, dt: 46 },
        { p: 1, k: 'send', a: 2, b: 0, c: 7396, d: 473596, n: 96, dt: 11 },
        { p: 1, k: 'op', op: 'resizeDesign', a: 952833, b: 567269, c: 936637, d: 106505, n: 104, dt: 5 },
        { p: 1, k: 'send', a: 99572, b: 950173, c: 122817, d: 133719, n: 105, dt: 59 },
        { p: 2, k: 'swap', a: 459551, b: 962884, c: 308705, d: 40363, n: 110, dt: 22 },
        { p: 2, k: 'recv', a: 2, b: 0, c: 880375, d: 962516, n: 117, dt: 29 },
        { p: 2, k: 'redo', a: 1, b: 1, c: 431065, d: 632068, n: 121, dt: 7 },
      ],
    },
  },
]
