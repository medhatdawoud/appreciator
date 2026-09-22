/**
 * Errors that are safe to describe to a client.
 *
 * Anything thrown that is *not* an `HttpError` is treated as an internal fault:
 * it is logged in full server-side and answered with a generic 500, so stack
 * traces, SQL text and driver messages never reach the caller.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function badRequest(message: string, code = 'bad_request'): HttpError {
  return new HttpError(400, code, message);
}

/**
 * The single 401 used by every management route.
 *
 * The message is intentionally uniform: a missing header, a malformed header
 * and a well-formed but unknown key all read the same, so the response cannot
 * be used to probe which keys exist.
 */
export function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'Missing or invalid credentials');
}

/**
 * The 401 for cookie-authenticated routes: no session, a bad or expired one,
 * or one for an account that no longer exists. Kept apart from `unauthorized`
 * so the dashboard can tell "sign in again" from "wrong management key".
 */
export function unauthenticated(): HttpError {
  return new HttpError(401, 'unauthenticated', 'Not signed in');
}

export function forbidden(message: string, code = 'forbidden'): HttpError {
  return new HttpError(403, code, message);
}

/**
 * Used both for genuinely absent buttons and for buttons owned by another
 * tenant. Answering 403 for the latter would confirm that an id exists.
 */
export function notFound(message = 'Not found', code = 'not_found'): HttpError {
  return new HttpError(404, code, message);
}
