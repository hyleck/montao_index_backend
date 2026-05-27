import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthenticatedRequest, AuthGuard } from './auth.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() body: { name?: string; email?: string; password?: string }) {
    return this.authService.register(body);
  }

  @Post('login')
  login(@Body() body: { email?: string; password?: string }) {
    return this.authService.login(body);
  }
}

@Controller('api/sso')
@UseGuards(AuthGuard)
export class SsoController {
  constructor(private readonly authService: AuthService) {}

  @Post('montao-gps')
  montaoGps(@Req() request: AuthenticatedRequest) {
    return this.authService.createMontaoGpsSso(request);
  }

  @Get('montao-gps/user-exists')
  montaoGpsUserExists(@Req() request: AuthenticatedRequest) {
    return this.authService.currentUserExistsInMontaoGps(request);
  }

  @Get('montao-rent/user-exists')
  montaoRentUserExists(@Req() request: AuthenticatedRequest) {
    return this.authService.currentUserExistsInMontaoRent(request);
  }
}
