import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

@Injectable()
export class MailCredentialService {
  private readonly domain = (process.env['CPANEL_DOMAIN'] || 'montao.net').toLowerCase();

  encrypt(password: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  decrypt(value: string): string {
    const [version, iv, tag, encrypted] = value.split(':');

    if (version !== 'v1' || !iv || !tag || !encrypted) {
      throw new Error('Credencial de correo invalida');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  isManagedEmail(email: string): boolean {
    return this.normalizeEmail(email).endsWith(`@${this.domain}`);
  }

  credentialForManagedEmail(email: string, password: string) {
    const cleanEmail = this.normalizeEmail(email);

    if (!cleanEmail || !password || !this.isManagedEmail(cleanEmail)) {
      return {};
    }

    return {
      mailEmail: cleanEmail,
      mailPasswordEncrypted: this.encrypt(password),
    };
  }

  generateMailboxPassword(): string {
    return `Montao-${randomUUID()}-${randomBytes(8).toString('base64url')}!A7`;
  }

  normalizeEmail(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  private key(): Buffer {
    return createHash('sha256')
      .update(
        process.env['MAIL_CREDENTIAL_SECRET'] ||
          process.env['JWT_SECRET'] ||
          'montao_index_mail_secret',
      )
      .digest();
  }
}
