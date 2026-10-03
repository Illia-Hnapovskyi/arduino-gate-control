// Only allow-listed translation keys cross the auth boundary. Never forward a
// provider message: it can contain an address, a credential or an internal URL.
export type AuthErrorKey =
  | "accountAuthError"
  | "accountInvalidCredentials"
  | "accountEmailUnconfirmed"
  | "accountRateLimited"
  | "accountNetworkError"
  | "accountWeakPassword"
  | "accountSamePassword"
  | "accountReauthenticationRequired"
  | "accountEmailDeliveryUnavailable"
  | "accountProviderUnavailable"
  | "accountSessionExpired"
  | "accountPasskeyUnavailable"
  | "accountPasskeyCancelled"
  | "accountPasskeyOriginUnavailable"
  | "accountPasskeyFailed"
  | "accountPasskeyRefreshFailed"
  | "accountPasskeyAlreadyExists"
  | "accountPasskeyLimit";

export type AuthActionResult = { ok: boolean; errorKey?: AuthErrorKey };

type AuthErrorShape = {
  code?: unknown;
  name?: unknown;
  status?: unknown;
  cause?: unknown;
};

export function authFailure(
  error: unknown,
  fallback: AuthErrorKey = "accountAuthError",
): AuthActionResult {
  const value: AuthErrorShape =
    error && typeof error === "object" ? error : {};
  const cause: AuthErrorShape =
    value.cause && typeof value.cause === "object" ? value.cause : {};
  const name = cause.name ?? value.name;
  let errorKey: AuthErrorKey;
  switch (value.code) {
    case "invalid_credentials":
      errorKey = "accountInvalidCredentials";
      break;
    case "email_not_confirmed":
      errorKey = "accountEmailUnconfirmed";
      break;
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      errorKey = "accountRateLimited";
      break;
    case "weak_password":
      errorKey = "accountWeakPassword";
      break;
    case "same_password":
      errorKey = "accountSamePassword";
      break;
    case "reauthentication_needed":
    case "reauthentication_not_valid":
    case "insufficient_aal":
      errorKey = "accountReauthenticationRequired";
      break;
    case "email_address_not_authorized":
      errorKey = "accountEmailDeliveryUnavailable";
      break;
    case "provider_disabled":
    case "oauth_provider_not_supported":
      errorKey = "accountProviderUnavailable";
      break;
    case "session_not_found":
    case "refresh_token_not_found":
    case "refresh_token_already_used":
      errorKey = "accountSessionExpired";
      break;
    case "passkey_disabled":
      errorKey = "accountPasskeyUnavailable";
      break;
    case "ERROR_CEREMONY_ABORTED":
      errorKey = "accountPasskeyCancelled";
      break;
    case "ERROR_INVALID_DOMAIN":
    case "ERROR_INVALID_RP_ID":
      errorKey = "accountPasskeyOriginUnavailable";
      break;
    case "webauthn_credential_exists":
    case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
      errorKey = "accountPasskeyAlreadyExists";
      break;
    case "too_many_passkeys":
      errorKey = "accountPasskeyLimit";
      break;
    default:
      if (name === "NotAllowedError" ||
          (name === "AbortError" && fallback === "accountPasskeyFailed")) {
        // NotAllowedError also covers a timeout or unavailable credential;
        // the copy says the request did not complete, never blames the user.
        errorKey = "accountPasskeyCancelled";
      } else if (name === "SecurityError" && fallback === "accountPasskeyFailed") {
        errorKey = "accountPasskeyOriginUnavailable";
      } else if (value.status === 429) {
        errorKey = "accountRateLimited";
      } else if (value.name === "AuthRetryableFetchError" || name === "TypeError" ||
          name === "AbortError" || name === "TimeoutError") {
        errorKey = "accountNetworkError";
      } else {
        errorKey = fallback;
      }
  }
  return { ok: false, errorKey };
}
