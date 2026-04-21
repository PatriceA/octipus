export { getPasskeyAuth, PasskeyAuth } from './auth/passkey';
export { getSessionManager, type SessionData, SessionManager } from './auth/session';
export { getTOTPAuth, TOTPAuth } from './auth/totp';
export { getPermissionManager, type PermissionCheckResult, PermissionManager } from './permissions';
export { createPlaceholder, extractSecretNames, hasSecretPlaceholders, type InjectionContext, type InjectionResult, injectSecrets, isValidSecretName, redactSecrets } from './secret-injector';
export { getVault, initializeVault, Vault } from './vault';
