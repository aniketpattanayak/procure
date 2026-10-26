import { Injectable } from '@nestjs/common';
import type { AccessClaims } from '@procure/schema';
import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config';

@Injectable()
export class TokenService {
  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('procure')
      .setAudience(claims.typ)
      .setExpirationTime(`${config.accessTtlSec}s`)
      .sign(config.jwtSecret);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const opts = { issuer: 'procure', algorithms: ['HS256'] };
    try {
      const { payload } = await jwtVerify(token, config.jwtSecret, opts);
      return payload as unknown as AccessClaims;
    } catch (e) {
      if (!config.jwtSecretPrevious) throw e;
      const { payload } = await jwtVerify(token, config.jwtSecretPrevious, opts);
      return payload as unknown as AccessClaims;
    }
  }

  /** Opaque 256-bit refresh token; only its sha256 is stored. */
  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: TokenService.hash(token) };
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
