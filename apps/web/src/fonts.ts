import { FONT_FAMILY, Fonts } from "@excalidraw/excalidraw";

/**
 * The app replaces three Excalidraw fonts with fonts that have all Vietnamese letters.
 * The scene keeps the Excalidraw font numbers. Ascender and descender are from the hhea
 * table of each file (units per em: 1000).
 */
const APP_FONTS = [
  {
    family: "Excalifont",
    file: "DFVN-Excalifont-Regular.woff2",
    ascender: 886,
    descender: -374,
  },
  { family: "Nunito", file: "Geist-Regular.woff2", ascender: 1005, descender: -295 },
  { family: "Comic Shanns", file: "GeistMono-Regular.woff2", ascender: 1005, descender: -295 },
] as const;

type FontMetadata = (typeof Fonts.registered extends Map<number, infer V> ? V : never)["metadata"];
// `Fonts.register` is private in the types of the pinned build.
const register = (
  Fonts as unknown as {
    register(family: string, metadata: FontMetadata, ...faces: { uri: string }[]): void;
  }
).register.bind(Fonts);

let ready: Promise<void> | undefined;

/** Registers the fonts and loads them, so the editor measures text with the right font. */
export function setupFonts(): Promise<void> {
  ready ??= (async () => {
    for (const font of APP_FONTS) {
      const id = FONT_FAMILY[font.family];
      const { metadata } = Fonts.registered.get(id)!;
      // `register` does nothing for a family that is already registered.
      Fonts.registered.delete(id);
      register(
        font.family,
        {
          ...metadata,
          metrics: {
            ...metadata.metrics,
            unitsPerEm: 1000,
            ascender: font.ascender,
            descender: font.descender,
          },
        },
        { uri: new URL(`/fonts/${font.file}`, location.origin).href },
      );
    }
    await Promise.all(
      APP_FONTS.map((font) => {
        const face = new FontFace(font.family, `url(/fonts/${font.file})`);
        document.fonts.add(face);
        return face.load();
      }),
    );
  })();
  return ready;
}
