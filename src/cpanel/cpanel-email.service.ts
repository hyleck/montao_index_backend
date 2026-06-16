import { Injectable, ServiceUnavailableException } from '@nestjs/common';

interface CpanelResponse<T = unknown> {
  status?: number;
  data?: T;
  errors?: string[];
  message?: string;
  raw?: string;
}

interface CpanelEmailAccount {
  email?: string;
  login?: string;
}

interface EnsureEmailAccountResult {
  created: boolean;
  email: string;
  skipped: boolean;
  passwordUpdated: boolean;
}

interface EnsureEmailAccountOptions {
  updatePasswordIfExists?: boolean;
}

@Injectable()
export class CpanelEmailService {
  private readonly domain = (process.env['CPANEL_DOMAIN'] || 'montao.net').toLowerCase();
  private readonly quotaMb = process.env['CPANEL_EMAIL_QUOTA_MB'] || '1024';

  async ensureEmailAccount(
    email: string,
    password: string,
    options: EnsureEmailAccountOptions = {},
  ): Promise<EnsureEmailAccountResult> {
    const cleanEmail = this.normalizeEmail(email);

    if (!this.isManagedEmail(cleanEmail)) {
      return { created: false, email: cleanEmail, skipped: true, passwordUpdated: false };
    }

    this.ensureConfigured();

    if (await this.emailExists(cleanEmail)) {
      if (options.updatePasswordIfExists) {
        await this.updateEmailPassword(cleanEmail, password);
        return { created: false, email: cleanEmail, skipped: false, passwordUpdated: true };
      }

      return { created: false, email: cleanEmail, skipped: false, passwordUpdated: false };
    }

    await this.createEmail(cleanEmail, password);

    return { created: true, email: cleanEmail, skipped: false, passwordUpdated: false };
  }

  private async emailExists(email: string): Promise<boolean> {
    const response = await this.call<CpanelEmailAccount[]>('Email/list_pops_with_disk', {
      domain: this.domain,
    });

    return (response.data || []).some((account) => {
      const accountEmail = this.normalizeAccountEmail(account.email || account.login);
      return accountEmail === email;
    });
  }

  private createEmail(email: string, password: string): Promise<CpanelResponse> {
    const username = email.split('@')[0];

    return this.call(
      'Email/add_pop',
      {
        email: username,
        domain: this.domain,
        password,
        quota: this.quotaMb,
      },
      'POST',
    );
  }

  private updateEmailPassword(email: string, password: string): Promise<CpanelResponse> {
    const username = email.split('@')[0];

    return this.call(
      'Email/passwd_pop',
      {
        email: username,
        domain: this.domain,
        password,
      },
      'POST',
    );
  }

  private async call<T>(
    moduleAndFunction: string,
    params: Record<string, string>,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<CpanelResponse<T>> {
    const host = process.env['CPANEL_HOST'];
    const port = process.env['CPANEL_PORT'] || '2083';
    const user = process.env['CPANEL_USER'];
    const token = process.env['CPANEL_TOKEN'];
    const url = new URL(`https://${host}:${port}/execute/${moduleAndFunction}`);
    const options: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `cpanel ${user}:${token}`,
      },
    };

    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    } else {
      options.headers = {
        ...options.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      options.body = new URLSearchParams(params);
    }

    const response = await fetch(url, options).catch(
      (error: Error & { cause?: { code?: string; message?: string } }) => {
        const detail = error.cause?.code || error.cause?.message || error.message;
        throw new ServiceUnavailableException(
          `No se pudo conectar con cPanel (${host}:${port}): ${detail}`,
        );
      },
    );
    const text = await response.text();
    let payload: CpanelResponse<T>;

    try {
      payload = JSON.parse(text) as CpanelResponse<T>;
    } catch {
      payload = { raw: text.slice(0, 500) };
    }

    if (!response.ok || payload.status !== 1) {
      const detail =
        payload.errors?.join('; ') || payload.message || payload.raw || response.statusText;
      throw new ServiceUnavailableException(`cPanel no pudo procesar el correo: ${detail}`);
    }

    return payload;
  }

  private ensureConfigured(): void {
    if (!process.env['CPANEL_HOST'] || !process.env['CPANEL_USER'] || !process.env['CPANEL_TOKEN']) {
      throw new ServiceUnavailableException('No se configuro la integracion de cPanel');
    }
  }

  private isManagedEmail(email: string): boolean {
    return email.endsWith(`@${this.domain}`);
  }

  private normalizeEmail(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  private normalizeAccountEmail(value: unknown): string {
    const email = this.normalizeEmail(value);

    if (!email || email.includes('@')) {
      return email;
    }

    return `${email}@${this.domain}`;
  }
}
