// Hashing that runs the same in Node and in a browser (the proof verifier runs in both).
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/** SHA-256 of a UTF-8 string (or raw bytes), as lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

/** n random bytes as hex, from the platform's CSPRNG (Web Crypto, also global in Node ≥ 19). */
export function randomHex(n: number): string {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}
