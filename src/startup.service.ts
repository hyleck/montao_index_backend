import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { Model } from 'mongoose';
import { CompanyApp } from './schemas/company-app.schema';
import { User } from './schemas/user.schema';

const defaultApps = [
  {
    name: 'Montao CRM',
    description: 'Gestion comercial, clientes, visitas, oportunidades y reportes de venta.',
    category: 'Ventas',
    group: 'Productividad',
    owner: 'Equipo Comercial',
    url: 'http://localhost:4200',
    status: 'Online',
    initials: 'CRM',
    icon: '▦',
    order: 1,
  },
  {
    name: 'Montao Rent',
    description: 'Contratos, vehiculos, mantenimientos, seguros y control de alquileres.',
    category: 'Operaciones',
    group: 'Operaciones',
    owner: 'Renta y Flota',
    url: 'http://localhost:4300',
    status: 'Revision',
    initials: 'MR',
    icon: '▣',
    order: 2,
  },
  {
    name: 'GPS Mobile',
    description: 'Instalaciones, inventario, rutas, vehiculos y seguimiento tecnico.',
    category: 'Tecnologia',
    group: 'Operaciones',
    owner: 'Soporte GPS',
    url: 'http://localhost:8100',
    status: 'Online',
    initials: 'GPS',
    icon: '⌁',
    order: 3,
  },
  {
    name: 'Montao Metricas',
    description: 'Panel ejecutivo para indicadores, visitas, ventas y rendimiento por gestor.',
    category: 'Analitica',
    group: 'Finanzas y Analitica',
    owner: 'Direccion',
    url: 'http://localhost:8080',
    status: 'Online',
    initials: 'MT',
    icon: '▥',
    order: 4,
  },
  {
    name: 'Facturacion INCOSIS',
    description: 'Facturas, comprobantes, clientes, productos y resumen financiero.',
    category: 'Finanzas',
    group: 'Finanzas y Analitica',
    owner: 'Administracion',
    url: 'http://localhost:4400',
    status: 'Interna',
    initials: 'FI',
    icon: '▤',
    order: 5,
  },
] as const;

@Injectable()
export class StartupService implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(CompanyApp.name) private readonly appModel: Model<CompanyApp>,
  ) {}

  async onModuleInit() {
    await this.prepareUsersCollection();
    await this.seedDatabase();
  }

  private async prepareUsersCollection() {
    await this.userModel.collection.dropIndex('username_1').catch(() => {});

    const legacyUsers = await this.userModel.collection
      .find({ email: { $exists: false } })
      .toArray();

    for (const legacyUser of legacyUsers) {
      const username = String(legacyUser['username'] || legacyUser._id).trim().toLowerCase();
      const email = username.includes('@') ? username : `${username}@montao.local`;
      await this.userModel.collection.updateOne({ _id: legacyUser._id }, { $set: { email } });
    }
  }

  private async seedDatabase() {
    const adminEmail = String(process.env['ADMIN_EMAIL'] || 'super_admin@montao.local')
      .trim()
      .toLowerCase();
    const adminPassword = process.env['ADMIN_PASSWORD'] || 'admin123';
    const admin = await this.userModel.findOne({ email: adminEmail });

    if (!admin) {
      await this.userModel.create({
        email: adminEmail,
        passwordHash: await bcrypt.hash(adminPassword, 12),
        name: 'Super Admin',
        role: 'admin',
      });
    }

    const appCount = await this.appModel.countDocuments();
    if (appCount === 0) {
      await this.appModel.insertMany(defaultApps);
    }
  }
}
