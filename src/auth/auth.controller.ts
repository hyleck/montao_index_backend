import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
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

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: AuthenticatedRequest) {
    return this.authService.getMe(request);
  }

  @Patch('me')
  @UseGuards(AuthGuard)
  updateMe(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name?: string; email?: string; password?: string },
  ) {
    return this.authService.updateMe(request, body);
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

  @Post('montao-rent')
  montaoRent(@Req() request: AuthenticatedRequest) {
    return this.authService.createMontaoRentSso(request);
  }

  @Post('montao-crm')
  montaoCrm(@Req() request: AuthenticatedRequest) {
    return this.authService.createMontaoCrmSso(request);
  }

  @Get('montao-gps/user-exists')
  montaoGpsUserExists(@Req() request: AuthenticatedRequest) {
    return this.authService.currentUserExistsInMontaoGps(request);
  }

  @Get('montao-rent/user-exists')
  montaoRentUserExists(@Req() request: AuthenticatedRequest) {
    return this.authService.currentUserExistsInMontaoRent(request);
  }

  @Get('montao-crm/user-exists')
  montaoCrmUserExists(@Req() request: AuthenticatedRequest) {
    return this.authService.currentUserExistsInMontaoCrm(request);
  }
}
