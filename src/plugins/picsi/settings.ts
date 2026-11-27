import { CliError } from '../../utils/errors';

export interface SwapOptions {
  at?: string;
  dax?: boolean;
  optimize?: boolean;
  fixHairline?: boolean;
  fixEyes?: boolean;
  fixEars?: boolean;
  retainMouth?: boolean;
  fixOcclusion?: boolean;
  fixJawline?: boolean;
  shapify?: string;
}

/** Names and defaults used by the official Chrome extension (v1.0.3). */
export function swapSettings(options: SwapOptions): Record<string, string> {
  const coordinates = (options.at ?? '50,50').split(',').map((part) => part.trim());
  if (coordinates.length !== 2 || coordinates.some((part) => !part || !Number.isFinite(Number(part)) || Number(part) < 0 || Number(part) > 100)) {
    throw new CliError('INVALID_PARAMS', '--at must be x,y percentages between 0 and 100', 'For example: --at 25,50');
  }
  const shapify = options.shapify === undefined ? 600 : Number(options.shapify);
  if (!Number.isInteger(shapify) || shapify < 1 || shapify > 1000) {
    throw new CliError('INVALID_PARAMS', '--shapify must be a whole number from 1 to 1000');
  }
  return {
    active: '1', apisource: '8',
    cx: String(Math.round(Number(coordinates[0]) * 100)),
    cy: String(Math.round(Number(coordinates[1]) * 100)),
    dax: String(options.dax !== false), opt: String(options.optimize !== false),
    hl: String(options.fixHairline === true), eyes: String(options.fixEyes === true),
    ears: String(options.fixEars === true), m: String(options.retainMouth === true),
    fo: String(options.fixOcclusion === true), ch: String(options.fixJawline === true),
    shapify: String(options.shapify !== undefined), shapifyVal: String(shapify),
  };
}
