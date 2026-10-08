// API key encryption for user-provided LLM keys.
// Uses AES-GCM with a key derived from the server secret.
// Keys are encrypted before storage in D1 and decrypted in-memory only.

async function deriveKey(serverSecret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(serverSecret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("trivium-keys-v1"),
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptKey(
  plaintext: string,
  serverSecret: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await deriveKey(serverSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );
  // base64 encode
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
  const ivB64 = btoa(String.fromCharCode(...iv));
  return { ciphertext: ctB64, iv: ivB64 };
}

export async function decryptKey(
  ciphertext: string,
  iv: string,
  serverSecret: string
): Promise<string> {
  const key = await deriveKey(serverSecret);
  const ctBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    ctBytes
  );
  return new TextDecoder().decode(pt);
}
