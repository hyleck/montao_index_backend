import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AppsService } from './apps.service';

@Controller('api/apps')
@UseGuards(AuthGuard)
export class AppsController {
  constructor(private readonly appsService: AppsService) {}

  @Get()
  findAll() {
    return this.appsService.findAll();
  }
}
