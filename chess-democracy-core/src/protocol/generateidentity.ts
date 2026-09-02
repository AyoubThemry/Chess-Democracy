import { 
  generateKeyPairSync, 
  createPublicKey, 
  KeyObject 
} from 'node:crypto';

/**
 * Interface for the identity pair
 */
interface IdentityPair {
  publicKey: string;   // raw 32-byte public key in hex
  privateKey: string;  // PEM format
}

/**
 * Safely handles identity logic:
 * 1. If privateKeyString is provided, it derives the Public Key.
 * 2. If no string is provided, it generates a brand new Ed25519 pair.
 */
export function getOrCreateIdentity(privateKeyString?: string): IdentityPair {
  try {
    let privKeyPem: string;
    let pubKeyObject: KeyObject;

    if (privateKeyString && privateKeyString.trim() !== "") {
      // Use provided private key
      privKeyPem = privateKeyString;
      pubKeyObject = createPublicKey(privateKeyString);
    } else {
      // Generate new key pair
      const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
      });
      privKeyPem = privateKey;
      pubKeyObject = createPublicKey(privateKey);
    }

    // Export as DER and extract last 32 bytes (raw Ed25519 public key)
    const rawBuffer = pubKeyObject.export({ type: 'spki', format: 'der' });
    const rawKey = rawBuffer.slice(-32);

    return {
      privateKey: privKeyPem,
      publicKey: rawKey.toString('hex') // You can also use 'base64'
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cryptographic Identity Error: ${message}`);
  }
}
