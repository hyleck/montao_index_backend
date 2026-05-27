import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Controller('api/health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  health() {
    return {
      ok: true,
      database: this.connection.readyState === 1 ? 'connected' : 'pending',
    };
  }
}
