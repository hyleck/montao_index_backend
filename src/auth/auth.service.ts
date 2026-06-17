import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { Model } from 'mongoose';
import { AuthenticatedRequest } from './auth.guard';
import { CpanelEmailService } from '../cpanel/cpanel-email.service';
import { MailCredentialService } from '../mailbox/mail-credential.service';
import { User, UserDocument } from '../schemas/user.schema';

interface MontaoGpsLoginResponse {
  access_token?: string;
  user?: {
    email?: string;
    name?: string;
    last_name?: string;
    role?: unknown;
  };
}

interface MontaoGpsUserExistsResponse {
  exists?: boolean;
}

interface MontaoRentUserExistsResponse {
  exists?: boolean;
}

interface MontaoRentProvisionResponse {
  connected?: boolean;
  created?: boolean;
}

interface MontaoCrmProvisionResponse {
  connected?: boolean;
  created?: boolean;
}

interface MontaoAdminProvisionResponse {
  connected?: boolean;
  created?: boolean;
}

interface MontaoCrmUser {
  email?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly jwtService: JwtService,
    private readonly cpanelEmailService: CpanelEmailService,
    private readonly mailCredentialService: MailCredentialService,
  ) {}

  async register(body: { name?: string; email?: string; password?: string }) {
    const cleanName = String(body.name || '').trim();
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const cleanPassword = String(body.password || '');

    if (!cleanName || !cleanEmail || !cleanPassword) {
      throw new BadRequestException('Nombre, correo y contrasena son requeridos');
    }

    if (!cleanEmail.includes('@')) {
      throw new BadRequestException('El correo no es valido');
    }

    if (cleanPassword.length < 6) {
      throw new BadRequestException('La contrasena debe tener al menos 6 caracteres');
    }

    const existingUser = await this.userModel.findOne({ email: cleanEmail });
    if (existingUser) {
      throw new ConflictException('Este correo no esta disponible');
    }

    const gpsUserExists = await this.userExistsInMontaoGps(cleanEmail);
    if (gpsUserExists) {
      throw new ConflictException('Este correo no esta disponible');
    }

    const mailCredentials = await this.provisionMailboxCredentials(cleanEmail);
    await this.ensureMontaoRentUser(cleanEmail, cleanName, cleanPassword);
    await this.ensureMontaoCrmUser(cleanEmail, cleanName, cleanPassword);
    await this.ensureMontaoAdminUser(cleanEmail, cleanName, cleanPassword);

    const user = await this.userModel.create({
      email: cleanEmail,
      passwordHash: await bcrypt.hash(cleanPassword, 12),
      name: cleanName,
      role: 'user',
      ...mailCredentials,
    });

    return this.createSession(user);
  }

  async login(body: { email?: string; password?: string }) {
    const cleanEmails = this.normalizeLoginEmails(body.email);
    const primaryEmail = cleanEmails[0] || '';
    const cleanPassword = String(body.password || '');

    if (!primaryEmail || !cleanPassword) {
      throw new BadRequestException('Usuario/correo y contrasena son requeridos');
    }

    let user: UserDocument | null = null;
    for (const email of cleanEmails) {
      user = await this.userModel.findOne({ email });
      if (user) {
        break;
      }
    }

    if (!user) {
      const gpsUser = await this.loginWithMontaoGps(primaryEmail, cleanPassword);
      if (!gpsUser) {
        throw new UnauthorizedException('Credenciales invalidas');
      }

      const syncedUser = await this.createUserFromMontaoGps(primaryEmail, cleanPassword, gpsUser);
      return this.createSession(syncedUser);
    }

    const passwordMatches = await bcrypt.compare(cleanPassword, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciales invalidas');
    }

    return this.createSession(user);
  }

  private normalizeLoginEmails(value: unknown): string[] {
    const input = String(value || '').trim().toLowerCase();

    if (!input) {
      return [];
    }

    if (input.includes('@')) {
      return [input];
    }

    return [`${input}@montao.net`, `${input}@monta.net`, `${input}@montao.local`];
  }

  async updateMe(
    request: AuthenticatedRequest,
    body: { name?: string; email?: string; password?: string },
  ) {
    const cleanName = String(body.name || '').trim();
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const cleanPassword = String(body.password || '');

    if (!cleanName || !cleanEmail) {
      throw new BadRequestException('Nombre y correo son requeridos');
    }

    if (!cleanEmail.includes('@')) {
      throw new BadRequestException('El correo no es valido');
    }

    if (cleanPassword && cleanPassword.length < 6) {
      throw new BadRequestException('La contrasena debe tener al menos 6 caracteres');
    }

    const user = await this.userModel.findById(request.user.sub);
    if (!user) {
      throw new UnauthorizedException('Sesion invalida');
    }

    if (user.email !== cleanEmail) {
      const existingUser = await this.userModel.findOne({
        _id: { $ne: user.id },
        email: cleanEmail,
      });

      if (existingUser) {
        throw new ConflictException('Este correo no esta disponible');
      }
    }

    const shouldProvisionMailbox =
      cleanEmail !== user.email ||
      (this.mailCredentialService.isManagedEmail(cleanEmail) &&
        (!user.mailEmail || !user.mailPasswordEncrypted || user.mailEmail !== cleanEmail));

    user.name = cleanName;
    user.email = cleanEmail;

    if (cleanPassword) {
      user.passwordHash = await bcrypt.hash(cleanPassword, 12);
    }

    if (shouldProvisionMailbox) {
      Object.assign(user, await this.provisionMailboxCredentials(cleanEmail));
    } else if (!this.mailCredentialService.isManagedEmail(cleanEmail)) {
      user.mailEmail = undefined;
      user.mailPasswordEncrypted = undefined;
    }

    await user.save();

    return this.createSession(user);
  }

  async getMe(request: AuthenticatedRequest) {
    const user = await this.userModel.findById(request.user.sub);
    if (!user) {
      throw new UnauthorizedException('Sesion invalida');
    }

    return this.createSession(user);
  }

  async createMontaoGpsSso(request: AuthenticatedRequest) {
    const user = await this.userModel.findById(request.user.sub).lean();

    if (!user?.email) {
      throw new BadRequestException('Este usuario no tiene correo configurado en Montao Index.');
    }

    const gpsApiUrl = process.env['MONTAO_GPS_API_URL'] || 'https://tracker-back.dorhu.com';
    const gpsFrontendUrl =
      process.env['MONTAO_GPS_FRONTEND_URL'] || 'https://tracker.montao.net';
    const ssoSecret =
      process.env['MONTAO_INDEX_SSO_SECRET'] ||
      process.env['MONTAO_GPS_SSO_SECRET'] ||
      'montao_index_sso_dev_secret';

    const response = await fetch(`${gpsApiUrl}/auth/sso/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-montao-index-sso-secret': ssoSecret,
      },
      body: JSON.stringify({
        email: user.email,
        name: user.name,
        source: 'montao_index',
      }),
    });

    if (!response.ok) {
      const payload = (await response
        .json()
        .catch(() => ({ message: 'No se pudo iniciar SSO' }))) as { message?: string };
      throw new HttpException(
        payload.message || 'No se pudo iniciar SSO con Montao GPS',
        response.status,
      );
    }

    const payload = (await response.json()) as {
      access_token: string;
      session_date?: string;
      user?: unknown;
    };
    const gpsUser = encodeURIComponent(JSON.stringify(payload.user || {}));
    const token = encodeURIComponent(payload.access_token);
    const sessionDate = payload.session_date
      ? `&session_date=${encodeURIComponent(payload.session_date)}`
      : '';

    return {
      redirectUrl: `${gpsFrontendUrl}/auth/sso?token=${token}&user=${gpsUser}${sessionDate}`,
    };
  }

  async createMontaoRentSso(request: AuthenticatedRequest) {
    const user = await this.userModel.findById(request.user.sub).lean();

    if (!user?.email) {
      throw new BadRequestException('Este usuario no tiene correo configurado en Montao Index.');
    }

    const rentApiUrl = process.env['RENT_API_URL'] || 'https://backend-rent.montao.net';
    const rentFrontendUrl = process.env['RENT_FRONTEND_URL'] || 'https://rent.montao.net';
    const rentApiToken = process.env['RENT_API_TOKEN'];

    if (!rentApiToken) {
      throw new ServiceUnavailableException('No se configuro el token de Montao Rent');
    }

    await this.ensureMontaoRentUser(user.email, user.name);

    const response = await fetch(`${rentApiUrl}/auth/sso/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rentApiToken}`,
      },
      body: JSON.stringify({
        email: user.email,
        name: user.name,
        source: 'montao_index',
      }),
    });

    if (!response.ok) {
      const payload = (await response
        .json()
        .catch(() => ({ message: 'No se pudo iniciar SSO con Montao Rent' }))) as {
        message?: string;
      };
      throw new HttpException(
        payload.message || 'No se pudo iniciar SSO con Montao Rent',
        response.status,
      );
    }

    const payload = (await response.json()) as {
      access_token: string;
      user?: unknown;
    };
    const token = encodeURIComponent(payload.access_token);
    const rentUser = encodeURIComponent(JSON.stringify(payload.user || {}));

    return {
      redirectUrl: `${rentFrontendUrl}/auth/sso?token=${token}&user=${rentUser}`,
    };
  }

  async createMontaoCrmSso(request: AuthenticatedRequest) {
    const user = await this.userModel.findById(request.user.sub).lean();

    if (!user?.email) {
      throw new BadRequestException('Este usuario no tiene correo configurado en Montao Index.');
    }

    const crmApiUrl = process.env['CRM_API_URL'] || 'https://crmbackend.dorhu.com';
    const crmFrontendUrl = process.env['CRM_FRONTEND_URL'] || 'https://crmgestion.dorhu.com';
    const crmApiToken = process.env['CRM_API_TOKEN'];

    if (!crmApiToken) {
      throw new ServiceUnavailableException('No se configuro el token de Montao CRM');
    }

    await this.ensureMontaoCrmUser(user.email, user.name);

    const response = await fetch(`${crmApiUrl}/api/auth/sso/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${crmApiToken}`,
      },
      body: JSON.stringify({
        email: user.email,
        name: user.name,
        source: 'montao_index',
      }),
    });

    if (!response.ok) {
      const payload = (await response
        .json()
        .catch(() => ({ message: 'No se pudo iniciar SSO con Montao CRM' }))) as {
        message?: string;
      };
      throw new HttpException(
        payload.message || 'No se pudo iniciar SSO con Montao CRM',
        response.status,
      );
    }

    const payload = (await response.json()) as {
      access_token: string;
      user?: unknown;
    };
    const token = encodeURIComponent(payload.access_token);
    const crmUser = encodeURIComponent(JSON.stringify(payload.user || {}));

    return {
      redirectUrl: `${crmFrontendUrl}/auth/sso?token=${token}&user=${crmUser}`,
    };
  }

  async currentUserExistsInMontaoGps(request: AuthenticatedRequest) {
    const user = await this.userModel.findById(request.user.sub).lean();

    if (!user?.email) {
      throw new BadRequestException('Este usuario no tiene correo configurado en Montao Index.');
    }

    return {
      exists: await this.userExistsInMontaoGps(user.email),
    };
  }

  async currentUserExistsInMontaoRent(request: AuthenticatedRequest) {
    const user = await this.userModel.findById(request.user.sub).lean();

    if (!user?.email) {
      throw new BadRequestException('Este usuario no tiene correo configurado en Montao Index.');
    }

    return {
      exists: await this.ensureMontaoRentUser(user.email, user.name),
    };
  }

  async currentUserExistsInMontaoCrm(request: AuthenticatedRequest) {
    const user = await this.userModel.findById(request.user.sub).lean();

    if (!user?.email) {
      throw new BadRequestException('Este usuario no tiene correo configurado en Montao Index.');
    }

    return {
      exists: await this.ensureMontaoCrmUser(user.email, user.name),
    };
  }

  private createSession(user: { id: string; email: string; name: string; role: string }) {
    const token = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  private async loginWithMontaoGps(
    email: string,
    password: string,
  ): Promise<MontaoGpsLoginResponse['user'] | null> {
    const gpsApiUrl = process.env['MONTAO_GPS_API_URL'] || 'https://tracker-back.dorhu.com';

    const response = await fetch(`${gpsApiUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    }).catch(() => null);

    if (!response?.ok) {
      return null;
    }

    const payload = (await response.json().catch(() => null)) as MontaoGpsLoginResponse | null;
    if (!payload?.access_token || !payload.user?.email) {
      return null;
    }

    return payload.user;
  }

  private async userExistsInMontaoGps(email: string): Promise<boolean> {
    const gpsApiUrl = process.env['MONTAO_GPS_API_URL'] || 'https://tracker-back.dorhu.com';
    const ssoSecret =
      process.env['MONTAO_INDEX_SSO_SECRET'] ||
      process.env['MONTAO_GPS_SSO_SECRET'] ||
      'montao_index_sso_dev_secret';

    const response = await fetch(`${gpsApiUrl}/auth/sso/user-exists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-montao-index-sso-secret': ssoSecret,
      },
      body: JSON.stringify({ email }),
    }).catch(() => null);

    if (!response?.ok) {
      throw new ServiceUnavailableException(
        'No se pudo validar si el correo existe en Montao GPS',
      );
    }

    const payload = (await response.json().catch(() => null)) as MontaoGpsUserExistsResponse | null;
    if (!payload || typeof payload.exists !== 'boolean') {
      throw new ServiceUnavailableException(
        'Montao GPS no devolvio una validacion de correo valida',
      );
    }

    return payload?.exists === true;
  }

  private async userExistsInMontaoRent(email: string): Promise<boolean> {
    const rentApiUrl = process.env['RENT_API_URL'] || 'https://backend-rent.montao.net';
    const rentApiToken = process.env['RENT_API_TOKEN'];

    if (!rentApiToken) {
      throw new ServiceUnavailableException('No se configuro el token de Montao Rent');
    }

    const response = await fetch(
      `${rentApiUrl}/users/exists-by-email?email=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${rentApiToken}`,
        },
      },
    ).catch(() => null);

    if (!response?.ok) {
      throw new ServiceUnavailableException(
        'No se pudo validar si el correo existe en Montao Rent',
      );
    }

    const payload = (await response.json().catch(() => null)) as MontaoRentUserExistsResponse | null;
    if (!payload || typeof payload.exists !== 'boolean') {
      throw new ServiceUnavailableException(
        'Montao Rent no devolvio una validacion de correo valida',
      );
    }

    return payload.exists === true;
  }

  private async userExistsInMontaoCrm(email: string): Promise<boolean> {
    const crmApiUrl = process.env['CRM_API_URL'] || 'https://crmbackend.dorhu.com';
    const crmApiToken = process.env['CRM_API_TOKEN'];

    if (!crmApiToken) {
      throw new ServiceUnavailableException('No se configuro el token de Montao CRM');
    }

    const directResponse = await fetch(
      `${crmApiUrl}/api/users/exists-by-email?email=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${crmApiToken}`,
        },
      },
    ).catch(() => null);

    if (directResponse?.ok) {
      const directPayload = (await directResponse.json().catch(() => null)) as
        | { exists?: boolean }
        | null;

      if (typeof directPayload?.exists === 'boolean') {
        return directPayload.exists;
      }
    }

    const response = await fetch(`${crmApiUrl}/api/users`, {
      headers: {
        Authorization: `Bearer ${crmApiToken}`,
      },
    }).catch(() => null);

    if (!response?.ok) {
      throw new ServiceUnavailableException(
        'No se pudo validar si el correo existe en Montao CRM',
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | MontaoCrmUser[]
      | { users?: MontaoCrmUser[]; data?: MontaoCrmUser[] }
      | null;

    const users = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.users)
        ? payload.users
        : Array.isArray(payload?.data)
          ? payload.data
          : null;

    if (!users) {
      throw new ServiceUnavailableException(
        'Montao CRM no devolvio una lista de usuarios valida',
      );
    }

    const cleanEmail = String(email || '').trim().toLowerCase();
    return users.some((user) => String(user.email || '').trim().toLowerCase() === cleanEmail);
  }

  private async createUserFromMontaoGps(
    email: string,
    password: string,
    gpsUser: NonNullable<MontaoGpsLoginResponse['user']>,
  ) {
    const cleanGpsEmail = String(gpsUser.email || email).trim().toLowerCase();
    const fullName = [gpsUser.name, gpsUser.last_name]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ');

    const existingUser = await this.userModel.findOne({ email: cleanGpsEmail });
    if (existingUser) {
      return existingUser;
    }

    const mailCredentials = await this.provisionMailboxCredentials(cleanGpsEmail);
    await this.ensureMontaoRentUser(cleanGpsEmail, fullName || cleanGpsEmail, password);
    await this.ensureMontaoCrmUser(cleanGpsEmail, fullName || cleanGpsEmail, password);
    await this.ensureMontaoAdminUser(cleanGpsEmail, fullName || cleanGpsEmail, password);

    return this.userModel.create({
      email: cleanGpsEmail,
      passwordHash: await bcrypt.hash(password, 12),
      name: fullName || cleanGpsEmail,
      role: typeof gpsUser.role === 'string' && gpsUser.role.trim() ? gpsUser.role : 'user',
      ...mailCredentials,
    });
  }

  private async provisionMailboxCredentials(email: string) {
    if (!this.mailCredentialService.isManagedEmail(email)) {
      return {
        mailEmail: undefined,
        mailPasswordEncrypted: undefined,
      };
    }

    const mailboxPassword = this.mailCredentialService.generateMailboxPassword();
    await this.cpanelEmailService.ensureEmailAccount(email, mailboxPassword, {
      updatePasswordIfExists: true,
    });

    return this.mailCredentialService.credentialForManagedEmail(email, mailboxPassword);
  }

  private async ensureMontaoRentUser(
    email: string,
    name: string,
    password?: string,
  ): Promise<boolean> {
    const exists = await this.userExistsInMontaoRent(email);
    if (exists) {
      await this.provisionMontaoRentUser(email, name, password).catch(() => undefined);
      return true;
    }

    await this.provisionMontaoRentUser(email, name, password);
    return true;
  }

  private async ensureMontaoCrmUser(
    email: string,
    name: string,
    password?: string,
  ): Promise<boolean> {
    const exists = await this.userExistsInMontaoCrm(email);
    if (exists) {
      await this.provisionMontaoCrmUser(email, name, password).catch(() => undefined);
      return true;
    }

    await this.provisionMontaoCrmUser(email, name, password);
    return true;
  }

  private async ensureMontaoAdminUser(
    email: string,
    name: string,
    password?: string,
  ): Promise<boolean> {
    await this.provisionMontaoAdminUser(email, name, password);
    return true;
  }

  private async provisionMontaoRentUser(
    email: string,
    name: string,
    password?: string,
  ): Promise<void> {
    const rentApiUrl = process.env['RENT_API_URL'] || 'https://backend-rent.montao.net';
    const rentApiToken = process.env['RENT_API_TOKEN'];

    if (!rentApiToken) {
      throw new ServiceUnavailableException('No se configuro el token de Montao Rent');
    }

    const response = await fetch(`${rentApiUrl}/auth/sso/provision-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rentApiToken}`,
      },
      body: JSON.stringify({
        email,
        name,
        password,
        source: 'montao_index',
      }),
    }).catch(() => null);

    if (!response?.ok) {
      const payload = (await response
        ?.json()
        .catch(() => ({ message: 'No se pudo conectar el usuario con Montao Rent' }))) as
        | { message?: string }
        | undefined;

      throw new ServiceUnavailableException(
        payload?.message || 'No se pudo conectar el usuario con Montao Rent',
      );
    }

    const payload = (await response.json().catch(() => null)) as MontaoRentProvisionResponse | null;
    if (!payload || payload.connected !== true) {
      throw new ServiceUnavailableException(
        'Montao Rent no confirmo la conexion del usuario',
      );
    }
  }

  private async provisionMontaoCrmUser(
    email: string,
    name: string,
    password?: string,
  ): Promise<void> {
    const crmApiUrl = process.env['CRM_API_URL'] || 'https://crmbackend.dorhu.com';
    const crmApiToken = process.env['CRM_API_TOKEN'];

    if (!crmApiToken) {
      throw new ServiceUnavailableException('No se configuro el token de Montao CRM');
    }

    const response = await fetch(`${crmApiUrl}/api/auth/sso/provision-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${crmApiToken}`,
      },
      body: JSON.stringify({
        email,
        name,
        password,
        source: 'montao_index',
      }),
    }).catch(() => null);

    if (!response?.ok) {
      const payload = (await response
        ?.json()
        .catch(() => ({ message: 'No se pudo conectar el usuario con Montao CRM' }))) as
        | { message?: string }
        | undefined;

      throw new ServiceUnavailableException(
        payload?.message || 'No se pudo conectar el usuario con Montao CRM',
      );
    }

    const payload = (await response.json().catch(() => null)) as MontaoCrmProvisionResponse | null;
    if (!payload || payload.connected !== true) {
      throw new ServiceUnavailableException(
        'Montao CRM no confirmo la conexion del usuario',
      );
    }
  }

  private async provisionMontaoAdminUser(
    email: string,
    name: string,
    password?: string,
  ): Promise<void> {
    const response = await fetch(`${this.montaoAdminApiUrl()}/api/user/sso/provision-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-montao-index-sso-secret': this.montaoAdminSsoSecret(),
      },
      body: JSON.stringify({
        email,
        name,
        password,
        source: 'montao_index',
      }),
    }).catch(() => null);

    if (!response?.ok) {
      const payload = (await response
        ?.json()
        .catch(() => ({ message: 'No se pudo conectar el usuario con Montao Admin' }))) as
        | { message?: string }
        | undefined;

      throw new ServiceUnavailableException(
        payload?.message || 'No se pudo conectar el usuario con Montao Admin',
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | MontaoAdminProvisionResponse
      | null;

    if (!payload || payload.connected !== true) {
      throw new ServiceUnavailableException(
        'Montao Admin no confirmo la conexion del usuario',
      );
    }
  }

  private montaoAdminApiUrl(): string {
    return (
      process.env['MONTAO_ADMIN_API_URL'] ||
      process.env['ADMIN_API_URL'] ||
      'https://back-montao.dorhu.com'
    ).replace(/\/+$/, '');
  }

  private montaoAdminSsoSecret(): string {
    return (
      process.env['MONTAO_ADMIN_SSO_SECRET'] ||
      process.env['MONTAO_INDEX_SSO_SECRET'] ||
      process.env['MONTAO_GPS_SSO_SECRET'] ||
      'montao_index_sso_dev_secret'
    );
  }
}
