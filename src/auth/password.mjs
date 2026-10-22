import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 64);
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded ?? "");
  if (!match || typeof password !== "string") return false;
  const key = await derive(password, match[1], 64);
  return timingSafeEqual(key, Buffer.from(match[2], "hex"));
}
