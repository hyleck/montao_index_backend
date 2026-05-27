# Montao Index Backend

NestJS API for Montao Index.

## Heroku

Required config vars:

```env
MONGODB_URI=
JWT_SECRET=
ADMIN_EMAIL=
ADMIN_PASSWORD=
MONTAO_GPS_API_URL=https://tracker-back.dorhu.com
MONTAO_GPS_FRONTEND_URL=https://tracker.montao.net
MONTAO_GPS_SSO_SECRET=
CORS_ORIGINS=https://index.montao.net,http://localhost:4201,http://127.0.0.1:4201
```

Heroku uses `Procfile` and runs:

```bash
npm run build
npm start
```
