import 'reflect-metadata';
import './env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

function getCorsOrigins() {
  return (
    process.env['CORS_ORIGINS'] || 'http://localhost:4201,http://127.0.0.1:4201'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env['PORT'] || 3000);

  app.enableCors({
    origin: getCorsOrigins(),
  });

  await app.listen(port);
  console.log(`Montao Index API running on http://localhost:${port}`);
}

bootstrap().catch((error: unknown) => {
  console.error('No se pudo iniciar Montao Index API');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
