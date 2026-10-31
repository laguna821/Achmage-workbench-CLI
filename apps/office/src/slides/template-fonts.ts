import { TEMPLATE_FONTS } from "../../../../vendor/ieumoffice/packages/ui/src/template-fonts.ts";

/** One catalog and one set of bytes for worker metrics, renderer faces and the font folder. */
export const templateFaces = TEMPLATE_FONTS.flatMap(({ family, faces }) => faces.map((face) => ({
  id: `template-${face.file}`, family, bold: face.weight >= 600, italic: false,
  weight: face.variableWeight ? `${face.variableWeight.min} ${face.variableWeight.max}` : String(face.weight),
  url: `/office/template-fonts/${encodeURIComponent(face.file)}`,
})));
