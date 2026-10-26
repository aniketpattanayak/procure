import { Algorithm, hash, verify } from '@node-rs/argon2';
import { Password } from '@procure/schema';
import { randomInt } from 'node:crypto';

/** Argon2id parameters (OWASP 2024 floor: m=19 MiB, t=2, p=1). */
const OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/** Hash of a random string, verified against when the user does not exist so timing stays similar. */
let dummyHash: Promise<string> | null = null;
export function dummyVerify(plain: string): Promise<boolean> {
  dummyHash ??= hashPassword(`dummy-${randomInt(1e9)}-Aa1`);
  return dummyHash.then(h => verifyPassword(h, plain)).then(() => false);
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SYMBOL = '@#$%&*!?';
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

/** 16-char crypto-random temporary password that always satisfies the `Password` policy. */
export function generateTempPassword(length = 16): string {
  for (;;) {
    const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
    while (chars.length < length) chars.push(pick(ALL));
    // Fisher-Yates with crypto randomness
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j]!, chars[i]!];
    }
    const pw = chars.join('');
    if (Password.safeParse(pw).success) return pw;
  }
}

function pick(set: string): string {
  return set[randomInt(set.length)]!;
}
