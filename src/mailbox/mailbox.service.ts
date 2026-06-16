import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FetchMessageObject, ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { Model } from 'mongoose';
import nodemailer from 'nodemailer';
import { AuthenticatedRequest } from '../auth/auth.guard';
import { CpanelEmailService } from '../cpanel/cpanel-email.service';
import { DelegatedMailboxAccess, User, UserDocument } from '../schemas/user.schema';
import { MailCredentialService } from './mail-credential.service';

interface MailboxQuery {
  box?: string;
  limit?: string;
  mailboxEmail?: string;
}

interface MailboxAuth {
  email: string;
  password: string;
  displayName: string;
  delegated: boolean;
}

interface MailboxOption {
  email: string;
  label: string;
  own: boolean;
  delegated: boolean;
}

interface ResolvedMailboxOption extends MailboxOption {
  mailPasswordEncrypted?: string;
}

interface SendMailBody {
  mailboxEmail?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  html?: string;
}

export interface MailUploadFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

@Injectable()
export class MailboxService {
  private readonly domain = (process.env['CPANEL_DOMAIN'] || 'montao.net').toLowerCase();

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly cpanelEmailService: CpanelEmailService,
    private readonly mailCredentialService: MailCredentialService,
  ) {}

  async status(request: AuthenticatedRequest, mailboxEmail?: string) {
    const user = await this.currentUser(request);
    await this.ensureAutomaticMailbox(user);
    const mailboxes = await this.availableMailboxes(user);
    const auth = await this.resolveMailboxAuth(user, mailboxEmail, true);
    const status = auth
      ? await this.withImap(auth, async (client) => {
          const mailbox = await client.status('INBOX', { messages: true, unseen: true });
          return {
            messages: mailbox.messages || 0,
            unseen: mailbox.unseen || 0,
          };
        }).catch(() => ({ messages: 0, unseen: 0 }))
      : { messages: 0, unseen: 0 };

    return {
      configured: Boolean(auth),
      email: auth?.email || '',
      selectedMailboxEmail: auth?.email || '',
      mailboxes: mailboxes.map((mailbox) => this.publicMailboxOption(mailbox)),
      domain: this.domain,
      imapHost: this.imapHost(),
      smtpHost: this.smtpHost(),
      ...status,
    };
  }

  async configure(request: AuthenticatedRequest, body: { email?: string; password?: string }) {
    const user = await this.currentUser(request);
    const cleanEmail = this.cleanMailboxEmail(body.email || this.mailEmail(user));
    const password = String(body.password || '');

    if (!password) {
      throw new BadRequestException('La contrasena del buzon es requerida');
    }

    await this.verifyMailbox(cleanEmail, password);

    user.mailEmail = cleanEmail;
    user.mailPasswordEncrypted = this.mailCredentialService.encrypt(password);
    await user.save();
    await this.refreshDelegatedMailboxAccesses(cleanEmail, user.mailPasswordEncrypted, user.name);

    return this.status(request, cleanEmail);
  }

  async listMessages(request: AuthenticatedRequest, query: MailboxQuery) {
    const box = this.cleanBox(query.box);
    const limit = this.cleanLimit(query.limit);
    const auth = await this.resolveMailboxAuth(await this.currentUser(request), query.mailboxEmail);

    return this.withImap(auth, async (client) => {
      const lock = await client.getMailboxLock(box);

      try {
        const exists = client.mailbox ? client.mailbox.exists : 0;
        const start = Math.max(1, exists - limit + 1);
        const range = exists > 0 ? `${start}:*` : '';
        const messages: ReturnType<typeof this.serializeMessageSummary>[] = [];

        if (range) {
          for await (const message of client.fetch(
            range,
            {
              uid: true,
              envelope: true,
              flags: true,
              internalDate: true,
              size: true,
            },
            { uid: false },
          )) {
            messages.push(this.serializeMessageSummary(message));
          }
        }

        return {
          box,
          mailboxEmail: auth.email,
          total: exists,
          messages: messages.reverse(),
        };
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(request: AuthenticatedRequest, uid: string, box?: string, mailboxEmail?: string) {
    const cleanUid = this.cleanUid(uid);
    const cleanBox = this.cleanBox(box);
    const auth = await this.resolveMailboxAuth(await this.currentUser(request), mailboxEmail);

    return this.withImap(auth, async (client) => {
      const lock = await client.getMailboxLock(cleanBox);

      try {
        const message = await client.fetchOne(
          cleanUid.toString(),
          {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            size: true,
            source: true,
          },
          { uid: true },
        );

        if (!message) {
          throw new NotFoundException('Correo no encontrado');
        }

        const parsed = message.source ? await simpleParser(message.source) : null;
        return {
          ...this.serializeMessageSummary(message),
          mailboxEmail: auth.email,
          to: this.parsedAddressList(parsed?.to, message.envelope?.to || []),
          cc: this.parsedAddressList(parsed?.cc, message.envelope?.cc || []),
          bcc: this.parsedAddressList(parsed?.bcc, message.envelope?.bcc || []),
          text: parsed?.text || '',
          html: typeof parsed?.html === 'string' ? parsed.html : '',
          attachments:
            parsed?.attachments.map((attachment) => ({
              filename: attachment.filename || 'adjunto',
              contentType: attachment.contentType,
              size: attachment.size,
            })) || [],
        };
      } finally {
        lock.release();
      }
    });
  }

  async markRead(request: AuthenticatedRequest, uid: string, box?: string, mailboxEmail?: string) {
    const cleanUid = this.cleanUid(uid);
    const cleanBox = this.cleanBox(box);
    const auth = await this.resolveMailboxAuth(await this.currentUser(request), mailboxEmail);

    return this.withImap(auth, async (client) => {
      const lock = await client.getMailboxLock(cleanBox);

      try {
        await client.messageFlagsAdd(cleanUid.toString(), ['\\Seen'], { uid: true });
        return { ok: true };
      } finally {
        lock.release();
      }
    });
  }

  async updateReadState(
    request: AuthenticatedRequest,
    uid: string,
    read: boolean,
    box?: string,
    mailboxEmail?: string,
  ) {
    const cleanUid = this.cleanUid(uid);
    const cleanBox = this.cleanBox(box);
    const auth = await this.resolveMailboxAuth(await this.currentUser(request), mailboxEmail);

    return this.withImap(auth, async (client) => {
      const lock = await client.getMailboxLock(cleanBox);

      try {
        if (read) {
          await client.messageFlagsAdd(cleanUid.toString(), ['\\Seen'], { uid: true });
        } else {
          await client.messageFlagsRemove(cleanUid.toString(), ['\\Seen'], { uid: true });
        }

        return { ok: true };
      } finally {
        lock.release();
      }
    });
  }

  async moveMessage(
    request: AuthenticatedRequest,
    uid: string,
    targetBox: unknown,
    box?: string,
    mailboxEmail?: string,
  ) {
    const cleanUid = this.cleanUid(uid);
    const cleanBox = this.cleanBox(box);
    const cleanTargetBox = this.cleanBox(targetBox);

    if (cleanTargetBox === cleanBox) {
      return { ok: true };
    }

    const auth = await this.resolveMailboxAuth(await this.currentUser(request), mailboxEmail);

    return this.withImap(auth, async (client) => {
      const lock = await client.getMailboxLock(cleanBox);

      try {
        await client.mailboxCreate(cleanTargetBox).catch(() => undefined);
        await client.messageMove(cleanUid.toString(), cleanTargetBox, { uid: true });
        return { ok: true };
      } finally {
        lock.release();
      }
    });
  }

  async send(
    request: AuthenticatedRequest,
    body: SendMailBody,
    files: MailUploadFile[] = [],
  ) {
    const user = await this.currentUser(request);
    const auth = await this.resolveMailboxAuth(user, body.mailboxEmail);
    const to = this.cleanRecipients(body.to);
    const cc = this.cleanRecipients(body.cc);
    const bcc = this.cleanRecipients(body.bcc);
    const subject = String(body.subject || '').trim();
    const text = String(body.text || '').trim();
    const html = String(body.html || '').trim();
    const attachments = this.cleanOutgoingAttachments(files);

    if (!to.length) {
      throw new BadRequestException('Agrega al menos un destinatario');
    }

    if (!subject && !text && !html && !attachments.length) {
      throw new BadRequestException('Escribe un asunto o mensaje');
    }

    const transporter = nodemailer.createTransport({
      host: this.smtpHost(),
      port: this.smtpPort(),
      secure: this.smtpSecure(),
      auth: {
        user: auth.email,
        pass: auth.password,
      },
    });

    await transporter
      .sendMail({
        from: `${auth.displayName || auth.email} <${auth.email}>`,
        to,
        cc,
        bcc,
        subject,
        text: text || undefined,
        html: html || undefined,
        attachments: attachments.length ? attachments : undefined,
      })
      .catch((error: Error) => {
        throw new ServiceUnavailableException(`No se pudo enviar el correo: ${error.message}`);
      });

    return { ok: true };
  }

  private async currentUser(request: AuthenticatedRequest): Promise<UserDocument> {
    const user = await this.userModel.findById(request.user.sub);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return user;
  }

  private async verifyMailbox(email: string, password: string): Promise<void> {
    const client = this.createImapClient(email, password, true);

    await client.connect().catch((error: unknown) => {
      throw new BadRequestException(this.mailboxConnectErrorMessage('validar', error));
    });
  }

  private async withImap<T>(auth: MailboxAuth, callback: (client: ImapFlow) => Promise<T>) {
    const client = this.createImapClient(auth.email, auth.password);

    await client.connect().catch((error: unknown) => {
      throw new ServiceUnavailableException(this.mailboxConnectErrorMessage('conectar', error));
    });

    try {
      return await callback(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async resolveMailboxAuth(
    user: UserDocument,
    requestedEmail?: unknown,
  ): Promise<MailboxAuth>;
  private async resolveMailboxAuth(
    user: UserDocument,
    requestedEmail: unknown,
    optional: true,
  ): Promise<MailboxAuth | null>;
  private async resolveMailboxAuth(
    user: UserDocument,
    requestedEmail?: unknown,
    optional = false,
  ): Promise<MailboxAuth | null> {
    const requested = this.mailCredentialService.normalizeEmail(requestedEmail);
    await this.ensureAutomaticMailbox(user);
    const mailboxes = await this.availableMailboxes(user);
    const selected = requested
      ? mailboxes.find((mailbox) => mailbox.email === requested)
      : mailboxes[0];

    if (!selected) {
      if (optional && !requested) {
        return null;
      }

      if (requested) {
        throw new ForbiddenException('No tienes acceso a este buzon');
      }

      throw new BadRequestException('No hay buzon de correo disponible para este usuario');
    }

    const mailboxPasswordEncrypted = selected.own
      ? user.mailPasswordEncrypted
      : selected.mailPasswordEncrypted ||
        (await this.findMailboxUser(selected.email))?.mailPasswordEncrypted;

    if (!mailboxPasswordEncrypted) {
      throw new BadRequestException(`El buzon ${selected.email} no tiene credenciales de correo guardadas`);
    }

    return {
      email: selected.email,
      displayName: selected.label,
      delegated: selected.delegated,
      password: this.mailCredentialService.decrypt(mailboxPasswordEncrypted),
    };
  }

  private async availableMailboxes(user: UserDocument): Promise<ResolvedMailboxOption[]> {
    const mailboxes: ResolvedMailboxOption[] = [];
    const ownEmail = this.mailEmail(user);

    if (ownEmail && user.mailPasswordEncrypted) {
      mailboxes.push({
        email: ownEmail,
        label: user.name || ownEmail,
        own: true,
        delegated: false,
        mailPasswordEncrypted: user.mailPasswordEncrypted,
      });
    }

    for (const delegatedAccess of this.cleanDelegatedMailboxAccesses(user.delegatedMailboxAccesses)) {
      if (
        delegatedAccess.email === ownEmail ||
        mailboxes.some((mailbox) => mailbox.email === delegatedAccess.email)
      ) {
        continue;
      }

      mailboxes.push({
        email: delegatedAccess.email,
        label: delegatedAccess.label || delegatedAccess.email,
        own: false,
        delegated: true,
        mailPasswordEncrypted: delegatedAccess.mailPasswordEncrypted,
      });
    }

    for (const delegatedEmail of this.cleanDelegatedMailboxEmails(user.delegatedMailboxes)) {
      if (delegatedEmail === ownEmail || mailboxes.some((mailbox) => mailbox.email === delegatedEmail)) {
        continue;
      }

      const mailboxUser = await this.findMailboxUser(delegatedEmail);
      if (mailboxUser) {
        await this.ensureAutomaticMailbox(mailboxUser);
      }

      if (!mailboxUser?.mailPasswordEncrypted) {
        continue;
      }

      mailboxes.push({
        email: this.mailEmail(mailboxUser) || delegatedEmail,
        label: mailboxUser.name || delegatedEmail,
        own: false,
        delegated: true,
        mailPasswordEncrypted: mailboxUser.mailPasswordEncrypted,
      });
    }

    return mailboxes;
  }

  private publicMailboxOption(mailbox: ResolvedMailboxOption): MailboxOption {
    return {
      email: mailbox.email,
      label: mailbox.label,
      own: mailbox.own,
      delegated: mailbox.delegated,
    };
  }

  private async findMailboxUser(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({
      $or: [{ email }, { mailEmail: email }],
    });
  }

  private mailEmail(user: UserDocument): string {
    const configuredEmail = this.mailCredentialService.normalizeEmail(user.mailEmail);
    if (configuredEmail) {
      return configuredEmail;
    }

    const loginEmail = this.mailCredentialService.normalizeEmail(user.email);
    return this.mailCredentialService.isManagedEmail(loginEmail) ? loginEmail : '';
  }

  private async ensureAutomaticMailbox(user: UserDocument): Promise<void> {
    const email = this.mailEmail(user);

    if (!email || user.mailPasswordEncrypted || !this.mailCredentialService.isManagedEmail(email)) {
      return;
    }

    const password = this.mailCredentialService.generateMailboxPassword();
    await this.cpanelEmailService.ensureEmailAccount(email, password, {
      updatePasswordIfExists: true,
    });

    user.mailEmail = email;
    user.mailPasswordEncrypted = this.mailCredentialService.encrypt(password);
    await user.save();
    await this.refreshDelegatedMailboxAccesses(email, user.mailPasswordEncrypted, user.name);
  }

  private createImapClient(email: string, password: string, verifyOnly = false): ImapFlow {
    return new ImapFlow({
      host: this.imapHost(),
      port: this.imapPort(),
      secure: this.imapSecure(),
      auth: {
        user: email,
        pass: password,
      },
      verifyOnly,
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
  }

  private serializeMessageSummary(message: FetchMessageObject) {
    const flags = Array.from(message.flags || []);

    return {
      uid: message.uid,
      subject: message.envelope?.subject || '(Sin asunto)',
      from: this.addressList(message.envelope?.from || []),
      date: this.messageDate(message),
      unread: !flags.includes('\\Seen'),
      flagged: flags.includes('\\Flagged'),
      size: message.size || 0,
    };
  }

  private addressList(addresses: Array<{ name?: string; address?: string }>) {
    return addresses
      .map((address) => ({
        name: String(address.name || '').trim(),
        address: String(address.address || '').trim(),
      }))
      .filter((address) => address.address);
  }

  private parsedAddressList(
    value: unknown,
    fallback: Array<{ name?: string; address?: string }>,
  ) {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const parsedAddresses = values.flatMap((item) => {
      if (item && typeof item === 'object' && 'value' in item) {
        return (item as { value?: Array<{ name?: string; address?: string }> }).value || [];
      }

      return [];
    });

    return this.addressList(parsedAddresses.length ? parsedAddresses : fallback);
  }

  private messageDate(message: FetchMessageObject): string | null {
    const date = message.internalDate || message.envelope?.date;

    if (!date) {
      return null;
    }

    const parsedDate = date instanceof Date ? date : new Date(date);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
  }

  private cleanMailboxEmail(value: unknown): string {
    const email = this.mailCredentialService.normalizeEmail(value);

    if (!email.includes('@')) {
      throw new BadRequestException('El correo del buzon no es valido');
    }

    if (!this.mailCredentialService.isManagedEmail(email)) {
      throw new BadRequestException(`Solo se permiten buzones @${this.domain}`);
    }

    return email;
  }

  private cleanBox(value: unknown): string {
    const box = String(value || 'INBOX').trim();
    return box && !box.includes('..') ? box : 'INBOX';
  }

  private cleanLimit(value: unknown): number {
    const limit = Number(value || 30);
    return Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 30;
  }

  private cleanUid(value: string): number {
    const uid = Number(value);

    if (!Number.isInteger(uid) || uid <= 0) {
      throw new BadRequestException('Correo invalido');
    }

    return uid;
  }

  private cleanRecipients(value: unknown): string[] {
    return String(value || '')
      .split(/[,\n;]/)
      .map((recipient) => recipient.trim())
      .filter(Boolean);
  }

  private cleanOutgoingAttachments(files: MailUploadFile[]) {
    return files
      .filter((file) => file?.buffer?.length)
      .map((file) => ({
        filename: this.cleanAttachmentFilename(file.originalname),
        content: file.buffer as Buffer,
        contentType: file.mimetype || undefined,
      }));
  }

  private cleanAttachmentFilename(value: unknown): string {
    const filename = String(value || 'adjunto')
      .replace(/[\\/:*?"<>|]/g, '-')
      .trim();

    return filename || 'adjunto';
  }

  private cleanDelegatedMailboxEmails(value: unknown): string[] {
    const entries = Array.isArray(value) ? value : [];
    return Array.from(
      new Set(
        entries
          .map((entry) => {
            if (entry && typeof entry === 'object' && 'email' in entry) {
              return this.mailCredentialService.normalizeEmail(
                (entry as { email?: unknown }).email,
              );
            }

            return this.mailCredentialService.normalizeEmail(entry);
          })
          .filter(Boolean),
      ),
    );
  }

  private cleanDelegatedMailboxAccesses(value: unknown): DelegatedMailboxAccess[] {
    const entries = Array.isArray(value) ? value : [];
    const accesses: DelegatedMailboxAccess[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const access = entry as Partial<DelegatedMailboxAccess>;
      const email = this.mailCredentialService.normalizeEmail(access.email);
      const mailPasswordEncrypted = String(access.mailPasswordEncrypted || '').trim();

      if (!email || !mailPasswordEncrypted || seen.has(email)) {
        continue;
      }

      seen.add(email);
      accesses.push({
        email,
        mailPasswordEncrypted,
        label: String(access.label || '').trim() || email,
      });
    }

    return accesses;
  }

  private async refreshDelegatedMailboxAccesses(
    email: string,
    mailPasswordEncrypted: string,
    label?: string,
  ): Promise<void> {
    const cleanEmail = this.mailCredentialService.normalizeEmail(email);

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
      const delegatedMailboxes = this.cleanDelegatedMailboxEmails([
        ...(delegateUser.delegatedMailboxes || []),
        ...(delegateUser.delegatedMailboxAccesses || []),
      ]);
      const nextAccesses = this.cleanDelegatedMailboxAccesses(
        delegateUser.delegatedMailboxAccesses,
      ).filter((access) => access.email !== cleanEmail);

      nextAccesses.push({
        email: cleanEmail,
        mailPasswordEncrypted,
        label: label || cleanEmail,
      });

      delegateUser.delegatedMailboxes = delegatedMailboxes.includes(cleanEmail)
        ? delegatedMailboxes
        : [...delegatedMailboxes, cleanEmail];
      delegateUser.delegatedMailboxAccesses = nextAccesses;
      await delegateUser.save();
    }
  }

  private imapHost(): string {
    return process.env['MAIL_IMAP_HOST'] || process.env['CPANEL_HOST'] || `mail.${this.domain}`;
  }

  private imapPort(): number {
    return Number(process.env['MAIL_IMAP_PORT'] || 993);
  }

  private imapSecure(): boolean {
    return process.env['MAIL_IMAP_SECURE'] !== 'false';
  }

  private smtpHost(): string {
    return process.env['MAIL_SMTP_HOST'] || process.env['CPANEL_HOST'] || `mail.${this.domain}`;
  }

  private smtpPort(): number {
    return Number(process.env['MAIL_SMTP_PORT'] || 465);
  }

  private smtpSecure(): boolean {
    return process.env['MAIL_SMTP_SECURE'] !== 'false';
  }

  private mailboxConnectErrorMessage(action: string, error: unknown): string {
    return `No se pudo ${action} el buzon en ${this.imapHost()}:${this.imapPort()}: ${this.mailErrorDetails(error)}`;
  }

  private mailErrorDetails(error: unknown): string {
    const message = this.errorMessage(error);
    const combined = [
      message,
      this.errorField(error, 'code'),
      this.errorField(error, 'response'),
      this.errorField(error, 'responseText'),
      this.errorField(error, 'serverResponse'),
    ]
      .join(' ')
      .toLowerCase();

    if (
      combined.includes('auth') ||
      combined.includes('login') ||
      combined.includes('invalid') ||
      combined.includes('password') ||
      combined.includes('command failed')
    ) {
      return 'No se pudo autenticar. Revisa el correo y la contrasena del buzon.';
    }

    if (combined.includes('certificate') || combined.includes('hostname/ip') || combined.includes('altnames')) {
      return `El certificado SSL no coincide con el host. Usa ${this.imapHost()} como servidor IMAP.`;
    }

    if (
      combined.includes('timeout') ||
      combined.includes('etimedout') ||
      combined.includes('econnrefused') ||
      combined.includes('ehostunreach')
    ) {
      return 'No hubo conexion a tiempo. Si las credenciales son correctas, revisa bloqueo de IP o firewall en Banahosting.';
    }

    return `${message}. Si las credenciales son correctas, revisa bloqueo de IP o firewall en Banahosting.`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'Error desconocido');
  }

  private errorField(error: unknown, field: string): string {
    if (!error || typeof error !== 'object') {
      return '';
    }

    const value = (error as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  }
}
