export const FLUE_NATIVE_DRIVER = "flue-native-v1" as const;
export const FLUE_NATIVE_PROFILE = "bounded-issue-comment-v4" as const;
export const FLUE_NATIVE_TERMINAL_TOOL = "submit_gardener_output_v1" as const;
export const FLUE_NATIVE_REQUEST_PROTOCOL = "gardener-flue-request/v1" as const;
export const FLUE_NATIVE_DURABILITY_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Token usage is verified from the settled Flue response. Before dispatch, a
 * separate UTF-8 safety ceiling prevents pathological payloads without
 * pretending that bytes are model tokens.
 */
export const FLUE_NATIVE_INPUT_BYTES_PER_TOKEN = 8;
