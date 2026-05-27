import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
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
}
