export const IS_DEV = process.env['CLI_CEB_DEV'] === 'true';
export const IS_PROD = !IS_DEV;
export const IS_FIREFOX = process.env['CLI_CEB_FIREFOX'] === 'true';
export const IS_CI = process.env['CEB_CI'] === 'true';
// Opt-out flags: enabled by default unless explicitly set to 'false'
export const DOCUMENTS_ENABLED = process.env['CEB_ENABLE_DOCUMENTS'] !== 'false';
export const WHATSAPP_ENABLED = process.env['CEB_ENABLE_WHATSAPP'] !== 'false';
// Opt-in flags: disabled by default, enabled only if set to 'true'
export const WEBGPU_MODELS_ENABLED = process.env['CEB_ENABLE_WEBGPU_MODELS'] === 'true';
