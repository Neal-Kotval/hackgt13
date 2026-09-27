import { generateKeyPairSync } from "node:crypto";

// A fresh OpenSSH ed25519 public key line (no comment) for tests.
export function ed25519PublicKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const part = (buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(buffer.length); return Buffer.concat([length, buffer]); };
  return `ssh-ed25519 ${Buffer.concat([part(Buffer.from("ssh-ed25519")), part(raw)]).toString("base64")}`;
}
