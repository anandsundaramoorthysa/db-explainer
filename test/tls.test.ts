import { describe, expect, it } from 'vitest';
import { parseConnectionString } from '../src/db/connectionString';
import { certificateProblem, tlsFor } from '../src/db/tls';
import { ConnectionProfile } from '../src/types';

const base: ConnectionProfile = { id: 'p', name: 'shop', engine: 'postgres', host: 'db.example.com', ssl: true };

describe('checking the server certificate', () => {
  it('checks it by default on an encrypted connection', () => {
    expect(tlsFor(base)).toEqual({ rejectUnauthorized: true });
  });

  it('does not encrypt when encryption is off', () => {
    expect(tlsFor({ ...base, ssl: false })).toBeUndefined();
    expect(tlsFor({ ...base, ssl: undefined })).toBeUndefined();
  });

  it('skips the check only when the developer chose to for this connection', () => {
    expect(tlsFor({ ...base, tlsVerify: false })).toEqual({ rejectUnauthorized: false });
    expect(tlsFor({ ...base, tlsVerify: true })).toEqual({ rejectUnauthorized: true });
  });

  it('trusts a chosen certificate authority file and still checks', () => {
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----');
    expect(tlsFor({ ...base, caFile: 'C:/certs/rds.pem' }, () => ca)).toEqual({ rejectUnauthorized: true, ca });
  });

  it('says clearly when that file is missing, instead of quietly not checking', () => {
    expect(() =>
      tlsFor({ ...base, caFile: 'C:/gone.pem' }, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/C:\/gone.pem could not be read/);
  });
});

describe('recognising a certificate problem', () => {
  it.each([
    [Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })],
    [Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })],
    [Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })],
    [new Error('certificate has expired')],
    [Object.assign(new Error('Failed to connect'), { originalError: Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }) })],
    [Object.assign(new Error('Connection failed'), { cause: new Error('unable to get local issuer certificate') })],
  ])('finds it: %s', (e) => {
    expect(certificateProblem(e)).toBeTruthy();
  });

  it.each([[new Error('password authentication failed for user "me"')], [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })], ['not an error'], [undefined]])(
    'ignores other problems: %s',
    (e) => {
      expect(certificateProblem(e)).toBeUndefined();
    },
  );
});

describe('connection strings and the check', () => {
  it('keeps checking for require and verify-full', () => {
    expect(parseConnectionString('postgres://u@h/d?sslmode=require')).not.toHaveProperty('tlsVerify');
    expect(parseConnectionString('postgres://u@h/d?sslmode=verify-full')).not.toHaveProperty('tlsVerify');
  });

  it('only skips it when the string asks for that by name', () => {
    expect(parseConnectionString('postgres://u@h/d?sslmode=no-verify')).toMatchObject({ ssl: true, tlsVerify: false });
    expect(parseConnectionString('sqlserver://u@h/d?trustServerCertificate=true')).toMatchObject({ ssl: true, tlsVerify: false });
  });
});
