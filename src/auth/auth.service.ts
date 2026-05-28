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
import { User } from '../schemas/user.schema';

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

interface MontaoCrmUser {
  email?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly jwtService: JwtService,
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

    const crmUserExists = await this.userExistsInMontaoCrm(cleanEmail);
    if (crmUserExists) {
      throw new ConflictException('Este correo no esta disponible');
    }

    const user = await this.userModel.create({
      email: cleanEmail,
      passwordHash: await bcrypt.hash(cleanPassword, 12),
      name: cleanName,
      role: 'user',
    });

    return this.createSession(user);
  }

  async login(body: { email?: string; password?: string }) {
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const cleanPassword = String(body.password || '');

    if (!cleanEmail || !cleanPassword) {
      throw new BadRequestException('Correo y contrasena son requeridos');
    }

    const user = await this.userModel.findOne({ email: cleanEmail });
    if (!user) {
      const gpsUser = await this.loginWithMontaoGps(cleanEmail, cleanPassword);
      if (!gpsUser) {
        throw new UnauthorizedException('Credenciales invalidas');
      }

      const syncedUser = await this.createUserFromMontaoGps(cleanEmail, cleanPassword, gpsUser);
      return this.createSession(syncedUser);
    }

    const passwordMatches = await bcrypt.compare(cleanPassword, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciales invalidas');
    }

    return this.createSession(user);
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

    user.name = cleanName;
    user.email = cleanEmail;

    if (cleanPassword) {
      user.passwordHash = await bcrypt.hash(cleanPassword, 12);
    }

    await user.save();

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
      exists: await this.userExistsInMontaoRent(user.email),
    };
  }

  async currentUserExistsInMontaoCrm(request: AuthenticatedRequest) {
    const user = await this.userModel.findById(request.user.sub).lean();

    if (!user?.email) {
      throw new BadRequestException('Este usuario no tiene correo configurado en Montao Index.');
    }

    return {
      exists: await this.userExistsInMontaoCrm(user.email),
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

    return this.userModel.create({
      email: cleanGpsEmail,
      passwordHash: await bcrypt.hash(password, 12),
      name: fullName || cleanGpsEmail,
      role: typeof gpsUser.role === 'string' && gpsUser.role.trim() ? gpsUser.role : 'user',
    });
  }
}
