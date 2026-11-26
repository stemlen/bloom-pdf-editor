/**
 * AcroForm engine — field types, appearance synthesis, flattening, detection.
 */

export {
  buildAppearanceStream,
  appearanceToPageContent,
  parseWidgetRect,
  flattenField,
  flattenWidgets,
} from './flatten-field';

export {
  parseAcroFormCatalog,
  detectFormFieldsOnPage,
  listAllFormWidgets,
  hitTestFormField,
} from './detect-fields';

export {
  setFormFieldValue,
  flattenFormFieldsOnPage,
  removeWidgetAnnots,
} from './apply-field';

export {
  setButtonFieldValue,
  setChoiceFieldValue,
  regenerateNeedAppearances,
  runCalculationOrder,
} from './widget-appearances';

export {
  setComplexTextRasterizer,
  isWinAnsiEncodable,
  rasterLineImage,
} from './text-appearance';
export type { RasterTextLine, ComplexTextRasterizer } from './text-appearance';

export type {
  AcroFormFieldType,
  ButtonStyle,
  AcroFormWidget,
  AcroFormCatalog,
  AcroFormField,
  AppearanceVariant,
  AppearanceStream,
  FlattenFieldResult,
  FlattenFieldOptions,
} from './types';

export { DEFAULT_FLATTEN_OPTIONS } from './types';
