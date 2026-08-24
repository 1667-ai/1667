/** Schema-5 size bounds. Schemas 2, 3, and 4 keep their own frozen ceilings. */

export const MAX_WRITING_PROMPT_SCALARS = 65_536;
/** Reserves 4,000 scalars and two newlines for a maximum Author's Note when a
 *  provider folds that note into the following request or stored instruction. */
export const MAX_DEFAULT_CONTINUE_DIRECTION_SCALARS = 61_534;
export const MAX_WRITING_OBJECT_BYTES = 384 * 1024;
export const MAX_SETTINGS_DOCUMENT_V5_BYTES = 1_048_576;
export const MAX_SETTINGS_STATE_V5_BYTES = 4_194_304;
/** 1 MiB document plus 64 secret values of 16 KiB at worst-case JSON escape
 *  expansion, plus command overhead. */
export const MAX_SETTINGS_SAVE_REQUEST_BYTES = 8_388_608;
export const MAX_PROVIDER_PROBE_REQUEST_BYTES = 1_048_576;
export const MAX_PROVIDER_PROBE_SECRETS = 4;
