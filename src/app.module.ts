import './env';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { AppsController } from './apps/apps.controller';
import { AppsService } from './apps/apps.service';
import { AuthController, SsoController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CpanelEmailService } from './cpanel/cpanel-email.service';
import { HealthController } from './health/health.controller';
import { MailCredentialService } from './mailbox/mail-credential.service';
import { MailboxController } from './mailbox/mailbox.controller';
import { MailboxService } from './mailbox/mailbox.service';
import { CompanyApp, CompanyAppSchema } from './schemas/company-app.schema';
import { User, UserSchema } from './schemas/user.schema';
import { StartupService } from './startup.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => {
        if (!process.env['MONGODB_URI']) {
          throw new Error('MONGODB_URI no esta configurado');
        }

        return { uri: process.env['MONGODB_URI'] };
      },
    }),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: CompanyApp.name, schema: CompanyAppSchema },
    ]),
    JwtModule.register({
      secret: process.env['JWT_SECRET'] || 'montao_index_local_secret',
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [
    AppsController,
    AuthController,
    HealthController,
    MailboxController,
    SsoController,
    UsersController,
  ],
  providers: [
    AppsService,
    AuthService,
    CpanelEmailService,
    MailCredentialService,
    MailboxService,
    StartupService,
    UsersService,
  ],
})
export class AppModule {}
