// PKCE (RFC 7636, S256) and the OAuth `state` value: generation and constant-time comparison.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const base64url = (buf: Buffer): string => buf.toString('base64url')

/** A code verifier: 32 random bytes → 43 base64url characters (RFC 7636 §4.1 allows 43–128). */
export function createVerifier(): string {
  return base64url(randomBytes(32))
}

/** S256 challenge of a verifier: BASE64URL(SHA256(ASCII(verifier))). */
export function challengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest())
}

/** An unguessable `state` for one authorization request. */
export function createState(): string {
  return base64url(randomBytes(24))
}

/** Compares the `state` that came back with the one sent, without leaking timing; false for anything missing. */
export function sameState(expected: string, received: string | null | undefined): boolean {
  if (!expected || typeof received !== 'string' || !received) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  // timingSafeEqual needs equal lengths; compare against itself so a length mismatch costs the same.
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
