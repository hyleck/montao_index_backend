import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest, AuthGuard } from '../auth/auth.guard';
import { UsersService } from './users.service';

@Controller('api/users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll(@Req() request: AuthenticatedRequest) {
    return this.usersService.findAll(request);
  }

  @Get('availability')
  availability(
    @Req() request: AuthenticatedRequest,
    @Query('username') username?: string,
    @Query('email') email?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.usersService.checkAvailability(request, { username, email, excludeId });
  }

  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name?: string; email?: string; password?: string; role?: string; delegatedMailboxes?: string[] },
  ) {
    return this.usersService.create(request, body);
  }

  @Patch(':id')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { name?: string; email?: string; password?: string; role?: string; delegatedMailboxes?: string[] },
  ) {
    return this.usersService.update(request, id, body);
  }

  @Delete(':id')
  remove(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.usersService.remove(request, id);
  }
}
