export { initializeVault, Vault, getVault } from './vault';
export { PermissionManager, getPermissionManager, type PermissionCheckResult } from './permissions';
export { injectSecrets, hasSecretPlaceholders, extractSecretNames, redactSecrets, createPlaceholder, isValidSecretName, type InjectionContext, type InjectionResult } from './secret-injector';
export { PasskeyAuth, getPasskeyAuth } from './auth/passkey';
export { TOTPAuth, getTOTPAuth } from './auth/totp';
export { SessionManager, getSessionManager, type SessionData } from './auth/session';
