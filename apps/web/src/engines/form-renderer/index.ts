/**
 * Form renderer engine. Import the heavy component lazily from pages:
 *   const FormRenderer = dynamic(() => import('@/engines/form-renderer/form-renderer').then(m => m.FormRenderer), { ssr: false });
 * Light helpers (types, validation, value utils, api hooks) can be imported from here.
 */
export type { FormRendererHandle, FormRendererProps } from './form-renderer';
export { errorsFromProblem, validateForm, type ErrorMap } from './validation';
export { initialValues, formatDecimal, toFixedDecimal } from './values';
export { useRenderableForm, renderApi } from './render-api';
