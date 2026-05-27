import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { Model } from 'mongoose';
import { AuthenticatedRequest } from './auth.guard';
import { User } from '../schemas/user.schema';

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
      throw new ConflictException('Ese correo ya esta registrado');
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

    if (!cleanEmail || !body.password) {
      throw new BadRequestException('Correo y contrasena son requeridos');
    }

    const user = await this.userModel.findOne({ email: cleanEmail });
    const passwordMatches = user
      ? await bcrypt.compare(String(body.password), user.passwordHash)
      : false;

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Credenciales invalidas');
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
}
