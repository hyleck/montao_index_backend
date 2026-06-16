import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { Model, Types } from 'mongoose';
import { AuthenticatedRequest } from '../auth/auth.guard';
import { CpanelEmailService } from '../cpanel/cpanel-email.service';
import { MailCredentialService } from '../mailbox/mail-credential.service';
import { DelegatedMailboxAccess, User, UserDocument } from '../schemas/user.schema';

type UserRole = 'admin' | 'user';

interface UserPayload {
  name?: string;
  email?: string;
  password?: string;
  role?: string;
  delegatedMailboxes?: string[];
}

interface AvailabilityPayload {
  username?: string;
  email?: string;
  excludeId?: string;
}

interface StoredUser {
  _id: Types.ObjectId | string;
  email: string;
  name: string;
  role: string;
  delegatedMailboxes?: string[];
  delegatedMailboxAccesses?: DelegatedMailboxAccess[];
  createdAt?: Date;
  updatedAt?: Date;
}

interface DelegatedMailboxSelection {
  emails: string[];
  accesses: DelegatedMailboxAccess[];
}

interface MontaoGpsUserExistsResponse {
  exists?: boolean;
}

interface MontaoRentUserExistsResponse {
  exists?: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly cpanelEmailService: CpanelEmailService,
    private readonly mailCredentialService: MailCredentialService,
  ) {}

  async findAll(request: AuthenticatedRequest) {
    this.ensureAdmin(request);

    const users = await this.userModel
      .find()
      .sort({ name: 1, email: 1 })
      .lean<StoredUser[]>();

    return users.map((user) => this.serializeUser(user));
  }

  async checkAvailability(request: AuthenticatedRequest, body: AvailabilityPayload) {
    this.ensureAdmin(request);

    const cleanEmail = body.email
      ? this.cleanEmail(body.email)
      : this.usernameToEmail(body.username);

    if (!cleanEmail) {
      return {
        available: false,
        email: '',
        message: 'Escribe un nombre de usuario',
      };
    }

    this.validateEmail(cleanEmail);

    const query: Record<string, unknown> = { email: cleanEmail };
    if (body.excludeId && Types.ObjectId.isValid(body.excludeId)) {
      query['_id'] = { $ne: new Types.ObjectId(body.excludeId) };
    }

    const exists = await this.userModel.exists(query);

    return {
      available: !exists,
      email: cleanEmail,
      username: cleanEmail.split('@')[0],
    };
  }

  async create(request: AuthenticatedRequest, body: UserPayload) {
    this.ensureAdmin(request);

    const cleanName = this.cleanName(body.name);
    const cleanEmail = this.cleanEmail(body.email);
    const cleanPassword = String(body.password || '');
    const cleanRole = this.cleanRole(body.role);
    const delegatedSelection = await this.buildDelegatedMailboxSelection(
      body.delegatedMailboxes,
      cleanEmail,
    );

    if (!cleanName || !cleanEmail || !cleanPassword) {
      throw new BadRequestException('Nombre, correo y contrasena son requeridos');
    }

    this.validateEmail(cleanEmail);
    this.validatePassword(cleanPassword);

    const existingUser = await this.userModel.findOne({ email: cleanEmail });
    if (existingUser) {
      throw new ConflictException('Este correo no esta disponible');
    }

    const mailCredentials = await this.provisionMailboxCredentials(cleanEmail);
    await this.ensureMontaoGpsUser(cleanEmail, cleanName, cleanPassword);
    await this.ensureMontaoRentUser(cleanEmail, cleanName, cleanPassword);

    const user = await this.userModel.create({
      email: cleanEmail,
      passwordHash: await bcrypt.hash(cleanPassword, 12),
      name: cleanName,
      role: cleanRole,
      delegatedMailboxes: delegatedSelection.emails,
      delegatedMailboxAccesses: delegatedSelection.accesses,
      ...mailCredentials,
    });

    return this.serializeUser(user);
  }

  async update(request: AuthenticatedRequest, id: string, body: UserPayload) {
    this.ensureAdmin(request);
    this.validateObjectId(id);

    const user = await this.userModel.findById(id);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const cleanName = this.cleanName(body.name);
    const cleanEmail = this.cleanEmail(body.email);
    const cleanPassword = String(body.password || '');
    const cleanRole = this.cleanRole(body.role);
    const delegatedSelection = await this.buildDelegatedMailboxSelection(
      body.delegatedMailboxes,
      cleanEmail,
    );

    if (!cleanName || !cleanEmail) {
      throw new BadRequestException('Nombre y correo son requeridos');
    }

    this.validateEmail(cleanEmail);

    if (cleanPassword) {
      this.validatePassword(cleanPassword);
    }

    if (request.user.sub === id && user.role !== cleanRole) {
      throw new BadRequestException('No puedes cambiar tu propio rol');
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

    await this.ensureAdminRoleChangeIsSafe(user.id, cleanRole);

    const shouldProvisionMailbox =
      cleanEmail !== user.email ||
      (this.mailCredentialService.isManagedEmail(cleanEmail) &&
        (!user.mailEmail || !user.mailPasswordEncrypted || user.mailEmail !== cleanEmail));

    user.name = cleanName;
    user.email = cleanEmail;
    user.role = cleanRole;
    user.delegatedMailboxes = delegatedSelection.emails;
    user.delegatedMailboxAccesses = delegatedSelection.accesses;

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

    if (user.mailEmail && user.mailPasswordEncrypted) {
      await this.refreshDelegatedMailboxAccesses(user.mailEmail, user.mailPasswordEncrypted, user.name);
    }

    return this.serializeUser(user);
  }

  async remove(request: AuthenticatedRequest, id: string) {
    this.ensureAdmin(request);
    this.validateObjectId(id);

    if (request.user.sub === id) {
      throw new BadRequestException('No puedes eliminar tu propio usuario');
    }

    const user = await this.userModel.findById(id);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role === 'admin') {
      await this.ensureMoreThanOneAdmin();
    }

    await user.deleteOne();

    return { ok: true };
  }

  private ensureAdmin(request: AuthenticatedRequest): void {
    if (request.user.role !== 'admin') {
      throw new ForbiddenException('No tienes permisos para administrar usuarios');
    }
  }

  private cleanName(value: unknown): string {
    return String(value || '').trim();
  }

  private cleanEmail(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  private usernameToEmail(value: unknown): string {
    const username = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/@.*$/, '')
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9._-]/g, '');

    return username ? `${username}@montao.net` : '';
  }

  private cleanRole(value: unknown): UserRole {
    return value === 'admin' ? 'admin' : 'user';
  }

  private validateEmail(email: string): void {
    if (!email.includes('@')) {
      throw new BadRequestException('El correo no es valido');
    }
  }

  private validatePassword(password: string): void {
    if (password.length < 6) {
      throw new BadRequestException('La contrasena debe tener al menos 6 caracteres');
    }
  }

  private validateObjectId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Usuario invalido');
    }
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

  private async ensureMontaoGpsUser(email: string, name: string, password: string): Promise<void> {
    const exists = await this.userExistsInMontaoGps(email);

    if (exists) {
      return;
    }

    await this.provisionMontaoGpsUser(email, name, password);
  }

  private async ensureMontaoRentUser(email: string, name: string, password: string): Promise<void> {
    const exists = await this.userExistsInMontaoRent(email);
    if (exists) {
      await this.provisionMontaoRentUser(email, name, password).catch(() => undefined);
      return;
    }

    await this.provisionMontaoRentUser(email, name, password);
  }

  private async userExistsInMontaoGps(email: string): Promise<boolean> {
    const response = await fetch(`${this.montaoGpsApiUrl()}/auth/sso/user-exists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-montao-index-sso-secret': this.montaoGpsSsoSecret(),
      },
      body: JSON.stringify({ email }),
    }).catch(() => null);

    if (!response?.ok) {
      throw new ServiceUnavailableException(
        'No se pudo validar si el usuario existe en Montao GPS',
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | MontaoGpsUserExistsResponse
      | null;

    if (!payload || typeof payload.exists !== 'boolean') {
      throw new ServiceUnavailableException(
        'Montao GPS no devolvio una validacion de usuario valida',
      );
    }

    return payload.exists;
  }

  private async userExistsInMontaoRent(email: string): Promise<boolean> {
    const response = await fetch(
      `${this.montaoRentApiUrl()}/users/exists-by-email?email=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${this.montaoRentApiToken()}`,
        },
      },
    ).catch(() => null);

    if (!response?.ok) {
      throw new ServiceUnavailableException(
        'No se pudo validar si el usuario existe en Montao Rent',
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | MontaoRentUserExistsResponse
      | null;

    if (!payload || typeof payload.exists !== 'boolean') {
      throw new ServiceUnavailableException(
        'Montao Rent no devolvio una validacion de usuario valida',
      );
    }

    return payload.exists;
  }

  private async provisionMontaoGpsUser(
    email: string,
    name: string,
    password: string,
  ): Promise<void> {
    const response = await fetch(`${this.montaoGpsApiUrl()}/auth/sso/provision-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-montao-index-sso-secret': this.montaoGpsSsoSecret(),
      },
      body: JSON.stringify({
        email,
        name,
        password,
      }),
    }).catch(() => null);

    if (!response?.ok) {
      const payload = (await response
        ?.json()
        .catch(() => ({ message: 'No se pudo registrar el usuario en Montao GPS' }))) as
        | { message?: string }
        | undefined;

      throw new ServiceUnavailableException(
        payload?.message || 'No se pudo registrar el usuario en Montao GPS',
      );
    }
  }

  private async provisionMontaoRentUser(
    email: string,
    name: string,
    password: string,
  ): Promise<void> {
    const response = await fetch(`${this.montaoRentApiUrl()}/auth/sso/provision-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.montaoRentApiToken()}`,
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
        .catch(() => ({ message: 'No se pudo registrar el usuario en Montao Rent' }))) as
        | { message?: string }
        | undefined;

      throw new ServiceUnavailableException(
        payload?.message || 'No se pudo registrar el usuario en Montao Rent',
      );
    }
  }

  private montaoGpsApiUrl(): string {
    return (process.env['MONTAO_GPS_API_URL'] || 'https://tracker-back.dorhu.com').replace(/\/+$/, '');
  }

  private montaoGpsSsoSecret(): string {
    return (
      process.env['MONTAO_INDEX_SSO_SECRET'] ||
      process.env['MONTAO_GPS_SSO_SECRET'] ||
      'montao_index_sso_dev_secret'
    );
  }

  private montaoRentApiUrl(): string {
    return (process.env['RENT_API_URL'] || 'https://backend-rent.montao.net').replace(/\/+$/, '');
  }

  private montaoRentApiToken(): string {
    const token = process.env['RENT_API_TOKEN'];

    if (!token) {
      throw new ServiceUnavailableException('No se configuro el token de Montao Rent');
    }

    return token;
  }

  private async buildDelegatedMailboxSelection(
    value: unknown,
    ownerEmail: string,
  ): Promise<DelegatedMailboxSelection> {
    const entries = Array.isArray(value) ? value : [];
    const owner = this.cleanEmail(ownerEmail);
    const emails = Array.from(
      new Set(
        entries
          .map((item) => this.delegatedMailboxEmail(item))
          .filter(Boolean)
          .filter((email) => email !== owner),
      ),
    );
    const accesses: DelegatedMailboxAccess[] = [];

    for (const email of emails) {
      this.validateEmail(email);

      if (!this.mailCredentialService.isManagedEmail(email)) {
        throw new BadRequestException(`Solo se pueden delegar buzones @montao.net`);
      }

      const mailboxUser = await this.userModel.findOne({
        $or: [{ email }, { mailEmail: email }],
      });

      if (!mailboxUser) {
        throw new BadRequestException(`El buzon ${email} no existe como usuario`);
      }

      if (!mailboxUser.mailPasswordEncrypted) {
        throw new BadRequestException(`El buzon ${email} no tiene credenciales de correo guardadas`);
      }

      const mailboxEmail = this.cleanEmail(mailboxUser.mailEmail || mailboxUser.email);
      accesses.push({
        email: mailboxEmail,
        mailPasswordEncrypted: mailboxUser.mailPasswordEncrypted,
        label: mailboxUser.name || mailboxEmail,
      });
    }

    return {
      emails: accesses.map((access) => access.email),
      accesses,
    };
  }

  private delegatedMailboxEmail(value: unknown): string {
    if (value && typeof value === 'object' && 'email' in value) {
      return this.cleanEmail((value as { email?: unknown }).email);
    }

    return this.cleanEmail(value);
  }

  private delegatedMailboxEmails(
    delegatedMailboxes?: string[],
    delegatedMailboxAccesses?: DelegatedMailboxAccess[],
  ): string[] {
    const emails = [
      ...(Array.isArray(delegatedMailboxes) ? delegatedMailboxes : []),
      ...(Array.isArray(delegatedMailboxAccesses)
        ? delegatedMailboxAccesses.map((access) => access.email)
        : []),
    ];

    return Array.from(new Set(emails.map((email) => this.cleanEmail(email)).filter(Boolean)));
  }

  private async refreshDelegatedMailboxAccesses(
    email: string,
    mailPasswordEncrypted: string,
    label?: string,
  ): Promise<void> {
    const cleanEmail = this.cleanEmail(email);

    if (!cleanEmail || !mailPasswordEncrypted) {
      return;
    }

    const users = await this.userModel.find({
      $or: [
        { delegatedMailboxes: cleanEmail },
        { 'delegatedMailboxAccesses.email': cleanEmail },
      ],
    });

    for (const delegateUser of users) {
      const delegatedMailboxes = this.delegatedMailboxEmails(
        delegateUser.delegatedMailboxes,
        delegateUser.delegatedMailboxAccesses,
      );
      const nextMailboxes = delegatedMailboxes.includes(cleanEmail)
        ? delegatedMailboxes
        : [...delegatedMailboxes, cleanEmail];
      const nextAccesses = (delegateUser.delegatedMailboxAccesses || [])
        .filter((access) => this.cleanEmail(access.email) !== cleanEmail)
        .map((access) => ({
          email: this.cleanEmail(access.email),
          mailPasswordEncrypted: access.mailPasswordEncrypted,
          label: access.label,
        }))
        .filter((access) => access.email && access.mailPasswordEncrypted);

      nextAccesses.push({
        email: cleanEmail,
        mailPasswordEncrypted,
        label: label || cleanEmail,
      });

      delegateUser.delegatedMailboxes = nextMailboxes;
      delegateUser.delegatedMailboxAccesses = nextAccesses;
      await delegateUser.save();
    }
  }

  private async ensureAdminRoleChangeIsSafe(userId: string, nextRole: UserRole): Promise<void> {
    if (nextRole === 'admin') {
      return;
    }

    const currentUser = await this.userModel.findById(userId).lean<StoredUser>();
    if (currentUser?.role !== 'admin') {
      return;
    }

    await this.ensureMoreThanOneAdmin();
  }

  private async ensureMoreThanOneAdmin(): Promise<void> {
    const adminCount = await this.userModel.countDocuments({ role: 'admin' });
    if (adminCount <= 1) {
      throw new BadRequestException('Debe existir al menos un usuario administrador');
    }
  }

  private serializeUser(user: StoredUser) {
    return {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
      delegatedMailboxes: this.delegatedMailboxEmails(
        user.delegatedMailboxes,
        user.delegatedMailboxAccesses,
      ),
      createdAt: user.createdAt?.toISOString() || null,
      updatedAt: user.updatedAt?.toISOString() || null,
    };
  }
}
