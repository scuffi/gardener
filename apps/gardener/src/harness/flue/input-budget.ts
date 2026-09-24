/**
 * Token usage is verified from the settled Flue response. Before dispatch, a
 * separate UTF-8 safety ceiling prevents pathological payloads without
 * pretending that bytes are model tokens.
 */
export const INPUT_BYTES_PER_TOKEN = 8;
