import './env';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { AppsController } from './apps/apps.controller';
import { AppsService } from './apps/apps.service';
import { AuthController, SsoController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { HealthController } from './health/health.controller';
import { CompanyApp, CompanyAppSchema } from './schemas/company-app.schema';
import { User, UserSchema } from './schemas/user.schema';
import { StartupService } from './startup.service';

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
  controllers: [AppsController, AuthController, HealthController, SsoController],
  providers: [AppsService, AuthService, StartupService],
})
export class AppModule {}
