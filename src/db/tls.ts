import * as fs from 'fs';
import { ConnectionProfile } from '../types';

/*
 * Encrypted connections check the server's certificate unless the developer has said not to for that connection. Without the
 * check the traffic is still encrypted, but anyone able to sit between the two could pretend to be the server and capture the
 * password. No vscode import, so the rules can be tested on their own.
 */

export interface TlsOptions {
  rejectUnauthorized: boolean;
  ca?: Buffer;
}

/** The TLS options for Postgres and MySQL, or undefined when the connection is not encrypted. */
export function tlsFor(profile: ConnectionProfile, read: (file: string) => Buffer = fs.readFileSync): TlsOptions | undefined {
  if (!profile.ssl) return undefined;
  if (profile.tlsVerify === false) return { rejectUnauthorized: false };
  if (!profile.caFile) return { rejectUnauthorized: true };
  try {
    return { rejectUnauthorized: true, ca: read(profile.caFile) };
  } catch {
    throw new Error(`The certificate authority file ${profile.caFile} could not be read. Choose it again, or remove and re-add the connection.`);
  }
}

const CERT_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH',
]);
const CERT_TEXT = /self[- ]signed certificate|unable to verify the first certificate|unable to get (?:local )?issuer certificate|certificate has expired|does not match certificate|certificate verify failed|certificate is not trusted/i;

/** The certificate problem behind a connection error, in a few words, or undefined if the error is something else. */
export function certificateProblem(e: unknown, depth = 0): string | undefined {
  if (!e || typeof e !== 'object' || depth > 4) return undefined;
  const err = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown; originalError?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  const message = typeof err.message === 'string' ? err.message : '';
  if (CERT_CODES.has(code) || CERT_TEXT.test(message)) return (message.split('\n')[0] || code).slice(0, 160);
  for (const inner of [err.cause, err.originalError, ...(Array.isArray(err.errors) ? err.errors : [])]) {
    const found = certificateProblem(inner, depth + 1);
    if (found) return found;
  }
  return undefined;
}
