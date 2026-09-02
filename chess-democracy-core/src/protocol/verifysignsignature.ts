import {
  sign,
  verify,
  createPublicKey,
  KeyObject
} from 'node:crypto';

/**
 * SIGN
 * - message: stringified payload
 * - privateKey: PEM (PKCS8)
 */
export function signMessage(message: string, privateKey: string): string {
  const data = Buffer.from(message, 'utf8');
  // Ed25519: algorithm MUST be undefined
  const signature = sign(undefined, data, privateKey);

  return signature.toString('base64');
}


export function verifySignature(
  message: string,
  signature: string,
  publicKey: string
): boolean {
  const data = Buffer.from(message, 'utf8');
  const sig = Buffer.from(signature, 'base64');

  let key: KeyObject;

  try {
    // CASE 1: PEM public key
    if (publicKey.includes('BEGIN PUBLIC KEY')) {
      key = createPublicKey(publicKey);
    }
    // CASE 2: raw Ed25519 public key (hex, 32 bytes)
    else {
      const raw = Buffer.from(publicKey, 'hex');

      if (raw.length !== 32) {
        return false;
      }

      // Build SPKI structure for Ed25519
      key = createPublicKey({
        key: Buffer.concat([
          // ASN.1 header for Ed25519 public key
          Buffer.from('302a300506032b6570032100', 'hex'),
          raw
        ]),
        format: 'der',
        type: 'spki'
      });
    }

    return verify(undefined, data, key, sig);
  } catch {
    return false;
  }
}
